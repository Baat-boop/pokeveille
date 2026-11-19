#!/usr/bin/env python3
"""Bot Make More! — joue tout seul, directement sur le téléphone Android.

Tourne dans Termux et pilote le jeu par le débogage sans fil (ADB) :
il regarde l'écran (captures), tape sur la zone de production, achète les
améliorations quand leur bouton est disponible et ferme les fenêtres.

Aucune dépendance en dehors de Python 3 et de `adb` (paquet android-tools).

  python makemore_bot.py connecter   # appairage / connexion ADB (une fois)
  python makemore_bot.py regler      # montrer au bot où sont les boutons
  python makemore_bot.py jouer       # lancer le bot (Ctrl+C pour arrêter)
"""

import argparse
import json
import os
import random
import re
import subprocess
import sys
import threading
import time

ADB = os.environ.get("ADB", "adb")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "makemore_config.json")

# Fenêtres d'achat Google Play : le bot ne doit jamais rien y toucher.
PURCHASE_PACKAGES = ("com.android.vending",)
# Activités de pub lancées par le jeu (même paquet que le jeu).
AD_HINTS = ("adactivity", "adunit", "applovin", "ironsource", "vungle",
            "unity3d.ads", "fullscreenad", "interstitial", "rewarded",
            "mbridge", "chartboost", "facebook.ads", "inmobi", "fyber")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- ADB ----

class AdbError(RuntimeError):
    pass


def adb_raw(args, serial=None, timeout=30, binary=False):
    cmd = [ADB] + (["-s", serial] if serial else []) + list(args)
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise AdbError("adb introuvable. Dans Termux : pkg install android-tools")
    except subprocess.TimeoutExpired:
        raise AdbError("adb ne répond pas (%s)" % " ".join(args[:2]))
    if binary:
        return res.stdout
    return res.stdout.decode("utf-8", "replace") + res.stderr.decode("utf-8", "replace")


def list_devices():
    out = adb_raw(["devices"])
    return [line.split()[0] for line in out.splitlines()[1:]
            if line.strip().endswith("\tdevice") or re.search(r"\sdevice$", line)]


def try_mdns_connect():
    """Débogage sans fil : retrouve tout seul le port (il change à chaque fois)."""
    out = adb_raw(["mdns", "services"], timeout=10)
    for m in re.finditer(r"_adb-tls-connect\._tcp\.?\s+([\d.]+):(\d+)", out):
        res = adb_raw(["connect", "%s:%s" % (m.group(1), m.group(2))], timeout=10)
        if "connected" in res:
            return True
    return False


def find_device(interactive=True):
    devs = list_devices()
    if not devs:
        try_mdns_connect()
        devs = list_devices()
    if not devs and interactive:
        print("\nAucun appareil connecté.")
        print("Ouvre Options pour les développeurs > Débogage sans fil et lis")
        print("le port affiché sous « Adresse IP et port » (ex. 192.168.1.20:41237).")
        port = input("Port (juste les chiffres après les deux-points, vide = annuler) : ").strip()
        if port.isdigit():
            print(adb_raw(["connect", "localhost:" + port], timeout=15).strip())
            devs = list_devices()
    if not devs:
        raise AdbError("Pas de téléphone connecté. Lance d'abord : python makemore_bot.py connecter")
    return devs[0]


class Frame:
    """Capture d'écran brute (RGBA), lue sans aucune bibliothèque."""

    def __init__(self, raw):
        if len(raw) < 16:
            raise AdbError("capture d'écran vide (écran verrouillé ou adb coupé ?)")
        w, h, fmt = (int.from_bytes(raw[i:i + 4], "little") for i in (0, 4, 8))
        header = len(raw) - w * h * 4
        if w <= 0 or h <= 0 or header not in (12, 16):
            raise AdbError("format de capture inattendu (%dx%d, %d octets)" % (w, h, len(raw)))
        self.w, self.h = w, h
        self.bgr = fmt == 5  # BGRA_8888 sur certains appareils
        self.data = memoryview(raw)[header:]

    def pixel(self, x, y):
        i = (y * self.w + x) * 4
        r, g, b = self.data[i], self.data[i + 1], self.data[i + 2]
        return (b, g, r) if self.bgr else (r, g, b)

    def color(self, x, y, radius=3):
        """Couleur moyenne d'un petit carré (plus stable qu'un seul pixel)."""
        tot, n = [0, 0, 0], 0
        for yy in range(max(0, y - radius), min(self.h, y + radius + 1)):
            for xx in range(max(0, x - radius), min(self.w, x + radius + 1)):
                p = self.pixel(xx, yy)
                tot[0] += p[0]; tot[1] += p[1]; tot[2] += p[2]
                n += 1
        return [round(c / max(n, 1)) for c in tot]


def same_color(a, b, tol):
    return max(abs(a[i] - b[i]) for i in range(3)) <= tol


class Phone:
    def __init__(self, serial):
        self.serial = serial
        self._shell = None
        self._lock = threading.Lock()

    def sh(self, cmd, timeout=20):
        return adb_raw(["shell", cmd], self.serial, timeout)

    def screencap(self):
        return Frame(adb_raw(["exec-out", "screencap"], self.serial, 30, binary=True))

    def _persistent_shell(self):
        if self._shell is None or self._shell.poll() is not None:
            self._shell = subprocess.Popen(
                [ADB, "-s", self.serial, "shell"], stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        return self._shell

    def send(self, line):
        """Envoie une commande sans attendre (le `&` évite toute file d'attente)."""
        with self._lock:
            for _ in range(2):
                try:
                    sh = self._persistent_shell()
                    sh.stdin.write(line + " &\n")
                    sh.stdin.flush()
                    return
                except (BrokenPipeError, OSError):
                    self._shell = None

    def tap(self, x, y):
        self.send("input tap %d %d" % (x, y))

    def key(self, name):
        self.send("input keyevent " + name)

    def vibrate(self, ms=120):
        self.send("cmd vibrator_manager synced oneshot %d 2>/dev/null || cmd vibrator vibrate %d 2>/dev/null"
                  % (ms, ms))

    def focus(self):
        """(paquet, activité) de la fenêtre au premier plan."""
        out = self.sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", 10)
        m = re.search(r"mCurrentFocus=.*?\s([\w.]+)/([\w.$]+)", out) or \
            re.search(r"mFocusedApp=.*?\s([\w.]+)/([\w.$]+)", out)
        if not m:
            return "", ""
        act = m.group(2)
        return m.group(1), (m.group(1) + act if act.startswith(".") else act)

    def awake(self):
        out = self.sh("dumpsys power | grep -m1 mWakefulness=", 10)
        return "Awake" in out or not out.strip()

    def launch(self, package):
        self.sh("monkey -p %s -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1" % package, 20)

    def close(self):
        if self._shell and self._shell.poll() is None:
            try:
                self._shell.stdin.write("exit\n")
                self._shell.stdin.flush()
            except OSError:
                pass


# ------------------------------------------------- toucher (getevent) ----

class TouchReader:
    """Lit les vrais doigts sur l'écran. Les taps du bot (`input tap`) n'y
    apparaissent pas : tout ce qui arrive ici vient d'un humain."""

    def __init__(self, phone):
        self.phone = phone
        self.device, self.max_x, self.max_y = self._find_device()
        size = phone.sh("wm size")
        sizes = re.findall(r"(\d+)x(\d+)", size)
        if not sizes:
            raise AdbError("taille d'écran introuvable")
        self.pw, self.ph = map(int, sizes[-1])  # « Override size » si présent
        self.proc = None
        self.touches = []  # (instant du contact, x brut, y brut) du capteur
        self.last_touch = 0.0

    def _find_device(self):
        out = self.phone.sh("getevent -lp", 15)
        best, dev = None, None
        mx = my = None
        for line in out.splitlines():
            m = re.match(r"add device \d+: (\S+)", line)
            if m:
                if dev and mx and my and best is None:
                    best = (dev, mx, my)
                dev, mx, my = m.group(1), None, None
                continue
            m = re.search(r"ABS_MT_POSITION_([XY])\s*:.*?max (\d+)", line)
            if m:
                if m.group(1) == "X":
                    mx = int(m.group(2))
                else:
                    my = int(m.group(2))
        if best is None and dev and mx and my:
            best = (dev, mx, my)
        if best is None:
            raise AdbError("écran tactile introuvable via getevent")
        return best

    def rotation(self):
        out = self.phone.sh("dumpsys input | grep -m1 SurfaceOrientation", 10)
        m = re.search(r"SurfaceOrientation:\s*(\d)", out)
        return int(m.group(1)) if m else 0

    def to_screen(self, rx, ry, rot):
        nx = rx * self.pw / (self.max_x + 1)
        ny = ry * self.ph / (self.max_y + 1)
        pw, ph = self.pw, self.ph
        x, y = {0: (nx, ny), 1: (ny, pw - nx), 2: (pw - nx, ph - ny), 3: (ph - ny, nx)}[rot]
        return int(x), int(y)

    def start(self):
        self.proc = subprocess.Popen(
            [ADB, "-s", self.phone.serial, "shell", "getevent", "-l", self.device],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()
        return self

    def _read(self):
        down = None
        x = y = None
        for line in self.proc.stdout:
            parts = line.split()
            if len(parts) < 3:
                continue
            code, val = parts[-2], parts[-1]
            if code == "ABS_MT_TRACKING_ID":
                if val.lower() == "ffffffff":
                    down = None
                elif down is None:
                    down, x, y = time.time(), None, None
            elif code == "BTN_TOUCH" and val == "DOWN" and down is None:
                down, x, y = time.time(), None, None
            elif code == "BTN_TOUCH" and val == "UP":
                down = None
            elif code == "ABS_MT_POSITION_X":
                x = int(val, 16)
            elif code == "ABS_MT_POSITION_Y":
                y = int(val, 16)
            elif code == "SYN_REPORT" and down is not None and x is not None and y is not None:
                self.last_touch = time.time()
                if not self.touches or self.touches[-1][0] != down:
                    self.touches.append((down, x, y))

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


# ------------------------------------------------------------ réglage ----

KINDS = {
    "zone": "Zone à taper",
    "repere": "Repère de l'écran principal",
    "bouton": "Bouton à acheter quand il est dispo",
    "fermer": "Bouton « fermer » / « récupérer »",
}


def load_config(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"package": "", "tolerance": 28, "taps_per_second": 4, "burst_seconds": 2.5,
            "pause_on_touch_seconds": 20, "points": []}


def save_config(cfg, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print("Enregistré dans", path)


def capture_touch(phone, wait=40):
    """Attend que l'utilisateur touche l'écran dans le jeu ; renvoie la position
    et la couleur sous le doigt telle qu'elle était juste AVANT le toucher."""
    reader = TouchReader(phone).start()
    frames = []  # (début de capture, Frame)
    stop = threading.Event()

    def grab():
        while not stop.is_set():
            t0 = time.time()
            try:
                frames.append((t0, phone.screencap()))
            except AdbError:
                time.sleep(0.5)
            del frames[:-4]

    threading.Thread(target=grab, daemon=True).start()
    deadline = time.time() + wait
    try:
        while time.time() < deadline and not reader.touches:
            time.sleep(0.05)
        if not reader.touches:
            return None
        t, rx, ry = reader.touches[0]
        x, y = reader.to_screen(rx, ry, reader.rotation())
        while not any(ft < t - 0.05 for ft, _ in frames) and time.time() < deadline + 5:
            time.sleep(0.05)
        before = [f for ft, f in frames if ft < t - 0.05]
        if not before:
            return None
        frame = before[-1]
        x, y = min(max(x, 0), frame.w - 1), min(max(y, 0), frame.h - 1)
        return x, y, frame.color(x, y), phone.focus()[0]
    finally:
        stop.set()
        reader.stop()


def describe(p):
    extra = ""
    if p["kind"] == "bouton":
        extra = ", toutes les %ss max" % p.get("every", 3)
    return "%-11s %-24s (%d, %d)%s" % (p["kind"], p.get("name", ""), p["x"], p["y"], extra)


def check_now(phone, cfg):
    print("Ouvre le jeu dans les 8 secondes…")
    time.sleep(8)
    frame = phone.screencap()
    phone.vibrate()
    tol = cfg.get("tolerance", 28)
    print("\nCe que le bot reconnaît sur l'écran (%dx%d) :" % (frame.w, frame.h))
    for p in cfg["points"]:
        if p["kind"] == "zone":
            continue
        now = frame.color(p["x"], p["y"])
        ok = same_color(now, p["rgb"], tol)
        print("  %s %s — couleur %s, attendue %s" % ("OUI" if ok else "non", describe(p), now, p["rgb"]))


def cmd_regler(args):
    phone = Phone(find_device())
    cfg = load_config(args.config)
    print("Téléphone :", phone.serial)
    menu = [("1", "zone"), ("2", "repere"), ("3", "bouton"), ("4", "fermer")]
    while True:
        print("\n=== Réglage du bot Make More! ===")
        print("Jeu :", cfg["package"] or "(pas encore détecté)")
        for i, p in enumerate(cfg["points"], 1):
            print("  %2d. %s" % (i, describe(p)))
        print("\n 1. Ajouter une zone à taper (là où on tape pour produire)")
        print(" 2. Ajouter le repère de l'écran principal (OBLIGATOIRE)")
        print(" 3. Ajouter un bouton à acheter quand il est dispo (améliorer, embaucher…)")
        print(" 4. Ajouter un bouton « fermer » / « récupérer » d'une fenêtre")
        print(" 5. Supprimer un point")
        print(" 6. Tester : voir ce que le bot reconnaît maintenant")
        print(" 0. Enregistrer et quitter")
        choice = input("> ").strip()
        if choice == "0":
            save_config(cfg, args.config)
            return
        if choice == "5":
            n = input("Numéro du point à supprimer : ").strip()
            if n.isdigit() and 1 <= int(n) <= len(cfg["points"]):
                print("Supprimé :", describe(cfg["points"].pop(int(n) - 1)))
            continue
        if choice == "6":
            check_now(phone, cfg)
            continue
        kind = dict(menu).get(choice)
        if not kind:
            continue
        point = {"kind": kind}
        if kind in ("bouton", "fermer"):
            point["name"] = input("Nom (ex. « embaucher », « fermer pub ») : ").strip() or kind
        if kind == "bouton":
            e = input("Le presser au plus toutes les combien de secondes ? [3] : ").strip()
            point["every"] = float(e.replace(",", ".")) if re.match(r"^\d+([.,]\d+)?$", e) else 3
        print({
            "zone": "Va dans le jeu et touche l'endroit où il faut taper pour produire.",
            "repere": "Va dans le jeu, sur l'écran principal, et touche un élément FIXE qui ne\n"
                      "bouge jamais et qui ne fait rien (ex. l'icône de pièce à côté de ton argent).\n"
                      "Le bot ne tape que quand il voit ce repère : c'est sa sécurité.",
            "bouton": "Va dans le jeu et touche le bouton PENDANT qu'il est disponible\n"
                      "(de la bonne couleur, assez d'argent). Le bot l'achètera à chaque\n"
                      "fois qu'il le reverra de cette couleur. (Ton toucher l'achète aussi.)",
            "fermer": "Fais apparaître la fenêtre, puis va dans le jeu et touche son bouton\n"
                      "« fermer » ou « récupérer ».",
        }[kind])
        print("Tu as 40 secondes. Le téléphone vibre quand c'est enregistré.")
        got = capture_touch(phone)
        if not got:
            print("Rien reçu, recommence.")
            continue
        x, y, rgb, pkg = got
        phone.vibrate()
        point.update(x=x, y=y, rgb=rgb)
        cfg["points"].append(point)
        if pkg and pkg != "com.termux" and not cfg["package"]:
            cfg["package"] = pkg
            print("Jeu détecté :", pkg)
        print("OK :", describe(point), "couleur", rgb)
        save_config(cfg, args.config)


# -------------------------------------------------------------- jouer ----

class Bot:
    def __init__(self, phone, cfg, minutes=None):
        self.phone, self.cfg = phone, cfg
        pts = cfg["points"]
        self.zones = [p for p in pts if p["kind"] == "zone"]
        self.marks = [p for p in pts if p["kind"] == "repere"]
        self.buttons = [p for p in pts if p["kind"] == "bouton"]
        self.closers = [p for p in pts if p["kind"] == "fermer"]
        self.tol = cfg.get("tolerance", 28)
        self.tps = max(0.5, float(cfg.get("taps_per_second", 4)))
        self.burst = float(cfg.get("burst_seconds", 2.5))
        self.pause_touch = float(cfg.get("pause_on_touch_seconds", 20))
        self.end = time.time() + minutes * 60 if minutes else None
        self.stats = {"taps": 0, "achats": 0, "fermés": 0, "retours": 0, "relances": 0, "achats bloqués": 0}
        self.last_bought = {}
        self.miss_since = None
        self.last_back = 0.0
        self.ad_since = None
        self.reader = None

    def check(self):
        missing = []
        if not self.cfg.get("package"):
            missing.append("le jeu n'a pas été détecté")
        if not self.marks:
            missing.append("aucun repère de l'écran principal (option 2)")
        if not (self.zones or self.buttons):
            missing.append("ni zone à taper ni bouton à acheter")
        if missing:
            raise SystemExit("Réglage incomplet : " + " ; ".join(missing) +
                             "\nLance : python makemore_bot.py regler")

    def matches(self, frame, p):
        return same_color(frame.color(p["x"], p["y"]), p["rgb"], self.tol)

    def tap(self, x, y, jitter=0):
        if jitter:
            x += random.randint(-jitter, jitter)
            y += random.randint(-jitter, jitter)
        self.phone.tap(x, y)
        self.stats["taps"] += 1

    def human_active(self):
        return self.reader and time.time() - self.reader.last_touch < self.pause_touch

    def guard_foreground(self):
        """Vérifie qu'on est bien dans le jeu. Renvoie True si on peut jouer."""
        pkg_game = self.cfg["package"]
        if not self.phone.awake():
            log("Écran éteint : je le rallume.")
            self.phone.key("KEYCODE_WAKEUP")
            time.sleep(2)
            return False
        pkg, act = self.phone.focus()
        low = act.lower()
        if pkg in PURCHASE_PACKAGES or "billing" in low or "purchase" in low:
            self.stats["achats bloqués"] += 1
            log("Fenêtre d'achat ouverte : retour, je n'achète rien avec de l'argent réel.")
            self.phone.key("KEYCODE_BACK")
            time.sleep(2)
            return False
        if pkg == pkg_game and any(h in low for h in AD_HINTS):
            self.ad_since = self.ad_since or time.time()
            if time.time() - self.ad_since > 40 and time.time() - self.last_back > 6:
                log("Pub qui traîne : retour.")
                self.phone.key("KEYCODE_BACK")
                self.last_back = time.time()
            return "pub"
        self.ad_since = None
        if pkg != pkg_game:
            if pkg in ("", "com.android.systemui"):
                return True  # volet de notifications, transition… on laisse filer
            self.stats["relances"] += 1
            log("Le jeu n'est plus au premier plan (%s) : je le relance." % (pkg or "?"))
            self.phone.launch(pkg_game)
            time.sleep(5)
            return False
        return True

    def report(self):
        log(" | ".join("%s %d" % kv for kv in self.stats.items()))

    def run(self):
        self.check()
        try:
            self.reader = TouchReader(self.phone).start()
        except AdbError as e:
            log("Détection de tes doigts indisponible (%s) : pas de pause auto." % e)
        log("Bot lancé sur %s. Ctrl+C pour arrêter. Touche l'écran pour le mettre "
            "en pause %ds." % (self.cfg["package"], self.pause_touch))
        last_guard = 0.0
        last_report = time.time()
        paused_msg = False
        while not self.end or time.time() < self.end:
            now = time.time()
            if now - last_report > 60:
                self.report()
                last_report = now
            if self.human_active():
                if not paused_msg:
                    log("Tu joues : pause.")
                    paused_msg = True
                time.sleep(0.5)
                continue
            if paused_msg:
                log("Reprise.")
                paused_msg = False
            if now - last_guard > 4:
                state = self.guard_foreground()
                last_guard = time.time()
                if state is False:
                    last_guard = 0
                    continue
                if state == "pub":
                    time.sleep(2)
                    continue
            try:
                frame = self.phone.screencap()
            except AdbError as e:
                log("Capture impossible : %s" % e)
                time.sleep(3)
                continue
            if self.human_active():
                continue
            self.step(frame)
        self.report()

    def step(self, frame):
        closer = next((p for p in self.closers if self.matches(frame, p)), None)
        if closer:
            log("Fenêtre : « %s »." % closer["name"])
            self.tap(closer["x"], closer["y"])
            self.stats["fermés"] += 1
            time.sleep(1.2)
            return
        if not any(self.matches(frame, p) for p in self.marks):
            self.miss_since = self.miss_since or time.time()
            lost = time.time() - self.miss_since
            if lost > 3 and time.time() - self.last_back > 6:
                log("Écran inconnu depuis %ds : retour." % lost)
                self.phone.key("KEYCODE_BACK")
                self.stats["retours"] += 1
                self.last_back = time.time()
            if lost > 120:
                log("Perdu depuis 2 min : je relance le jeu.")
                self.phone.sh("am force-stop " + self.cfg["package"])
                self.phone.launch(self.cfg["package"])
                self.stats["relances"] += 1
                self.miss_since = time.time()
                time.sleep(10)
            time.sleep(0.7)
            return
        self.miss_since = None
        for b in self.buttons:
            key = (b["x"], b["y"])
            if time.time() - self.last_bought.get(key, 0) >= b.get("every", 3) and self.matches(frame, b):
                self.tap(b["x"], b["y"])
                self.last_bought[key] = time.time()
                self.stats["achats"] += 1
                log("Achat : %s." % b["name"])
                time.sleep(0.6)
                return  # l'écran a pu changer : nouvelle capture avant d'agir encore
        if self.zones:
            end = time.time() + self.burst
            while time.time() < end and not self.human_active():
                z = random.choice(self.zones)
                self.tap(z["x"], z["y"], jitter=12)
                time.sleep(1 / self.tps)
        else:
            time.sleep(1)


def cmd_jouer(args):
    cfg = load_config(args.config)
    phone = Phone(find_device())
    bot = Bot(phone, cfg, args.minutes)
    try:
        bot.run()
    except KeyboardInterrupt:
        print()
        bot.report()
        log("Arrêté.")
    finally:
        if bot.reader:
            bot.reader.stop()
        phone.close()


def cmd_connecter(args):
    devs = list_devices()
    if devs:
        print("Déjà connecté :", ", ".join(devs))
        return
    if try_mdns_connect():
        print("Connecté :", ", ".join(list_devices()))
        return
    print("""
Appairage (une seule fois) :
 1. Paramètres > À propos du téléphone > touche 7 fois « Numéro de build »
    pour activer les Options pour les développeurs.
 2. Options pour les développeurs > active « Débogage sans fil » (Wi-Fi allumé).
 3. Mets Termux et les Paramètres en écran partagé, puis dans Débogage sans fil :
    « Associer l'appareil avec un code d'association ».
""")
    port = input("Port affiché dans la fenêtre d'association (après les deux-points) : ").strip()
    code = input("Code d'association à 6 chiffres : ").strip()
    print(adb_raw(["pair", "localhost:" + port, code], timeout=30).strip())
    time.sleep(1)
    try:
        print("Connecté :", find_device())
    except AdbError as e:
        print(e)


def main():
    ap = argparse.ArgumentParser(description="Bot qui joue tout seul à Make More!")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="fichier de réglages")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("connecter", help="appairer / connecter ADB sans fil")
    sub.add_parser("regler", help="montrer au bot où sont les boutons")
    j = sub.add_parser("jouer", help="lancer le bot")
    j.add_argument("--minutes", type=float, help="s'arrêter tout seul après N minutes")
    args = ap.parse_args()
    handlers = {"connecter": cmd_connecter, "regler": cmd_regler, "jouer": cmd_jouer}
    if args.cmd not in handlers:
        ap.print_help()
        return
    try:
        handlers[args.cmd](args)
    except AdbError as e:
        sys.exit("Erreur : %s" % e)
    except (KeyboardInterrupt, EOFError):
        print()


if __name__ == "__main__":
    main()
