/* Traque — chasse à l'homme grandeur nature entre potes.
 *
 * Pas de serveur à nous : les téléphones se parlent via un relais MQTT public
 * (gratuit, sans compte). Tout ce qui transite est chiffré (AES-GCM) avec une
 * clé tirée du code de la partie : le relais ne voit que du charabia.
 *
 * Les fugitifs n'envoient JAMAIS leur position en continu : seulement au moment
 * d'une révélation, d'un radar, d'une sortie de zone ou à la fin de la partie.
 */

/* global mqtt, L, qrcode */

const qs = new URLSearchParams(location.search);
const BROKERS = qs.get('broker')
  ? [qs.get('broker')]
  : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'];
// ?fast=1 : une « minute » dure une seconde (tests uniquement).
const MIN = qs.get('fast') ? 1000 : 60000;
const NS = 'traque/v1/';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_RULES = {
  duration: 60, headStart: 5, interval: 5, pings: 2,
  caughtBecomesHunter: false, fugitivesSeeHunters: false, zone: null,
  shrink: 30,       // la zone rétrécit jusqu'à 30 % de son rayon (0 = jamais)
  shrinkEvery: 10,  // une étape de rétrécissement toutes les 10 min
  fuzzy: 200,       // fugitifs montrés dans un cercle de 200 m (0 = position exacte)
  fuzzShrink: 50,   // cercle trouvé par un chasseur : il garde 50 % de son rayon
  fuzzMin: 40,      // … sans descendre sous 40 m
  nearAlert: 100,   // fugitif prévenu quand un chasseur est à moins de 100 m (0 = jamais)
  liveEvery: 5,     // position des chasseurs envoyée toutes les 5 s
  zoneColor: 'orange',
  jams: 1,          // brouillages par fugitif
  counters: 1,      // contre-radars par fugitif
  riposte: true,    // après un radar, chaque fugitif peut voir le chasseur qui l'a lancé (30 s)
  anon: false,      // mode anonyme : les chasseurs ne savent pas quel fugitif est où (et inversement)
  prison: null,     // {lat, lng, r} : les fugitifs attrapés y vont, un fugitif libre qui y entre les libère
  nogo: [],         // zones interdites [{lat, lng, r}]
};
const PRISON_R = 25;
const ZONE_COLORS = { orange: '#e8590c', rouge: '#e03131', rose: '#d6336c', violet: '#9c36b5', bleu: '#1c7ed6', vert: '#2f9e44' };
const EMOJIS = ['🦊', '🐺', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🦉', '🐙', '🦈', '🐲', '👻', '🤖', '👽', '🤠', '🥷', '🧙', '🦸', '🕵️', '💀', '🔥', '⚡', '🍕'];
const COUNTER_MS = 30000;
const FUZZ_SHRINK_EVERY = 30000; // au plus un rétrécissement du cercle toutes les 30 s
const SHRINK_HOLD = 0.6;      // part de chaque étape où la zone reste fixe avant de se resserrer
const OUTZONE_EVERY = 30000;    // fugitif hors zone : position envoyée toutes les 30 s
const PING_ANSWER_WINDOW = 3 * 60000;

/* ---------- utilitaires ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
function randStr(n, alph = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => alph[x % alph.length]).join('');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clock(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const hhmm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
/** Point à `d` mètres de `a`, dans la direction `brg` (radians). */
function destination(a, d, brg) {
  const R = 6371000, r = Math.PI / 180, lat1 = a.lat * r, lng1 = a.lng * r, dd = d / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dd) + Math.cos(lat1) * Math.sin(dd) * Math.cos(brg));
  const lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(dd) * Math.cos(lat1), Math.cos(dd) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / r, lng: lng2 / r };
}
/** Générateur pseudo-aléatoire : tous les téléphones obtiennent les mêmes tirages pour une même partie. */
function seededRandom(seed) {
  let h = 1779033703;
  for (const ch of seed) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const COMPASS = ['le nord', 'le nord-est', 'l’est', 'le sud-est', 'le sud', 'le sud-ouest', 'l’ouest', 'le nord-ouest'];
const compass = (h) => COMPASS[Math.round(h / 45) % 8];
function minutesLabel(n) {
  if (n < 60) return n + ' min';
  return Math.floor(n / 60) + ' h' + (n % 60 ? ' ' + String(n % 60).padStart(2, '0') : '');
}

/* ---------- chiffrement ---------- */
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => { let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveRoom(code) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('traque-topic|' + code)));
  const id = [...h.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base = await crypto.subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('traque-v1-salt'), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { id, key };
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function unseal(key, str) {
  const u8 = unb64(str);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, key, u8.slice(12));
  return JSON.parse(td.decode(pt));
}

/* ---------- état ---------- */
const S = {
  code: null, b: null, room: null, client: null, connected: false,
  me: null, name: '', screen: 'home',
  cfg: null, players: {}, online: {}, pos: {}, caught: {}, pings: {},
  log: [], logKeys: new Set(), logSeen: 0, gameId: null,
  fix: null, geoErr: null, geoWatch: null, wake: null,
  lastLive: 0, lastOutzone: 0, wasOut: false, warnedReveal: 0, finalSent: false,
  tab: 'players', endDismissed: false, lastOutcomeKey: null,
  batt: {}, hist: {}, powers: {}, emoji: '', bat: null, charging: false, swReg: null, fullmap: false,
};
const T = (sub) => NS + S.room.id + '/' + sub;

/* ---------- interface : petits outils ---------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function busy(text) { $('#busy').hidden = !text; $('#busy-text').textContent = text || ''; }
function show(name) {
  for (const s of ['home', 'lobby', 'game']) $('#screen-' + s).hidden = s !== name;
  S.screen = name;
  if (name === 'lobby') setTimeout(() => lobbyMap && lobbyMap.invalidateSize(), 50);
  if (name === 'game') setTimeout(() => { ensureGameMap(); gameMap.invalidateSize(); }, 50);
}
/** Fenêtre de choix. buttons: [{label, value, cls}] → promesse de la valeur choisie (null si annulé). */
function ask(title, bodyHtml, buttons) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml || '';
    const acts = $('#modal-actions'); acts.innerHTML = '';
    const done = (v) => { $('#modal').hidden = true; $('#modal').onclick = null; resolve(v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || ''); el.textContent = b.label; el.onclick = () => done(b.value);
      acts.appendChild(el);
    }
    $('#modal-body').onclick = (e) => { const v = e.target.closest('[data-pick]'); if (v) done(v.dataset.pick); };
    $('#modal').onclick = (e) => { if (e.target.id === 'modal') done(null); };
    $('#modal').hidden = false;
  });
}
const confirmBox = (title, body, okLabel = 'Confirmer', cls = 'primary') =>
  ask(title, body ? `<p>${body}</p>` : '', [{ label: 'Annuler', value: null, cls: 'ghost' }, { label: okLabel, value: 'ok', cls }]).then((v) => v === 'ok');

let audioCtx;
function beep(kind = 'info') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'alarm' ? [880, 660, 880] : kind === 'good' ? [523, 659, 784] : [740, 988];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'square'; g.gain.value = 0.06;
      o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.16; o.start(t0); o.stop(t0 + 0.12);
    });
  } catch { /* pas de son */ }
  try { navigator.vibrate && navigator.vibrate(kind === 'alarm' ? [300, 120, 300, 120, 300] : [200, 80, 200]); } catch { /* idem */ }
}
document.addEventListener('pointerdown', () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* idem */ } }, { once: true });

/* ---------- réseau ---------- */
function connectBroker(url, will, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, {
      clientId: 'tq_' + randStr(12), clean: true, keepalive: 30, reconnectPeriod: 2000,
      connectTimeout: timeout, protocolVersion: 4, will,
    });
    const t = setTimeout(() => { c.end(true); reject(new Error('timeout')); }, timeout);
    c.once('connect', () => { clearTimeout(t); resolve(c); });
    c.on('error', () => { /* mqtt.js réessaie tout seul ; le délai tranche */ });
  });
}
/** Cherche sur quel relais se trouve la partie (celui qui a sa configuration). */
function findRoom() {
  const topic = T('cfg');
  return new Promise((resolve) => {
    let done = false; const clients = [];
    const finish = (i) => { if (done) return; done = true; clients.forEach((c) => c && c.end(true)); resolve(i); };
    BROKERS.forEach((url, i) => {
      const c = mqtt.connect(url, { clientId: 'tq_' + randStr(12), clean: true, reconnectPeriod: 0, connectTimeout: 7000, protocolVersion: 4 });
      clients[i] = c;
      c.on('connect', () => c.subscribe(topic, { qos: 1 }));
      c.on('message', (_t, payload) => { if (payload && payload.length) finish(i); });
      c.on('error', () => {});
    });
    setTimeout(() => finish(-1), 9000);
  });
}
async function pub(sub, obj, { retain = false, qos = 1 } = {}) {
  if (!S.client) return;
  const payload = obj == null ? '' : await seal(S.room.key, obj);
  S.client.publish(T(sub), payload, { retain, qos });
}

let msgQueue = Promise.resolve();
function onMessage(topic, payload) {
  msgQueue = msgQueue.then(async () => {
    if (!S.room) return;
    const prefix = NS + S.room.id + '/';
    if (!topic.startsWith(prefix)) return;
    const [kind, id] = topic.slice(prefix.length).split('/');
    let data = null;
    if (payload && payload.length) {
      try { data = await unseal(S.room.key, payload.toString()); } catch { return; }
    }
    switch (kind) {
      case 'cfg': if (data) onCfg(data); break;
      case 'p':
        if (data) S.players[id] = data;
        else {
          delete S.players[id];
          if (id === S.me) { toast('Tu as été retiré de la partie.'); leaveRoom(false); return; }
        }
        break;
      case 'on':
        S.online[id] = !!(data && data.on);
        if (data && data.bat != null) S.batt[id] = { lvl: data.bat, chg: !!data.chg };
        break;
      case 'pw':
        if (data) onPowers(id, data); else delete S.powers[id];
        break;
      case 'pos': if (data) onPos(id, data); else delete S.pos[id]; break;
      case 'caught': if (data) onCaught(id, data); else onUncaught(id); break;
      case 'pings':
        if (data) {
          S.pings[id] = data;
          if (S.cfg && data.gameId === S.cfg.gameId) {
            for (const t of data.list) addLog('pinguse:' + id + ':' + t, t, anonHidden(id) ? '📡 Un chasseur lance un radar.' : `📡 <b>${esc(nameOf(id))}</b> lance un radar.`);
          }
        } else delete S.pings[id];
        break;
      case 'ev': if (data) onEvent(data); break;
      default: break;
    }
    scheduleRender();
  });
}

async function enterRoom({ code, b = null, create = false }) {
  busy(create ? 'Création de la partie…' : 'Connexion à la partie…');
  try {
    S.code = code;
    S.room = await deriveRoom(code);
    S.me = store.get('traque.id.' + code) || randStr(12);
    store.set('traque.id.' + code, S.me);
    S.cfg = null; S.players = {}; S.online = {}; S.pos = {}; S.caught = {}; S.pings = {};
    resetLog();

    const will = { topic: T('on/' + S.me), payload: await seal(S.room.key, { on: false }), qos: 1, retain: true };
    let client = null, idx = b;
    if (create) {
      for (let i = 0; i < BROKERS.length && !client; i++) {
        try { client = await connectBroker(BROKERS[i], will); idx = i; } catch { /* relais suivant */ }
      }
    } else {
      if (idx == null || !BROKERS[idx]) {
        busy('Recherche de la partie…');
        idx = await findRoom();
        if (idx < 0) throw new Error('Partie introuvable. Vérifie le code et ta connexion.');
      }
      client = await connectBroker(BROKERS[idx], will).catch(() => null);
    }
    if (!client) throw new Error('Impossible de joindre le serveur de jeu. Réessaie dans un instant.');

    S.client = client; S.b = idx; S.connected = true;
    client.on('message', onMessage);
    client.on('connect', () => { S.connected = true; pubPresence(true); scheduleRender(); });
    client.on('close', () => { S.connected = false; scheduleRender(); });
    client.on('offline', () => { S.connected = false; scheduleRender(); });
    await new Promise((res, rej) => client.subscribe(NS + S.room.id + '/#', { qos: 1 }, (err) => (err ? rej(err) : res())));

    await pub('p/' + S.me, { id: S.me, name: S.name, emoji: S.emoji, t: Date.now() }, { retain: true });
    await pubPresence(true);

    if (create) {
      S.cfg = { v: 1, host: S.me, status: 'lobby', gameId: randStr(8), rules: { ...DEFAULT_RULES }, roles: { [S.me]: 'H' }, updatedAt: Date.now() };
      S.gameId = S.cfg.gameId;
      await pub('cfg', S.cfg, { retain: true });
    } else {
      const t0 = Date.now();
      while (!S.cfg && Date.now() - t0 < 8000) await sleep(100);
      if (!S.cfg) throw new Error('Partie introuvable. Vérifie le code.');
    }

    store.set('traque.last', { code, b: idx });
    history.replaceState(null, '', location.pathname + location.search + '#join=' + code + '&b=' + idx);
    startGeo();
    initBattery();
    route();
  } catch (e) {
    if (S.client) { S.client.end(true); S.client = null; }
    S.room = null; S.code = null;
    toast(e.message || 'Erreur de connexion');
    show('home');
  } finally {
    busy(false);
  }
}

/** Présence (en ligne + batterie). Republiée quand la batterie change d'au moins 5 points. */
async function pubPresence(force = false) {
  if (!S.client || !S.room) return;
  if (!force && S.lastBatSent != null && S.bat != null && Math.abs(S.bat - S.lastBatSent) < 5 && S.lastChgSent === S.charging) return;
  S.lastBatSent = S.bat; S.lastChgSent = S.charging;
  await pub('on/' + S.me, { on: true, t: Date.now(), bat: S.bat, chg: S.charging }, { retain: true });
}
async function initBattery() {
  try {
    if (!navigator.getBattery) return;
    const b = await navigator.getBattery();
    const upd = () => { S.bat = Math.round(b.level * 100); S.charging = b.charging; S.batt[S.me] = { lvl: S.bat, chg: S.charging }; pubPresence(); };
    b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
    upd();
  } catch { /* iPhone : pas d'accès à la batterie */ }
}
function battHtml(id) {
  const b = S.batt[id];
  if (!b || b.lvl == null) return '';
  const icon = b.chg ? '⚡' : b.lvl <= 20 ? '🪫' : '🔋';
  return `<span class="batt ${b.lvl <= 20 && !b.chg ? 'low' : ''}">${icon} ${b.lvl} %</span>`;
}
const avatarOf = (id) => (S.players[id] && S.players[id].emoji) || '';

async function leaveRoom(removeMe = true) {
  if (S.client) {
    if (removeMe) {
      await pub('on/' + S.me, null, { retain: true });
      await pub('p/' + S.me, null, { retain: true });
    }
    const c = S.client; S.client = null;
    setTimeout(() => c.end(), 400);
  }
  if (S.geoWatch != null) { navigator.geolocation.clearWatch(S.geoWatch); S.geoWatch = null; }
  keepAwake(false);
  store.del('traque.last');
  history.replaceState(null, '', location.pathname + location.search);
  S.room = null; S.code = null; S.cfg = null;
  initHome();
  show('home');
}

/* ---------- logique du jeu ---------- */
function resetLog() { S.log = []; S.logKeys = new Set(); S.logSeen = 0; S.warnedReveal = 0; S.finalSent = false; S.wasOut = false; S.endDismissed = false; S.lastOutcomeKey = null; S.hist = {}; S.nearWarned = false; S.inCircleAlerted = {}; }
function addLog(key, t, html, { notify = false } = {}) {
  if (S.logKeys.has(key)) return;
  S.logKeys.add(key);
  S.log.push({ t, html });
  S.log.sort((a, b) => a.t - b.t);
  if (notify && S.tab !== 'log') S.logSeen = Math.min(S.logSeen, S.log.length - 1);
}
const nameOf = (id) => (S.players[id] && S.players[id].name) || 'Quelqu’un';
const isHost = () => S.cfg && S.cfg.host === S.me;
function isCaught(id) { const k = S.caught[id]; return !!k && !!S.cfg && k.gameId === S.cfg.gameId && !k.freed; }
function baseRole(id) { return (S.cfg && S.cfg.roles && S.cfg.roles[id]) || (S.cfg && S.cfg.status === 'lobby' ? 'H' : 'S'); }
function roleOf(id) {
  const r = baseRole(id);
  if (r === 'F' && isCaught(id)) return S.cfg.rules.caughtBecomesHunter && !S.cfg.rules.prison ? 'H' : 'S';
  return r;
}
/** Mode anonyme : les chasseurs ne savent pas quel fugitif est où, les fugitifs ne savent pas quel chasseur fait quoi. */
function anonHidden(id) {
  const c = S.cfg;
  if (!c || !c.rules.anon || id === S.me || c.status === 'lobby' || outcome()) return false;
  return roleOf(S.me) === 'F' ? baseRole(id) === 'H' : baseRole(id) === 'F';
}
/** Nom affichable dans le journal et sur la carte (« un fugitif » en mode anonyme). */
const dn = (id) => (anonHidden(id) ? (baseRole(id) === 'F' ? 'un fugitif' : 'un chasseur') : nameOf(id));
const dnb = (id) => (anonHidden(id) ? dn(id) : `<b>${esc(nameOf(id))}</b>`);
const fugitives = () => Object.keys(S.cfg.roles || {}).filter((id) => S.cfg.roles[id] === 'F');

function phase(now = Date.now()) {
  const c = S.cfg;
  if (!c || c.status === 'lobby') return { name: 'lobby' };
  const r = c.rules, start = c.startAt;
  const release = start + r.headStart * MIN, end = start + r.duration * MIN;
  const base = { start, release, end };
  if (c.status === 'ended') return { ...base, name: 'ended' };
  if (now >= end) return { ...base, name: 'over' };
  if (now < release) return { ...base, name: 'head' };
  const k = Math.floor((now - release) / (r.interval * MIN));
  const next = release + (k + 1) * r.interval * MIN;
  return { ...base, name: 'hunt', k, nextReveal: next < end ? next : null };
}
function outcome() {
  const c = S.cfg;
  if (!c || c.status === 'lobby') return null;
  if (c.status === 'ended') return { winner: c.winner, reason: c.endReason, at: c.endedAt };
  const fug = fugitives();
  if (fug.length && fug.every(isCaught)) {
    const at = Math.max(...fug.map((id) => S.caught[id].t));
    return { winner: 'H', reason: 'all-caught', at };
  }
  const end = c.startAt + c.rules.duration * MIN;
  if (Date.now() >= end) return { winner: 'F', reason: 'time', at: end };
  return null;
}
const pingTimes = () => {
  const all = [];
  for (const p of Object.values(S.pings)) if (p.gameId === S.cfg.gameId) all.push(...p.list);
  return all.sort((a, b) => a - b).slice(0, S.cfg.rules.pings);
};

function onCfg(data) {
  data.rules = { ...DEFAULT_RULES, ...data.rules };
  const prev = S.cfg;
  S.cfg = data;
  if (!prev || prev.gameId !== data.gameId) {
    resetLog();
    S.gameId = data.gameId;
  }
  if (data.status === 'running' && (!prev || prev.status !== 'running')) {
    if (prev && Date.now() - data.startAt < 10000) {
      beep('good');
      toast(roleOf(S.me) === 'F' ? '🏃 C’est parti, cours !' : roleOf(S.me) === 'H' ? '🔦 C’est parti ! Reste sur place pendant l’avance.' : 'C’est parti !', 4500);
    }
  }
  if (S.room) route();
}
function onPos(id, data) {
  const prev = S.pos[id];
  if (prev && prev.t > data.t) return;
  S.pos[id] = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId || data.kind === 'live') return;
  const mine = id === S.me;
  const who = mine ? 'Ta position a été' : anonHidden(id) ? 'Position d’un fugitif' : `Position de <b>${esc(nameOf(id))}</b>`;
  const late = data.late ? ' (en retard)' : '';
  let html;
  if (data.kind === 'reveal') html = `📍 ${who} révélée${late}.`;
  else if (data.kind === 'ping') html = `📡 Radar : ${mine ? 'ta position a été révélée' : `${dnb(id)} repéré·e`}.`;
  else if (data.kind === 'outzone') html = data.why === 'nogo'
    ? `⛔ ${mine ? 'Tu es' : `${dnb(id)} est`} dans une zone interdite, position révélée.`
    : `🚧 ${mine ? 'Tu es' : `${dnb(id)} est`} hors zone, position révélée.`;
  else if (data.kind === 'shrink') {
    const n = (data.lvl || 2) - 1;
    html = mine
      ? `🎯 ${anonHidden(data.by) ? 'Un chasseur' : `<b>${esc(nameOf(data.by))}</b>`} a trouvé ton cercle n°${n} : nouveau cercle n°${n + 1} de ${fmtDist(data.r)}.`
      : `🎯 ${data.by === S.me ? 'Tu as' : `${dnb(data.by)} a`} trouvé le cercle n°${n} de ${dnb(id)} → cercle n°${n + 1} (${fmtDist(data.r)}) !`;
  }
  else if (data.kind === 'final') html = `🏁 ${mine ? 'Ta cachette' : `Cachette de <b>${esc(nameOf(id))}</b>`} dévoilée.`;
  else return;
  const fresh = Date.now() - data.t < 60000;
  addLog('pos:' + id + ':' + data.t, data.t, html, { notify: true });
  // Historique des positions révélées (pour tracer le parcours)
  const h = S.hist[id] || (S.hist[id] = []);
  if (data.kind !== 'final' && !h.some((x) => x.t === data.t)) {
    h.push({ lat: data.lat, lng: data.lng, r: data.r || 0, t: data.t });
    h.sort((a, b) => a.t - b.t);
    if (h.length > 15) h.shift();
  }
  if (fresh && !mine && data.kind !== 'final' && roleOf(S.me) !== 'F') beep('info');
}
function onCaught(id, data) {
  S.caught[id] = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId) return;
  if (data.freed) {
    addLog('freed:' + id + ':' + data.t, data.t, `🔓 <b>${esc(nameOf(id))}</b> a été libéré·e par <b>${esc(nameOf(data.by))}</b> !`, { notify: true });
    if (Date.now() - data.t < 60000) {
      beep('good');
      if (id === S.me) { toast('🔓 Tu es libre ! Cours !', 5000); notify('Tu es libre !', `${nameOf(data.by)} t'a libéré·e.`); }
      else if (roleOf(S.me) === 'H') toast(`🔓 ${nameOf(id)} s'est échappé·e de prison !`, 4000);
    }
    return;
  }
  const by = data.by ? ` par <b>${esc(nameOf(data.by))}</b>` : '';
  addLog('caught:' + id + ':' + data.t, data.t, `🎯 <b>${esc(nameOf(id))}</b> s'est fait attraper${by} !`, { notify: true });
  if (Date.now() - data.t < 60000) {
    beep(id === S.me ? 'alarm' : 'good');
    if (id === S.me) toast(S.cfg.rules.prison ? '🔒 Attrapé·e ! Va à la prison (🔒 sur la carte) et attends qu’on te libère.'
      : S.cfg.rules.caughtBecomesHunter ? 'Attrapé·e ! Tu deviens chasseur 🔦' : 'Attrapé·e ! Tu passes spectateur 👀', 6000);
  }
}
function onUncaught(id) {
  if (S.caught[id] && S.cfg && S.caught[id].gameId === S.cfg.gameId) addLog('uncaught:' + id + ':' + Date.now(), Date.now(), `↩️ Capture de <b>${esc(nameOf(id))}</b> annulée.`);
  delete S.caught[id];
}
function onEvent(ev) {
  if (ev.type === 'chat') {
    addLog('chat:' + ev.from + ':' + ev.t, ev.t, `<span class="chat-from">${esc(nameOf(ev.from))} :</span> ${esc(ev.text)}`, { notify: true });
  }
}

/* ---------- position ---------- */
/* Filtre de Kalman simple : lisse les sauts du GPS en tenant compte de la précision annoncée,
   et ignore les positions très imprécises quand on en a une bien meilleure et récente. */
const KF = { v: -1, lat: 0, lng: 0, t: 0, q: 3 /* m/s : on peut courir */ };
function gpsFilter(m, now) {
  if (KF.v < 0 || now - KF.t > 60000) { Object.assign(KF, { lat: m.lat, lng: m.lng, v: m.acc * m.acc, t: now }); return { lat: m.lat, lng: m.lng }; }
  const cur = Math.sqrt(KF.v);
  if (m.acc > 60 && m.acc > cur * 3 && now - KF.t < 30000) return null; // position Wi-Fi/antenne approximative : on garde la bonne
  // Mesure précise mais très loin de l'estimation (GPS qui se recale, appli rouverte) : on la prend telle quelle.
  if (m.acc <= 30 && dist(KF, m) > 3 * (m.acc + cur) + 20) { Object.assign(KF, { lat: m.lat, lng: m.lng, v: m.acc * m.acc, t: now }); return { lat: m.lat, lng: m.lng }; }
  const dt = Math.max(0.05, (now - KF.t) / 1000);
  KF.v += dt * KF.q * KF.q;
  const k = KF.v / (KF.v + m.acc * m.acc);
  KF.lat += k * (m.lat - KF.lat); KF.lng += k * (m.lng - KF.lng);
  KF.v = (1 - k) * KF.v; KF.t = now;
  return { lat: KF.lat, lng: KF.lng };
}
function gpsQuality() {
  if (S.geoErr) return { cls: 'bad', txt: '📍 GPS ✕' };
  if (!S.fix) return { cls: 'mid', txt: '📍 GPS…' };
  const a = S.fix.acc, cls = a <= 20 ? 'good' : a <= 50 ? 'mid' : 'bad';
  return { cls, txt: `📍 ±${a} m` };
}
function openGpsHelp() {
  const q = gpsQuality();
  ask('📍 Précision du GPS', `
    <p>Précision actuelle : <b>${q.txt.replace('📍 ', '')}</b>. Moins de 20 m, c'est bien ; plus de 50 m, la position peut être fausse d'une rue.</p>
    <p><b>Pourquoi c'est parfois imprécis :</b> entre les immeubles, sous les arbres ou à l'intérieur, le téléphone capte mal les satellites. Quand la « position précise » est coupée, il ne donne qu'une position approximative (Wi-Fi, antennes), parfois à plusieurs centaines de mètres.</p>
    <ol class="steps">
      <li><b>Android</b> : Paramètres › Localisation › active « Précision de la localisation Google » (ou « Améliorer la précision »). Dans Chrome, touche le cadenas à côté de l'adresse › Autorisations › Position : <b>précise</b>.</li>
      <li><b>iPhone</b> : Réglages › Confidentialité et sécurité › Service de localisation › Safari (ou Chrome) › « Lorsque l'app est active » et <b>Position exacte</b> activée.</li>
      <li>Laisse le <b>Wi-Fi activé</b>, même sans être connecté : en ville, il aide beaucoup.</li>
      <li>Coupe l'<b>économiseur de batterie</b> pendant la partie.</li>
      <li>Au début, reste <b>10 à 20 s dehors, à découvert</b>, le temps que le GPS se cale.</li>
    </ol>
    <p class="hint">L'appli lisse déjà les sauts de position, ignore les positions très approximatives quand elle en a une meilleure, et attend quelques secondes une bonne précision avant chaque révélation.</p>`,
  [{ label: 'Fermer', value: null, cls: 'primary' }]);
}
function startGeo() {
  if (S.geoWatch != null || !navigator.geolocation) { if (!navigator.geolocation) S.geoErr = 'unsupported'; return; }
  S.geoWatch = navigator.geolocation.watchPosition((p) => {
    const c = p.coords, now = Date.now();
    const filtered = gpsFilter({ lat: c.latitude, lng: c.longitude, acc: Math.max(3, c.accuracy || 50) }, now);
    if (!filtered) return;
    const here = filtered;
    let heading = S.fix ? S.fix.heading : null;
    if (c.heading != null && !Number.isNaN(c.heading) && (c.speed || 0) > 0.7) {
      heading = c.heading; S.anchor = here; S.anchorT = now; S.lastMoveT = now;
    } else if (!S.anchor) {
      S.anchor = here; S.anchorT = now;
    } else if (dist(S.anchor, here) > Math.max(8, Math.min(c.accuracy, 25))) {
      const dt = (now - (S.anchorT || now)) / 1000;
      const v = dt >= 1 ? dist(S.anchor, here) / dt : null;
      if (v != null && v < 40) S.speedCalc = S.speedCalc ? S.speedCalc * 0.5 + v * 0.5 : v; // > 144 km/h : saut de GPS, ignoré
      heading = bearing(S.anchor, here); S.anchor = here; S.anchorT = now; S.lastMoveT = now;
    }
    const spd = c.speed != null && !Number.isNaN(c.speed) && c.speed < 40 ? c.speed : (S.speedCalc || 0);
    S.fix = { ...here, acc: Math.round(c.accuracy), t: now, heading, spd };
    S.geoErr = null;
    onFix();
  }, (e) => {
    S.geoErr = e.code === 1 ? 'denied' : 'unavailable';
    scheduleRender();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
function onFix() {
  if (S.screen === 'game') { updateSelfMarker(); dutyTick(); }
  if (S.screen === 'lobby') renderLobbyMap();
  scheduleRender();
}
/** Direction de marche (degrés, 0 = nord) ou null si on ne bouge plus depuis une minute. */
function myHeading() {
  if (!S.fix || S.fix.heading == null || !S.lastMoveT || Date.now() - S.lastMoveT > 60000) return null;
  return Math.round(S.fix.heading);
}
/** Vitesse en m/s (0 si on ne bouge plus depuis 20 s). */
function mySpeed() {
  if (!S.fix || !S.lastMoveT || Date.now() - S.lastMoveT > 20000) return 0;
  return +(S.fix.spd || 0).toFixed(1);
}
const kmh = (ms) => Math.round(ms * 3.6) + ' km/h';
async function publishPos(kind, extra = {}) {
  if (!S.fix) return false;
  let p = { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), acc: S.fix.acc, hdg: myHeading(), spd: mySpeed(), fixT: S.fix.t, t: Date.now(), kind, gameId: S.cfg.gameId, ...extra };
  if (kind !== 'live' && kind !== 'final' && S.cfg.rules.fuzzy > 0) {
    const circle = fuzzCircle(extra.r || S.cfg.rules.fuzzy);
    p = { ...p, ...circle, acc: undefined };
  }
  S.pos[S.me] = p;
  await pub('pos/' + S.me, p, { retain: true, qos: kind === 'live' ? 0 : 1 });
  if (kind !== 'live') onPos(S.me, p);
  return true;
}
/**
 * Calendrier de la zone : après l'avance, une étape toutes les `shrinkEvery` minutes.
 * Pendant chaque étape, la zone reste fixe (60 % du temps) puis glisse vers la suivante.
 * Les centres sont tirés au sort avec la graine de la partie : identiques sur tous les téléphones.
 */
let zoneCache = { key: '', sched: null };
function zoneSchedule() {
  const c = S.cfg, r = c && c.rules, z = r && r.zone;
  if (!z) return null;
  const key = [c.gameId, c.status === 'lobby', c.startAt, z.lat, z.lng, z.r, r.shrink, r.shrinkEvery, r.headStart, r.duration].join('|');
  if (zoneCache.key === key) return zoneCache.sched;
  const circles = [{ lat: z.lat, lng: z.lng, r: z.r }];
  let sched = { circles, n: 0 };
  if (c.status !== 'lobby' && r.shrink > 0 && c.startAt) {
    const release = c.startAt + r.headStart * MIN, end = c.startAt + r.duration * MIN;
    const step = r.shrinkEvery * MIN;
    const n = Math.max(0, Math.min(12, Math.floor(((end - release) * 0.85) / step)));
    const rand = seededRandom(c.gameId + '|zone');
    const rFinal = z.r * r.shrink / 100;
    for (let i = 1; i <= n; i++) {
      const prev = circles[i - 1];
      const rad = z.r - ((z.r - rFinal) * i) / n;
      const c2 = destination(prev, rand() * (prev.r - rad) * 0.7, rand() * 2 * Math.PI);
      circles.push({ lat: c2.lat, lng: c2.lng, r: rad });
    }
    sched = { circles, n, release, step };
  }
  zoneCache = { key, sched };
  return sched;
}
/** Zone en vigueur à l'instant t (+ la suivante et les horaires de l'étape en cours). */
function zoneState(t = Date.now()) {
  const sc = zoneSchedule();
  if (!sc) return null;
  const { circles, n } = sc;
  if (!n || t < sc.release) return { cur: circles[0], next: n ? circles[1] : null, shrinkAt: n ? sc.release + SHRINK_HOLD * sc.step : null, endAt: n ? sc.release + sc.step : null, stage: 0, n };
  const x = (t - sc.release) / sc.step, i = Math.floor(x);
  if (i >= n) return { cur: circles[n], next: null, stage: n, n, final: true };
  const t0 = sc.release + i * sc.step, shrinkAt = t0 + SHRINK_HOLD * sc.step, endAt = t0 + sc.step;
  const a = circles[i], b = circles[i + 1];
  let cur = a, shrinking = false;
  if (t >= shrinkAt) {
    const k = (t - shrinkAt) / (endAt - shrinkAt);
    cur = { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k, r: a.r + (b.r - a.r) * k };
    shrinking = true;
  }
  return { cur, next: b, shrinkAt, endAt, stage: i, n, shrinking };
}
function currentZone() {
  const st = zoneState();
  return st ? st.cur : null;
}
/** 'out' (hors de la zone), 'nogo' (dans une zone interdite) ou false. */
function outOfZone() {
  if (!S.fix || !S.cfg) return false;
  const z = currentZone();
  if (z && dist(S.fix, z) > z.r) return 'out';
  if ((S.cfg.rules.nogo || []).some((n) => dist(S.fix, n) <= n.r)) return 'nogo';
  return false;
}
/** Cercle (centre décalé au hasard) qui contient forcément ma position actuelle. */
function fuzzCircle(r) {
  // Le décalage tient compte de l'imprécision du GPS pour que le vrai joueur reste dans le cercle.
  const maxOff = Math.max(0, r - (S.fix.acc || 0)) * 0.8;
  const c2 = destination(S.fix, Math.sqrt(Math.random()) * maxOff, Math.random() * 2 * Math.PI);
  return { lat: +c2.lat.toFixed(6), lng: +c2.lng.toFixed(6), r: Math.round(r) };
}

/** Ce que mon téléphone doit faire en ce moment (envoyer ma position, etc.). */
let dutyBusy = false;
async function dutyTick() {
  if (dutyBusy || !S.cfg || !S.client) return;
  dutyBusy = true;
  try {
    const ph = phase(), now = Date.now(), c = S.cfg, gid = c.gameId;
    const role = roleOf(S.me), out = outcome();

    if (c.status === 'running' && !out) keepAwake(true); else keepAwake(false);
    if (c.status !== 'lobby') addLog('start:' + gid, c.startAt, `🚦 La partie commence. Les fugitifs ont <b>${minutesLabel(c.rules.headStart)}</b> d'avance.`);

    // Fin de partie : l'organisateur l'enregistre ; les fugitifs libres dévoilent leur cachette.
    if (c.status === 'running' && out) {
      if (isHost()) {
        await pubCfg({ status: 'ended', winner: out.winner, endReason: out.reason, endedAt: out.at });
      }
      if (baseRole(S.me) === 'F' && !isCaught(S.me) && !S.finalSent && S.fix) {
        S.finalSent = true; await publishPos('final');
      }
      return;
    }
    if (c.status !== 'running' || !(ph.name === 'head' || ph.name === 'hunt')) return;

    if (ph.name === 'hunt') {
      addLog('release:' + gid, ph.release, '🔓 Les chasseurs sont lâchés !');
      if (now - ph.release < 3000 && !S.logKeys.has('release-beep:' + gid)) { S.logKeys.add('release-beep:' + gid); beep('alarm'); }
    }

    // Zone qui rétrécit : annonces
    const zs = zoneState(now);
    if (ph.name === 'hunt' && zs && zs.n && !zs.final) {
      const tag = gid + ':' + zs.stage;
      if (zs.shrinkAt - now <= 30000 && now < zs.shrinkAt && S.warnedShrink !== tag) {
        S.warnedShrink = tag; beep('info');
        const outNext = S.fix && dist(S.fix, zs.next) > zs.next.r;
        toast(outNext ? '⭕ La zone rétrécit dans 30 s, et tu seras dehors ! Bouge.' : '⭕ La zone rétrécit dans 30 s', 4500);
      }
      if (zs.shrinking) addLog('shrink:' + tag, zs.shrinkAt, `⭕ La zone rétrécit (rayon ${fmtDist(zs.next.r)}).`);
    }

    // Sortie de zone (tout le monde est prévenu)
    const isOut = outOfZone();
    if (isOut && !S.wasOut) {
      S.wasOut = true; beep('alarm');
      notify(isOut === 'nogo' ? 'Zone interdite !' : 'Hors zone !', isOut === 'nogo' ? 'Sors de la zone interdite.' : 'Reviens dans la zone de jeu.');
    }
    if (!isOut && S.wasOut) { S.wasOut = false; toast('✅ De retour dans la zone', 2500); }

    // Brouillages : tout le monde voit passer les révélations brouillées
    if (ph.name === 'hunt') {
      for (const id of fugitives()) {
        for (const j of myPowers(id)) {
          if (j.type === 'jam' && j.idx <= ph.k) addLog('jammed:' + id + ':' + j.idx, ph.release + j.idx * c.rules.interval * MIN, id === S.me ? '📵 Ta révélation a été brouillée : les chasseurs n’ont rien reçu.' : `📵 Révélation de <b>${esc(nameOf(id))}</b> brouillée.`);
        }
      }
    }

    // Rappels appli fermée (ntfy), programmés une fois par partie
    if (role === 'F') scheduleReminders();

    if (role === 'F') {
      if (ph.name === 'hunt') {
        // Révélation programmée
        const key = 'traque.rev.' + gid;
        const last = store.get(key, -1);
        if (ph.k > last && S.fix) {
          const late = now - (ph.release + ph.k * c.rules.interval * MIN) > 60000;
          const due = ph.release + ph.k * c.rules.interval * MIN;
          if (jammed(S.me, ph.k)) store.set(key, ph.k);
          else if (S.fix.acc > 35 && now - due < 15000) { /* on attend jusqu'à 15 s une meilleure précision */ }
          else if (await publishPos('reveal', { idx: ph.k, late, lvl: 1 })) store.set(key, ph.k);
        }
        // Avertissement 30 s avant la prochaine
        if (ph.nextReveal && ph.nextReveal - now <= 30000 && S.warnedReveal !== ph.nextReveal) {
          S.warnedReveal = ph.nextReveal; beep('info'); toast('⚠️ Ta position sera révélée dans 30 s', 4000);
        }
        // Radars des chasseurs
        const answeredKey = 'traque.ping.' + gid;
        const answered = store.get(answeredKey, []);
        for (const t of pingTimes()) {
          if (answered.includes(t) || now - t > PING_ANSWER_WINDOW) continue;
          if (await publishPos('ping', { pingT: t, lvl: 1 })) {
            answered.push(t); store.set(answeredKey, answered);
            beep('alarm'); toast('📡 Radar ! Les chasseurs viennent de voir ta position.', 4500);
          }
        }
      }
      if (isOut && now - S.lastOutzone > OUTZONE_EVERY) {
        S.lastOutzone = now; await publishPos('outzone', { lvl: 1, why: isOut });
      }
      // Prison : un fugitif libre qui y entre libère tous les prisonniers
      const pr = c.rules.prison;
      if (pr && ph.name === 'hunt' && S.fix && now - (S.lastFree || 0) > 10000 && dist(S.fix, pr) <= pr.r + Math.min(S.fix.acc, 20)) {
        const prisoners = fugitives().filter((id) => id !== S.me && isCaught(id));
        if (prisoners.length) {
          S.lastFree = now;
          for (const id of prisoners) await pub('caught/' + id, { freed: true, by: S.me, t: now, gameId: gid }, { retain: true });
          beep('good'); toast(`🔓 Tu as libéré ${prisoners.map(nameOf).join(', ')} !`, 4500);
        }
      }
      // Alerte chasseur proche
      if (ph.name === 'hunt' && c.rules.nearAlert > 0 && S.fix) {
        let nearest = Infinity;
        for (const id of Object.keys(S.pos)) {
          const h = S.pos[id];
          if (id !== S.me && h.kind === 'live' && h.gameId === gid && roleOf(id) === 'H' && now - h.t < 45000) nearest = Math.min(nearest, dist(h, S.fix));
        }
        if (nearest <= c.rules.nearAlert && !S.nearWarned) {
          S.nearWarned = true; beep('alarm');
          toast(`⚠️ Un chasseur est à moins de ${fmtDist(c.rules.nearAlert)} !`, 4500);
          notify('Chasseur proche !', `Un chasseur est à moins de ${fmtDist(c.rules.nearAlert)}.`);
        } else if (nearest > c.rules.nearAlert * 1.5) S.nearWarned = false;
      }
      // Un chasseur entre dans mon cercle : il rétrécit autour de ma position actuelle.
      const mine = S.pos[S.me];
      if (ph.name === 'hunt' && c.rules.fuzzy > 0 && S.fix && mine && mine.gameId === gid && mine.r > c.rules.fuzzMin
          && mine.kind !== 'live' && mine.kind !== 'final' && now - (S.lastShrink || 0) > FUZZ_SHRINK_EVERY) {
        const intruder = Object.keys(S.pos).find((id) => {
          const h = S.pos[id];
          return id !== S.me && h.kind === 'live' && h.gameId === gid && roleOf(id) === 'H' && now - h.t < 30000 && dist(h, mine) <= mine.r;
        });
        if (intruder) {
          S.lastShrink = now;
          const lvl = (mine.lvl || 1) + 1, nr = Math.max(c.rules.fuzzMin, Math.round((mine.r * c.rules.fuzzShrink) / 100));
          await publishPos('shrink', { r: nr, by: intruder, lvl });
          const msg = `🎯 ${anonHidden(intruder) ? 'Un chasseur' : nameOf(intruder)} a trouvé ton cercle n°${lvl - 1} ! Nouveau cercle n°${lvl} : ${fmtDist(nr)}`;
          beep('alarm'); toast(msg, 5000); notify('Ton cercle a été trouvé', msg);
        }
      }
    } else if (role === 'H') {
      const every = c.rules.liveEvery * 1000, keep = Math.max(20000, every);
      if (S.fix && (now - S.lastLive > keep || (S.fix.t > S.lastLive && now - S.lastLive > every))) {
        S.lastLive = now; await publishPos('live');
      }
      // Chasseur : prévenu quand il entre dans le cercle d'un fugitif
      if (S.fix && ph.name === 'hunt') {
        for (const id of fugitives()) {
          const p = visiblePos(id);
          if (!p || !p.r || isCaught(id) || p.kind === 'final') continue;
          const key = id + ':' + p.t;
          if (dist(S.fix, p) <= p.r && !S.inCircleAlerted[key]) {
            S.inCircleAlerted[key] = true; beep('good');
            toast(`🎯 Tu es dans le cercle n°${p.lvl || 1} de ${dn(id)} !`, 3500);
          }
        }
      }
    }
  } finally {
    dutyBusy = false;
  }
}

async function keepAwake(on) {
  try {
    if (on && !S.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
    } else if (!on && S.wake) {
      const w = S.wake; S.wake = null; await w.release();
    }
  } catch { /* non pris en charge */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.room) { dutyTick(); scheduleRender(); }
});

/* ---------- actions ---------- */
async function pubCfg(patch) {
  S.cfg = { ...S.cfg, ...patch, updatedAt: Date.now() };
  scheduleRender();
  await pub('cfg', S.cfg, { retain: true });
}
const pubRules = (patch) => pubCfg({ rules: { ...S.cfg.rules, ...patch } });

async function startGame() {
  const roles = {};
  for (const id of Object.keys(S.players)) roles[id] = baseRole(id);
  const nF = Object.values(roles).filter((r) => r === 'F').length;
  const nH = Object.values(roles).filter((r) => r === 'H').length;
  if (!nF || !nH) { toast('Il faut au moins un fugitif et un chasseur.'); return; }
  const r = S.cfg.rules;
  const ok = await confirmBox('Lancer la partie ?',
    `${nF} fugitif${nF > 1 ? 's' : ''} contre ${nH} chasseur${nH > 1 ? 's' : ''}. ${minutesLabel(r.headStart)} d'avance, révélation toutes les ${minutesLabel(r.interval)}, ${minutesLabel(r.duration)} au total.${r.prison ? ' Prison active : les fugitifs attrapés peuvent être libérés.' : ''}${r.anon ? ' Mode anonyme.' : ''}${r.zone ? (r.shrink > 0 ? ' La zone rétrécit au fil du temps.' : '') : ' Aucune zone de jeu définie.'}${r.fuzzy > 0 ? ` Les fugitifs apparaissent dans un cercle de ${fmtDist(r.fuzzy)}.` : ''}`,
    'C’est parti !');
  if (!ok) return;
  await pubCfg({ status: 'running', startAt: Date.now(), gameId: randStr(8), roles, winner: null, endReason: null, endedAt: null });
}
async function catchSelf() {
  const ok = await confirmBox('Tu t’es fait attraper ?', 'Tout le monde sera prévenu.', 'Oui, attrapé·e', 'fug');
  if (!ok) return;
  await pub('caught/' + S.me, { by: null, t: Date.now(), gameId: S.cfg.gameId }, { retain: true });
}
async function catchSomeone() {
  const free = fugitives().filter((id) => !isCaught(id));
  if (!free.length) { toast('Plus aucun fugitif en fuite.'); return; }
  const body = '<p>Qui as-tu touché ?</p><div class="pick-list">' +
    free.map((id) => `<button class="btn" data-pick="${esc(id)}">🏃 ${esc(nameOf(id))}</button>`).join('') + '</div>';
  const id = await ask('J’ai attrapé…', body, [{ label: 'Annuler', value: null, cls: 'ghost' }]);
  if (!id) return;
  await pub('caught/' + id, { by: S.me, t: Date.now(), gameId: S.cfg.gameId }, { retain: true });
}
async function usePing() {
  const used = pingTimes().length, left = S.cfg.rules.pings - used;
  if (left <= 0) { toast('Plus de radar disponible.'); return; }
  const ok = await confirmBox('Lancer un radar ?', `La position de tous les fugitifs sera révélée maintenant. Il en restera ${left - 1} à l'équipe.`, '📡 Lancer');
  if (!ok) return;
  const mine = S.pings[S.me] && S.pings[S.me].gameId === S.cfg.gameId ? S.pings[S.me].list : [];
  const next = { gameId: S.cfg.gameId, list: [...mine, Date.now()] };
  S.pings[S.me] = next;
  await pub('pings/' + S.me, next, { retain: true });
  addLog('pinguse:' + S.me + ':' + next.list.at(-1), next.list.at(-1), `📡 <b>${esc(S.name)}</b> lance un radar.`);
  scheduleRender();
}
/* ---------- pouvoirs des fugitifs ---------- */
const myPowers = (id) => (S.powers[id] && S.cfg && S.powers[id].gameId === S.cfg.gameId ? S.powers[id].list : []);
const powersUsed = (id, type) => myPowers(id).filter((x) => x.type === type).length;
const jammed = (id, idx) => myPowers(id).some((x) => x.type === 'jam' && x.idx === idx);
function counterLeft(id) {
  const last = myPowers(id).filter((x) => x.type === 'counter').map((x) => x.t).sort((a, b) => b - a)[0];
  return last ? Math.max(0, last + COUNTER_MS - Date.now()) : 0;
}
const counterActive = (id) => counterLeft(id) > 0;
/** Dernier radar lancé (dans la limite autorisée) : { t, by }. */
function lastPing() {
  if (!S.cfg) return null;
  const valid = pingTimes();
  let best = null;
  for (const [hid, p] of Object.entries(S.pings)) {
    if (p.gameId !== S.cfg.gameId) continue;
    for (const t of p.list) if (valid.includes(t) && (!best || t > best.t)) best = { t, by: hid };
  }
  return best;
}
function riposteAvailable() {
  if (!S.cfg || !S.cfg.rules.riposte) return null;
  const lp = lastPing();
  if (!lp || Date.now() - lp.t > 60000) return null;
  if (myPowers(S.me).some((x) => x.type === 'riposte' && x.pingT === lp.t)) return null;
  return lp;
}
const riposteOn = (target) => myPowers(S.me).some((x) => x.type === 'riposte' && x.target === target && Date.now() - x.t < COUNTER_MS);
function riposteLeft() {
  const x = myPowers(S.me).filter((y) => y.type === 'riposte').sort((a, b) => b.t - a.t)[0];
  return x ? { left: Math.max(0, x.t + COUNTER_MS - Date.now()), target: x.target } : { left: 0 };
}
function onPowers(id, data) {
  S.powers[id] = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId) return;
  for (const x of data.list) {
    const me = id === S.me, who = me ? 'Tu' : `<b>${esc(nameOf(id))}</b>`;
    const whoA = me ? 'Tu' : anonHidden(id) ? 'Un fugitif' : who;
    const html = x.type === 'jam'
      ? `🌫️ ${whoA} ${me ? 'brouilles ta' : 'brouille sa'} prochaine révélation.`
      : x.type === 'riposte'
        ? `↩️ ${whoA} ${me ? 'ripostes' : 'riposte'} au radar : ${me ? 'tu vois' : 'il voit'} ${x.target === S.me ? '<b>ta position</b>' : `<b>${esc(nameOf(x.target))}</b>`} pendant 30 s !`
        : `🔍 ${whoA} ${me ? 'lances' : 'lance'} un contre-radar : ${me ? 'tu vois' : 'il voit'} les chasseurs pendant 30 s !`;
    const fresh = Date.now() - x.t < 30000 && !S.logKeys.has('pw:' + id + ':' + x.t);
    addLog('pw:' + id + ':' + x.t, x.t, html, { notify: true });
    if (fresh && !me && roleOf(S.me) === 'H') {
      beep('info');
      const n = anonHidden(id) ? 'Un fugitif' : nameOf(id);
      if (x.type === 'riposte') { if (x.target === S.me) { beep('alarm'); toast(`↩️ ${n} a riposté : il voit ta position 30 s !`, 4500); } }
      else toast(x.type === 'jam' ? `🌫️ ${n} brouille sa prochaine révélation` : `🔍 ${n} vous voit pendant 30 s !`, 4000);
    }
  }
}
async function useRiposte() {
  const lp = riposteAvailable();
  if (!lp) return;
  const entry = { type: 'riposte', t: Date.now(), target: lp.by, pingT: lp.t };
  const data = { gameId: S.cfg.gameId, list: [...myPowers(S.me), entry] };
  S.powers[S.me] = data;
  await pub('pw/' + S.me, data, { retain: true });
  onPowers(S.me, data);
  setTimeout(() => { if (markers[lp.by] && gameMap) gameMap.setView(markers[lp.by].getLatLng(), Math.max(gameMap.getZoom(), 16)); }, 500);
  scheduleRender();
}
async function usePower(type) {
  const ph = phase(), r = S.cfg.rules;
  const left = (type === 'jam' ? r.jams : r.counters) - powersUsed(S.me, type);
  if (left <= 0 || ph.name !== 'hunt') return;
  const ok = type === 'jam'
    ? await confirmBox('Brouiller ta prochaine révélation ?', 'Les chasseurs ne recevront pas ta position à la prochaine révélation (ils sauront qu’elle est brouillée). Les radars marchent quand même.', '🌫️ Brouiller')
    : await confirmBox('Lancer un contre-radar ?', 'Tu vois tous les chasseurs sur la carte pendant 30 s. Ils seront prévenus.', '🔍 Lancer');
  if (!ok) return;
  const entry = { type, t: Date.now() };
  if (type === 'jam') entry.idx = ph.k + 1;
  const data = { gameId: S.cfg.gameId, list: [...myPowers(S.me), entry] };
  S.powers[S.me] = data;
  await pub('pw/' + S.me, data, { retain: true });
  onPowers(S.me, data);
  if (type === 'counter' && gameMap) setTimeout(fitAll, 400);
  scheduleRender();
}

/* ---------- notifications ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then((r) => { S.swReg = r; }).catch(() => {});
/** Notification système, seulement quand la page est en arrière-plan (sinon le toast suffit). */
function notify(title, body) {
  try {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted' || !S.swReg) return;
    S.swReg.showNotification(title, { body, tag: 'traque-' + title, renotify: true, vibrate: [200, 100, 200], icon: 'icon-192.png' });
  } catch { /* pas de notification */ }
}

/* ---------- rappels appli fermée (ntfy.sh) ---------- */
function ntfyCfg() {
  let n = store.get('traque.ntfy');
  if (!n || !n.topic) { n = { topic: 'traque-' + randStr(14), on: false }; store.set('traque.ntfy', n); }
  return n;
}
async function ntfySend(topic, title, msg, at) {
  const u = new URL('https://ntfy.sh/' + encodeURIComponent(topic));
  u.searchParams.set('title', title);
  u.searchParams.set('tags', 'round_pushpin');
  u.searchParams.set('priority', 'high');
  u.searchParams.set('click', location.origin + location.pathname);
  if (at) u.searchParams.set('at', String(Math.floor(at / 1000)));
  const res = await fetch(u, { method: 'POST', body: msg });
  if (!res.ok) throw new Error('ntfy ' + res.status);
}
/** Programme chez ntfy un rappel 1 min avant chaque révélation de la partie (une seule fois). */
async function scheduleReminders() {
  const n = store.get('traque.ntfy');
  if (!n || !n.on || !S.cfg || S.cfg.status !== 'running' || isCaught(S.me)) return;
  const key = 'traque.ntfy.done.' + S.cfg.gameId;
  if (store.get(key) || S.remindersBusy) return;
  S.remindersBusy = true; store.set(key, true);
  try {
    const r = S.cfg.rules, release = S.cfg.startAt + r.headStart * MIN, end = S.cfg.startAt + r.duration * MIN;
    let count = 0;
    for (let t = release; t < end && count < 40; t += r.interval * MIN) {
      const at = t - 60000;
      if (at - Date.now() < 20000) continue;
      await ntfySend(n.topic, '📍 Révélation dans 1 min', 'Ouvre Traque pour envoyer ta position.', at);
      count++;
    }
    if (count) addLog('ntfy:' + S.cfg.gameId, Date.now(), `🔔 ${count} rappel${count > 1 ? 's' : ''} programmé${count > 1 ? 's' : ''} sur ton téléphone.`);
  } catch {
    store.del(key);
    toast('🔔 Impossible de programmer les rappels (ntfy injoignable).');
  } finally { S.remindersBusy = false; }
}
function openReminders() {
  const n = ntfyCfg();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const body = `
    <p>Une page web fermée ne peut pas se réveiller toute seule. Pour être prévenu <b>1 min avant chaque révélation</b>, même appli fermée et téléphone verrouillé :</p>
    <ol class="steps">
      <li>Installe l'appli gratuite <b>ntfy</b> (Play Store ou App Store).</li>
      <li>Dans ntfy, appuie sur <b>+</b> et abonne-toi à ce sujet :<br><code class="topic">${esc(n.topic)}</code> <button class="btn small" data-ntfy="copy">Copier</button></li>
      <li>Active les rappels ici, puis envoie un test.</li>
    </ol>
    <label class="check rem-toggle"><input type="checkbox" data-ntfy="on" ${n.on ? 'checked' : ''}> Rappels activés (quand je suis fugitif)</label>
    <div class="rem-actions">
      <button class="btn small" data-ntfy="test">Envoyer un test</button>
      ${perm === 'default' ? '<button class="btn small" data-ntfy="perm">Autoriser les notifications de la page</button>' : ''}
    </div>
    <p class="hint">Le sujet est secret et propre à ton téléphone. Les rappels passent par ntfy.sh (gratuit, sans compte) et ne contiennent ni ton nom ni ta position. Ils sont programmés au lancement de la partie : si elle s'arrête plus tôt, les rappels restants arrivent quand même.</p>`;
  ask('🔔 Rappels appli fermée', body, [{ label: 'Fermer', value: null, cls: 'primary' }]);
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ntfy]');
  if (!b || b.type === 'checkbox') return;
  const n = ntfyCfg(), act = b.dataset.ntfy;
  if (act === 'copy') { try { await navigator.clipboard.writeText(n.topic); toast('Sujet copié !'); } catch { prompt('Copie ce sujet :', n.topic); } }
  else if (act === 'test') {
    try { await ntfySend(n.topic, '✅ Test Traque', 'Les rappels marchent !'); toast('Test envoyé : regarde l’appli ntfy.'); } catch { toast('Envoi impossible : vérifie ta connexion.'); }
  } else if (act === 'perm') {
    try { await Notification.requestPermission(); b.remove(); } catch { /* refus */ }
  }
});
document.addEventListener('change', (e) => {
  const b = e.target.closest('[data-ntfy="on"]');
  if (!b) return;
  const n = ntfyCfg(); n.on = b.checked; store.set('traque.ntfy', n);
  if (n.on && S.cfg && S.cfg.status === 'running' && roleOf(S.me) === 'F') scheduleReminders();
  toast(n.on ? '🔔 Rappels activés' : 'Rappels désactivés');
});

async function shareLink() {
  const url = `${location.origin}${location.pathname}#join=${S.code}&b=${S.b}`;
  const text = `Rejoins ma partie de Traque (code ${S.code})`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Traque', text, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Lien copié !'); } catch { prompt('Copie ce lien :', url); }
}

/* ---------- cartes ---------- */
/* Fonds de carte en haute définition ({r} = tuiles @2x sur les écrans de téléphone). */
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const MAP_STYLES = {
  plan: { name: 'Plan', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', opts: { subdomains: 'abcd', maxZoom: 20 }, attr: OSM_ATTR + ' · © <a href="https://carto.com/attributions">CARTO</a>' },
  sombre: { name: 'Sombre', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts: { subdomains: 'abcd', maxZoom: 20 }, attr: OSM_ATTR + ' · © <a href="https://carto.com/attributions">CARTO</a>' },
  satellite: { name: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 19, maxZoom: 20 }, attr: '© Esri, Maxar, Earthstar Geographics' },
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19 }, attr: OSM_ATTR },
};
let mapStyle = store.get('traque.map') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'plan');
if (!MAP_STYLES[mapStyle]) mapStyle = 'plan';
/** Petit bouton ⓘ à la place du gros bandeau de crédits (les crédits restent consultables). */
const InfoControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const d = L.DomUtil.create('div', 'map-info');
    d.innerHTML = '<span class="map-info-text"></span><button type="button" aria-label="Crédits de la carte">ⓘ</button>';
    L.DomEvent.disableClickPropagation(d);
    d.querySelector('button').onclick = () => d.classList.toggle('open');
    this._text = d.querySelector('.map-info-text');
    return d;
  },
  setText(html) { if (this._text) this._text.innerHTML = html; },
});
function setupMap(map) {
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map._info = new InfoControl().addTo(map);
  applyStyle(map);
}
function applyStyle(map) {
  const st = MAP_STYLES[mapStyle];
  if (map._tiles) map._tiles.remove();
  map._tiles = L.tileLayer(st.url, { ...st.opts, detectRetina: false }).addTo(map);
  map._tiles.bringToBack();
  map._info.setText(st.attr);
  document.body.classList.toggle('map-dark', mapStyle !== 'plan' && mapStyle !== 'osm');
}
function cycleMapStyle() {
  const keys = Object.keys(MAP_STYLES);
  mapStyle = keys[(keys.indexOf(mapStyle) + 1) % keys.length];
  store.set('traque.map', mapStyle);
  for (const m of [lobbyMap, gameMap]) if (m) applyStyle(m);
  toast('🗺️ Carte : ' + MAP_STYLES[mapStyle].name, 1800);
}
let lobbyMap, lobbyZone, lobbyMe, gameMap, gameZone, selfMarker, selfAcc;
let lobbyZoneKey = '', gameZoneKey = '', nextZoneLayer = null, nextZoneKey = '';
const fuzzLayers = {};
let histLayer = null;

/** Points d'un cercle géographique (pour pouvoir griser tout ce qui est dehors). */
function circlePts(z, n = 120) {
  const R = 6371000, r = Math.PI / 180, lat1 = z.lat * r, lng1 = z.lng * r, d = z.r / R, pts = [];
  for (let i = 0; i < n; i++) {
    const b = (2 * Math.PI * i) / n;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
    const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    pts.push([lat2 / r, lng2 / r]);
  }
  return pts;
}
/** Dessine la zone : extérieur assombri, liseré blanc et trait orange épais. Renvoie le groupe (ou null). */
/** Prison (🔒) et zones interdites (⛔), dessinées sur une carte. */
function drawExtras(map, group, rules) {
  if (group) group.remove();
  const g = L.layerGroup();
  for (const n of rules.nogo || []) {
    L.circle([n.lat, n.lng], { radius: n.r, color: '#c92a2a', weight: 3, dashArray: '6 5', fillColor: '#e03131', fillOpacity: 0.28, interactive: false }).addTo(g);
    L.marker([n.lat, n.lng], { interactive: false, icon: L.divIcon({ className: 'pm', html: '<div class="spot">⛔</div>', iconSize: [0, 0] }) }).addTo(g);
  }
  if (rules.prison) {
    const pr = rules.prison;
    L.circle([pr.lat, pr.lng], { radius: pr.r, color: '#212529', weight: 3, dashArray: '4 4', fillColor: '#495057', fillOpacity: 0.3, interactive: false }).addTo(g);
    L.marker([pr.lat, pr.lng], { interactive: false, icon: L.divIcon({ className: 'pm', html: '<div class="spot">🔒</div><div class="pin-label">Prison</div>', iconSize: [0, 0] }) }).addTo(g);
  }
  return g.addTo(map);
}
const extrasKey = (r) => JSON.stringify([r.prison, r.nogo]);
let lobbyExtras = null, lobbyExtrasKey = '', gameExtras = null, gameExtrasKey = '';
const zoneColor = () => ZONE_COLORS[(S.cfg && S.cfg.rules.zoneColor) || 'orange'] || ZONE_COLORS.orange;
function drawZone(map, group, z) {
  if (group) group.remove();
  if (!z) return null;
  const ring = circlePts(z);
  const world = [[-89, -540], [89, -540], [89, 540], [-89, 540]];
  const g = L.layerGroup([
    L.polygon([world, ring], { stroke: false, fillColor: '#10121a', fillOpacity: 0.32, interactive: false, smoothFactor: 0 }),
    L.circle([z.lat, z.lng], { radius: z.r, color: '#ffffff', weight: 10, opacity: 0.95, fill: false, interactive: false }),
    L.circle([z.lat, z.lng], { radius: z.r, color: zoneColor(), weight: 5, opacity: 1, fill: false, interactive: false }),
  ]).addTo(map);
  g.bounds = L.latLng(z.lat, z.lng).toBounds(z.r * 2);
  return g;
}
const zoneKey = (z) => (z ? z.lat.toFixed(5) + ',' + z.lng.toFixed(5) + ',' + Math.round(z.r) + ',' + zoneColor() : '');
/** Met à jour la zone en vigueur et le pointillé de la prochaine zone sur la carte de jeu. */
function updateGameZone() {
  if (!gameMap || !S.cfg) return;
  const zs = S.cfg.status === 'lobby' ? null : zoneState();
  const cur = zs ? zs.cur : null;
  if (zoneKey(cur) !== gameZoneKey) { gameZoneKey = zoneKey(cur); gameZone = drawZone(gameMap, gameZone, cur); }
  const next = zs && zs.next && !outcome() ? zs.next : null;
  if (zoneKey(next) !== nextZoneKey) {
    nextZoneKey = zoneKey(next);
    if (nextZoneLayer) { nextZoneLayer.remove(); nextZoneLayer = null; }
    if (next) nextZoneLayer = L.circle([next.lat, next.lng], { radius: next.r, color: '#ffffff', weight: 3, dashArray: '10 8', fill: false, interactive: false }).addTo(gameMap);
  }
}
/** Flèche de direction autour d'un marqueur. */
const headingHtml = (h, cls) => (h == null ? '' : `<div class="hdg ${cls}" style="transform:rotate(${Math.round(h)}deg)"><i></i></div>`);
const markers = {};
let didFit = false;

function ensureLobbyMap() {
  if (lobbyMap) return;
  lobbyMap = L.map('lobby-map', { zoomControl: true, attributionControl: false }).setView([46.6, 2.4], 5);
  setupMap(lobbyMap);
  lobbyMap.on('click', (e) => {
    if (!isHost()) return;
    const pt = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
    if (S.mapMode === 'prison') { pubRules({ prison: { ...pt, r: PRISON_R } }); return; }
    if (S.mapMode === 'nogo') {
      const list = S.cfg.rules.nogo || [];
      const hit = list.findIndex((n) => dist(n, pt) <= n.r);
      if (hit >= 0) pubRules({ nogo: list.filter((_, i) => i !== hit) });
      else if (list.length >= 8) toast('8 zones interdites au maximum.');
      else pubRules({ nogo: [...list, { ...pt, r: +$('#nogo-r').value }] });
      return;
    }
    const r = (S.cfg.rules.zone && S.cfg.rules.zone.r) || 1000;
    pubRules({ zone: { ...pt, r } });
  });
}
let lobbyCentered = false;
function renderLobbyMap() {
  ensureLobbyMap();
  const z = S.cfg && S.cfg.rules.zone;
  if (zoneKey(z) !== lobbyZoneKey) { lobbyZoneKey = zoneKey(z); lobbyZone = drawZone(lobbyMap, lobbyZone, z); }
  if (S.cfg && extrasKey(S.cfg.rules) !== lobbyExtrasKey) { lobbyExtrasKey = extrasKey(S.cfg.rules); lobbyExtras = drawExtras(lobbyMap, lobbyExtras, S.cfg.rules); }
  if (S.fix) {
    if (!lobbyMe) lobbyMe = L.marker([S.fix.lat, S.fix.lng], { interactive: false, icon: L.divIcon({ className: 'pm', html: '<div class="me-dot"></div>', iconSize: [0, 0] }) }).addTo(lobbyMap);
    lobbyMe.setLatLng([S.fix.lat, S.fix.lng]);
  }
  if (!lobbyCentered && (z || S.fix)) {
    lobbyCentered = true;
    if (z) lobbyMap.fitBounds(lobbyZone.bounds, { padding: [10, 10] });
    else lobbyMap.setView([S.fix.lat, S.fix.lng], 15);
  }
}

function ensureGameMap() {
  if (gameMap) return;
  gameMap = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0.5 }).setView([46.6, 2.4], 5);
  setupMap(gameMap);
}
function updateSelfMarker() {
  if (!gameMap || !S.fix) return;
  const ll = [S.fix.lat, S.fix.lng];
  const cls = roleOf(S.me) === 'F' ? 'F' : '';
  const icon = L.divIcon({ className: 'pm', html: `${headingHtml(myHeading(), 'me ' + cls)}<div class="me-dot ${cls}"></div>${S.emoji ? `<div class="me-emoji">${esc(S.emoji)}</div>` : ''}`, iconSize: [0, 0] });
  if (!selfMarker) {
    selfAcc = L.circle(ll, { radius: S.fix.acc, color: '#1971c2', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(gameMap);
    selfMarker = L.marker(ll, { zIndexOffset: 1000, icon }).addTo(gameMap);
  }
  selfMarker.setLatLng(ll); selfAcc.setLatLng(ll); selfAcc.setRadius(S.fix.acc);
  selfMarker.setIcon(icon);
}
/** Position d'un autre joueur que j'ai le droit de voir, ou null. */
function visiblePos(id) {
  const p = S.pos[id];
  if (!p || !S.cfg || p.gameId !== S.cfg.gameId || id === S.me) return null;
  if (p.kind === 'live') {
    if (roleOf(id) !== 'H') return null;
    const ended = !!outcome();
    if (roleOf(S.me) === 'F' && !S.cfg.rules.fugitivesSeeHunters && !ended && !counterActive(S.me) && !riposteOn(id)) return null;
  }
  return p;
}
function renderGameMap() {
  ensureGameMap();
  const z = S.cfg.rules.zone;
  updateGameZone();
  if (extrasKey(S.cfg.rules) !== gameExtrasKey) { gameExtrasKey = extrasKey(S.cfg.rules); gameExtras = drawExtras(gameMap, gameExtras, S.cfg.rules); }
  updateSelfMarker();

  // Cercles des fugitifs (le mien aussi, pour savoir ce que voient les chasseurs)
  const circles = {};
  for (const id of Object.keys(S.players)) {
    const p = id === S.me ? S.pos[id] : visiblePos(id);
    if (p && p.r && p.gameId === S.cfg.gameId && p.kind !== 'live' && p.kind !== 'final' && !isCaught(id)) circles[id] = p;
  }
  for (const [id, p] of Object.entries(circles)) {
    const mineC = id === S.me;
    const style = { radius: p.r, color: mineC ? '#1971c2' : '#e03131', weight: 3, dashArray: mineC ? '4 6' : null, fillColor: mineC ? '#1971c2' : '#e03131', fillOpacity: mineC ? 0.06 : 0.14, interactive: false };
    if (!fuzzLayers[id]) fuzzLayers[id] = L.circle([p.lat, p.lng], style).addTo(gameMap);
    else { fuzzLayers[id].setLatLng([p.lat, p.lng]); fuzzLayers[id].setStyle(style); fuzzLayers[id].setRadius(p.r); }
  }
  for (const id of Object.keys(fuzzLayers)) if (!circles[id]) { fuzzLayers[id].remove(); delete fuzzLayers[id]; }

  // Historique : anciennes positions révélées, reliées par un pointillé
  if (histLayer) histLayer.remove();
  histLayer = L.layerGroup();
  for (const [id, h] of Object.entries(S.hist)) {
    if (!(id === S.me ? baseRole(S.me) === 'F' : visiblePos(id) || outcome())) continue;
    if (h.length < 2) continue;
    const col = id === S.me ? '#1971c2' : '#e03131';
    L.polyline(h.map((x) => [x.lat, x.lng]), { color: col, weight: 2, opacity: 0.55, dashArray: '2 7', interactive: false }).addTo(histLayer);
    h.slice(0, -1).forEach((x, i) => {
      L.circleMarker([x.lat, x.lng], { radius: 4, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 0.35 + (0.4 * i) / h.length, interactive: false }).addTo(histLayer);
    });
  }
  histLayer.addTo(gameMap);

  const seen = new Set();
  for (const id of Object.keys(S.players)) {
    const p = visiblePos(id);
    if (!p) continue;
    seen.add(id);
    const role = p.kind === 'live' ? 'H' : 'F';
    const age = Date.now() - p.t;
    const old = p.kind === 'live' ? age > 90000 : false;
    const label = esc(anonHidden(id) ? '❓ ' + (role === 'F' ? 'Fugitif' : 'Chasseur') : nameOf(id)) + (p.kind === 'live' ? '' : ' · ' + (age < 45000 ? 'maintenant' : ago(p.t).replace('il y a ', ''))) + (p.r ? ` · cercle n°${p.lvl || 1} ≈${fmtDist(p.r)}` : '');
    const html = `${old ? '' : headingHtml(p.hdg, role)}<div class="pin ${role} ${old ? 'old' : ''} ${p.r ? 'fuzzy' : ''}">${anonHidden(id) ? '?' : esc(avatarOf(id) || nameOf(id).slice(0, 1).toUpperCase())}</div><div class="pin-label">${label}</div>`;
    const icon = L.divIcon({ className: 'pm', html, iconSize: [0, 0] });
    if (!markers[id]) markers[id] = L.marker([p.lat, p.lng], { icon }).addTo(gameMap);
    else { markers[id].setLatLng([p.lat, p.lng]); markers[id].setIcon(icon); }
    markers[id].setZIndexOffset(role === 'F' ? 500 : 0);
  }
  for (const id of Object.keys(markers)) if (!seen.has(id)) { markers[id].remove(); delete markers[id]; }

  if (!didFit && (z || S.fix)) { didFit = true; fitAll(); }
}
function fitAll() {
  if (!gameMap) return;
  const pts = [];
  if (S.fix) pts.push([S.fix.lat, S.fix.lng]);
  for (const m of Object.values(markers)) pts.push(m.getLatLng());
  let bounds = pts.length ? L.latLngBounds(pts) : null;
  if (gameZone) bounds = bounds ? bounds.extend(gameZone.bounds) : gameZone.bounds;
  if (!bounds) return;
  const top = $('#hud').getBoundingClientRect().bottom + 10;
  const bottom = $('#sheet').getBoundingClientRect().height + 10;
  if (pts.length === 1 && !gameZone) gameMap.setView(pts[0], 16);
  else gameMap.fitBounds(bounds, { paddingTopLeft: [20, top], paddingBottomRight: [20, bottom], maxZoom: 17 });
}

/* ---------- rendu ---------- */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
function route() {
  if (!S.cfg) return;
  const want = S.cfg.status === 'lobby' ? 'lobby' : 'game';
  if (S.screen !== want) {
    if (want === 'game') { didFit = false; S.endDismissed = false; }
    show(want);
  }
  scheduleRender();
}
function render() {
  if (!S.cfg || !S.room) return;
  const gq = gpsQuality();
  for (const id of ['#gps-lobby', '#gps-game']) { const el = $(id); if (el.textContent !== gq.txt) el.textContent = gq.txt; el.className = 'gps ' + gq.cls; }
  for (const id of ['#conn-lobby', '#conn-game']) {
    $(id).classList.toggle('ok', S.connected);
    $(id).title = S.connected ? 'Connecté' : 'Reconnexion…';
  }
  if (S.screen === 'lobby') renderLobby();
  if (S.screen === 'game') renderGame();
}
const ROLE_LABEL = { F: '🏃 Fugitif', H: '🔦 Chasseur', S: '👀 Spectateur' };
function sortedPlayers() {
  return Object.keys(S.players).sort((a, b) =>
    (S.online[b] ? 1 : 0) - (S.online[a] ? 1 : 0) || nameOf(a).localeCompare(nameOf(b), 'fr'));
}

function renderLobby() {
  const c = S.cfg, host = isHost(), ids = sortedPlayers();
  $('#lobby-code').textContent = S.code;
  $('#lobby-count').textContent = `(${ids.length})`;
  $('#lobby-players').innerHTML = ids.map((id) => {
    const role = baseRole(id);
    const meta = [id === c.host ? '⭐ organisateur' : '', S.online[id] ? '' : 'hors ligne'].filter(Boolean).join(' · ');
    return `<li class="player">
      <span class="dot ${S.online[id] ? 'on' : ''}"></span>
      <div class="who"><div class="pname">${esc(avatarOf(id))} ${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''} ${battHtml(id)}</div>${meta ? `<div class="pmeta">${meta}</div>` : ''}</div>
      <button class="role-chip role-${role}" data-role="${esc(id)}" ${host ? '' : 'disabled'}>${ROLE_LABEL[role]}</button>
      ${host && id !== S.me ? `<button class="kick" data-kick="${esc(id)}" aria-label="Retirer ${esc(nameOf(id))}">✕</button>` : ''}
    </li>`;
  }).join('');
  const nF = ids.filter((id) => baseRole(id) === 'F').length, nH = ids.filter((id) => baseRole(id) === 'H').length;
  $('#lobby-roles-hint').textContent = `${nF} fugitif${nF > 1 ? 's' : ''}, ${nH} chasseur${nH > 1 ? 's' : ''}` + (host ? ' · touche un rôle pour le changer.' : '');

  // Tirage au sort
  const box = $('#draw-box');
  if (host && ids.length >= 2) {
    if (!box.dataset.n || +box.dataset.n !== ids.length) {
      box.dataset.n = ids.length;
      const opts = [];
      for (let i = 1; i < ids.length; i++) opts.push(`<option value="${i}">${i} fugitif${i > 1 ? 's' : ''}</option>`);
      box.innerHTML = `<select id="draw-n" aria-label="Nombre de fugitifs">${opts.join('')}</select><button class="btn small" id="btn-draw">🎲 Tirer au sort</button>`;
    }
  } else { box.innerHTML = ''; box.dataset.n = ''; }

  // Règles
  for (const el of document.querySelectorAll('[data-rule]')) {
    el.disabled = !host;
    if (document.activeElement === el) continue;
    const v = c.rules[el.dataset.rule];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  // Zone
  const z = c.rules.zone;
  $('#zone-ctrl').hidden = !host;
  const shrinkTxt = z && c.rules.shrink > 0 ? ` Elle rétrécira jusqu'à ${fmtDist(z.r * c.rules.shrink / 100)}, une étape toutes les ${minutesLabel(c.rules.shrinkEvery)}.` : '';
  $('#zone-hint').textContent = z
    ? `Cercle de ${fmtDist(z.r)} de rayon.` + shrinkTxt + (host ? ' Touche la carte pour déplacer le centre.' : '')
    : (host ? 'Aucune zone pour l’instant. Touche la carte ou « Centrer sur moi » pour en créer une.' : 'Pas de zone définie : on joue partout.');
  const rr = $('#zone-r');
  if (document.activeElement !== rr) rr.value = z ? z.r : 1000;
  $('#zone-r-val').textContent = fmtDist(z ? z.r : +rr.value);
  $('#btn-zone-clear').hidden = !z;
  const r0 = c.rules;
  const extra = [r0.prison ? '🔒 Prison placée.' : '', (r0.nogo || []).length ? `⛔ ${r0.nogo.length} zone${r0.nogo.length > 1 ? 's' : ''} interdite${r0.nogo.length > 1 ? 's' : ''}.` : ''].filter(Boolean).join(' ');
  if (extra) $('#zone-hint').textContent += ' ' + extra;
  $('#map-mode').hidden = !host; $('#zone-extra').hidden = !host; $('#zone-saved-box').hidden = !host;
  $('#map-mode-hint').hidden = !host;
  $('#map-mode-hint').textContent = {
    zone: 'Touche la carte pour placer le centre de la zone.',
    prison: `Touche la carte pour placer la prison (cercle de ${PRISON_R} m). Un fugitif attrapé y va ; un fugitif libre qui y entre libère tout le monde.`,
    nogo: 'Touche la carte pour ajouter une zone interdite ; touche-en une pour l’enlever. Y entrer révèle la position comme une sortie de zone.',
  }[S.mapMode || 'zone'];
  for (const b of document.querySelectorAll('#map-mode [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === (S.mapMode || 'zone')));
  $('#nogo-r-box').hidden = (S.mapMode || 'zone') !== 'nogo';
  $('#btn-prison-clear').hidden = !r0.prison;
  $('#btn-nogo-clear').hidden = !(r0.nogo || []).length;
  renderSavedZones();
  renderLobbyMap();

  // Lancement
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = !(nF && nH);
  $('#start-hint').textContent = host
    ? (nF && nH ? 'Tout le monde est prêt ? Vérifiez que chacun a autorisé la localisation.' : 'Il faut au moins un fugitif et un chasseur.')
    : `En attente que ${nameOf(c.host)} lance la partie…`;
  $('#btn-become-host').hidden = host;
  if (S.geoErr) $('#start-hint').textContent += ' ⚠️ Ta localisation est bloquée : autorise-la dans les réglages du navigateur.';
}

function renderGame() {
  const c = S.cfg, ph = phase(), out = outcome(), role = roleOf(S.me), now = Date.now();
  renderHud(ph, out, role, now);

  // Bandeau
  const banner = $('#banner');
  let bannerText = '', bannerInfo = false;
  if (!out && c.status === 'running') {
    if (S.geoErr === 'denied') bannerText = '📍 Localisation refusée : autorise-la pour cette page, sinon personne ne te verra.';
    else if (S.geoErr) bannerText = '📍 Position introuvable pour l’instant…';
    else if (outOfZone() === 'nogo') bannerText = role === 'F' ? '⛔ Zone interdite ! Sors-en, ta position est révélée.' : '⛔ Tu es dans une zone interdite !';
    else if (outOfZone()) bannerText = role === 'F' ? '🚧 Tu es hors zone ! Ta position est révélée.' : '🚧 Tu es hors zone !';
    else if (baseRole(S.me) === 'F' && isCaught(S.me) && c.rules.prison) {
      const d = S.fix ? dist(S.fix, c.rules.prison) : null;
      bannerText = d != null && d <= c.rules.prison.r + 15 ? '🔒 Tu es en prison. Attends qu’un fugitif vienne te libérer.' : `🔒 Va à la prison${d != null ? ` (à ${fmtDist(d)})` : ''} et attends qu’on te libère.`;
      bannerInfo = true;
    }
    else if (!S.connected) { bannerText = 'Connexion perdue, reconnexion…'; bannerInfo = true; }
    else if (role === 'F' && counterActive(S.me)) { bannerText = `🔍 Contre-radar : tu vois les chasseurs encore ${Math.ceil(counterLeft(S.me) / 1000)} s`; bannerInfo = true; }
    else if (role === 'F' && riposteLeft().left > 0) { const rl = riposteLeft(); bannerText = `↩️ Riposte : tu vois ${dn(rl.target)} encore ${Math.ceil(rl.left / 1000)} s`; bannerInfo = true; }
  }
  banner.hidden = !bannerText; banner.textContent = bannerText; banner.classList.toggle('info', bannerInfo);
  if (bannerText) banner.style.top = ($('#hud').getBoundingClientRect().bottom + 8) + 'px';

  // Actions
  let acts = '';
  if (!out && c.status === 'running') {
    if (role === 'F') {
      const hunting = ph.name === 'hunt';
      const jl = c.rules.jams - powersUsed(S.me, 'jam'), cl = c.rules.counters - powersUsed(S.me, 'counter');
      if (c.rules.jams > 0) acts += `<button class="btn" data-act="jam" ${jl > 0 && hunting && ph.nextReveal ? '' : 'disabled'}>🌫️ Brouillage (${jl})</button>`;
      if (c.rules.counters > 0) acts += `<button class="btn" data-act="counter" ${cl > 0 && hunting && !counterActive(S.me) ? '' : 'disabled'}>🔍 Contre-radar (${cl})</button>`;
      if (riposteAvailable()) acts = `<button class="btn primary" data-act="riposte">↩️ Riposte : voir qui t'a radaré</button>` + acts;
      acts += '<button class="btn fug" data-act="caught-self">Je me suis fait attraper</button>';
    }
    else if (role === 'H') {
      const left = c.rules.pings - pingTimes().length;
      const hunting = ph.name === 'hunt';
      if (c.rules.pings > 0) acts += `<button class="btn" data-act="ping" ${left > 0 && hunting ? '' : 'disabled'}>📡 Radar (${left})</button>`;
      acts += `<button class="btn hunt" data-act="catch" ${hunting ? '' : 'disabled'}>🎯 J’ai attrapé…</button>`;
    }
  }
  const actions = $('#actions');
  if (actions.dataset.html !== acts) { actions.dataset.html = acts; actions.innerHTML = acts; }
  actions.hidden = !acts;

  // Joueurs
  const ids = sortedPlayers().filter((id) => c.roles[id] || S.online[id]);
  ids.sort((a, b) => 'FHS'.indexOf(roleOf(a)) - 'FHS'.indexOf(roleOf(b)));
  $('#game-players').innerHTML = ids.map((id) => {
    const r = roleOf(id), base = baseRole(id), caught = base === 'F' && isCaught(id);
    const p = anonHidden(id) ? null : visiblePos(id);
    const meta = [];
    if (caught) {
      const k = S.caught[id];
      meta.push(`attrapé·e${k.by ? ' par ' + esc(nameOf(k.by)) : ''} à ${hhmm(k.t)}`);
    }
    if (p) {
      let s = (p.kind === 'live' ? 'en direct' : 'vu·e ' + ago(p.t));
      if (S.fix && p.r) {
        const d = dist(S.fix, p);
        s += ` · cercle de ${fmtDist(p.r)} · ` + (d <= p.r ? '<b>tu es dans son cercle !</b>' : 'à ' + fmtDist(d - p.r));
      } else if (S.fix) s += ' · à ' + fmtDist(dist(S.fix, p));
      if (p.hdg != null) s += ' · va vers ' + compass(p.hdg);
      if (p.spd >= 0.5) s += ' · ' + kmh(p.spd);
      meta.push(s);
    } else if (id === S.me && base === 'F' && !caught) {
      const mp = S.pos[S.me];
      meta.push(mp && mp.gameId === c.gameId && mp.kind !== 'live'
        ? `dernière révélation ${ago(mp.t)}${mp.r ? ` · cercle n°${mp.lvl || 1} (${fmtDist(mp.r)})` : ''}`
        : 'pas encore révélé·e');
    } else if (base === 'F' && !caught && id !== S.me) meta.push(anonHidden(id) ? 'mode anonyme' : 'position cachée');
    if (caught && S.cfg.rules.prison) meta.push('🔒 en prison');
    if (id === S.me && S.fix && mySpeed() >= 0.5) meta.push(kmh(mySpeed()));
    if (!S.online[id]) meta.push('hors ligne');
    const chip = caught && r !== 'H' ? (c.rules.prison ? '🔒 Prison' : 'Attrapé·e') : ROLE_LABEL[r];
    return `<li class="player ${caught ? 'caught' : ''} ${p ? 'clickable' : ''}" ${p ? `data-focus="${esc(id)}"` : ''}>
      <span class="dot ${S.online[id] ? 'on' : ''}"></span>
      <div class="who"><div class="pname">${esc(avatarOf(id))} ${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''} ${battHtml(id)}</div><div class="pmeta">${meta.join(' · ') || '&nbsp;'}</div></div>
      ${isHost() && caught && !out ? `<button class="btn small ghost" data-uncatch="${esc(id)}">Annuler</button>` : ''}
      <span class="role-chip role-${caught && r !== 'H' ? 'S' : r}">${chip}</span>
    </li>`;
  }).join('');

  let tools = '';
  if (isHost()) {
    tools = out || c.status === 'ended'
      ? '<button class="btn small" data-act="lobby">Retour au salon</button>'
      : '<button class="btn small danger" data-act="end">Terminer la partie</button>';
  } else if (!S.online[c.host]) tools = '<button class="btn small ghost" data-act="become-host">L’organisateur est hors ligne : prendre le relais</button>';
  tools += '<button class="btn small ghost" data-act="reminders">🔔 Rappels</button><button class="btn small ghost" data-act="leave">Quitter</button>';
  const ht = $('#host-tools');
  if (ht.dataset.html !== tools) { ht.dataset.html = tools; ht.innerHTML = tools; }

  // Journal
  const log = $('#log');
  const html = S.log.slice().reverse().map((e) => `<li><time>${hhmm(e.t)}</time><span>${e.html}</span></li>`).join('');
  if (log.dataset.n !== String(S.log.length)) { log.dataset.n = String(S.log.length); log.innerHTML = html; }
  if (S.tab === 'log') S.logSeen = S.log.length;
  const unread = S.log.length - S.logSeen;
  $('#log-unread').hidden = unread <= 0; $('#log-unread').textContent = unread;

  renderGameMap();
  renderEnd(out);
}

function renderHud(ph, out, role, now) {
  const caught = baseRole(S.me) === 'F' && isCaught(S.me);
  const badge = $('#hud-role');
  badge.textContent = caught && role !== 'H' ? (S.cfg.rules.prison ? '🔒 En prison' : 'Attrapé·e') : ROLE_LABEL[role];
  badge.className = 'badge role-' + (caught && role !== 'H' ? 'S' : role);
  const count = $('#hud-count');
  let phaseText = '', countText = '', sub = '', hot = false;
  if (out) {
    phaseText = 'Partie terminée';
    countText = out.winner === 'F' ? '🏃 Fugitifs' : '🔦 Chasseurs';
    sub = 'gagnent !';
  } else if (ph.name === 'head') {
    phaseText = role === 'F' ? 'Cours ! Les chasseurs partent dans' : role === 'H' ? 'Reste sur place. Départ dans' : 'Avance des fugitifs';
    countText = clock(ph.release - now);
    sub = 'Fin de partie dans ' + clock(ph.end - now);
    hot = ph.release - now < 10000;
  } else if (ph.name === 'hunt') {
    const free = fugitives().filter((id) => !isCaught(id)).length;
    if (ph.nextReveal) {
      phaseText = role === 'F' ? 'Ta position sera révélée dans' : 'Prochaine révélation dans';
      countText = clock(ph.nextReveal - now);
      hot = ph.nextReveal - now <= 30000;
    } else {
      phaseText = 'Dernière ligne droite !';
      countText = clock(ph.end - now);
    }
    sub = `Fin dans ${clock(ph.end - now)} · ${free} fugitif${free > 1 ? 's' : ''} en fuite`;
  } else {
    phaseText = 'Partie terminée'; countText = '';
  }
  $('#hud-phase').textContent = phaseText;
  count.textContent = countText;
  count.classList.toggle('hot', hot);
  $('#hud-sub').textContent = sub;
  const zs = !out && ph.name === 'hunt' ? zoneState(now) : null;
  let zt = '';
  if (zs && zs.n) {
    if (zs.final) zt = `⭕ Zone finale · rayon ${fmtDist(zs.cur.r)}`;
    else if (zs.shrinking) zt = `⭕ La zone rétrécit… ${fmtDist(zs.cur.r)} → ${fmtDist(zs.next.r)}`;
    else zt = `⭕ Zone : rétrécit dans ${clock(zs.shrinkAt - now)}`;
  } else if (!out && ph.name === 'head' && zs === null) {
    const z0 = zoneState(now);
    if (z0 && z0.n) zt = `⭕ La zone rétrécira ${z0.n} fois`;
  }
  const hz = $('#hud-zone');
  hz.hidden = !zt; hz.textContent = zt;
  hz.classList.toggle('hot', !!(zs && (zs.shrinking || (zs.shrinkAt && zs.shrinkAt - now <= 30000))));
}

function renderEnd(out) {
  const el = $('#end');
  if (!out) { el.hidden = true; return; }
  const key = S.cfg.gameId + ':' + out.winner;
  if (S.lastOutcomeKey !== key) {
    S.lastOutcomeKey = key; S.endDismissed = false;
    addLog('end:' + S.cfg.gameId, out.at || Date.now(), out.winner === 'F' ? '🏁 Temps écoulé : victoire des fugitifs !' : '🏁 Victoire des chasseurs !');
    beep('good');
  }
  el.hidden = S.endDismissed;
  if (S.endDismissed) return;
  const c = S.cfg;
  $('#end-emoji').textContent = out.winner === 'F' ? '🏃' : '🔦';
  $('#end-title').textContent = out.winner === 'F' ? 'Les fugitifs gagnent !' : 'Les chasseurs gagnent !';
  $('#end-reason').textContent = out.reason === 'time' ? 'Le temps est écoulé.'
    : out.reason === 'all-caught' ? 'Tous les fugitifs ont été attrapés.'
      : out.reason === 'host' ? 'Partie arrêtée par l’organisateur.' : '';
  $('#end-recap').innerHTML = fugitives().map((id) => {
    const k = isCaught(id) ? S.caught[id] : null;
    const txt = k ? `attrapé·e${k.by ? ' par ' + esc(nameOf(k.by)) : ''} après ${clock(k.t - c.startAt)}` : 'jamais attrapé·e 🏆';
    return `<li>🏃 <b>${esc(nameOf(id))}</b> : ${txt}</li>`;
  }).join('');
  const acts = '<button class="btn" data-act="see-map">Voir la carte</button>' +
    (isHost() ? '<button class="btn primary" data-act="lobby">Rejouer (retour au salon)</button>' : `<p class="hint">${esc(nameOf(c.host))} peut relancer une partie.</p>`);
  const ea = $('#end-actions');
  if (ea.dataset.html !== acts) { ea.dataset.html = acts; ea.innerHTML = acts; }
}

/* ---------- branchements ---------- */
function needName() {
  const name = $('#name').value.trim().slice(0, 20);
  if (!name) { toast('Entre ton prénom d’abord.'); $('#name').focus(); return null; }
  store.set('traque.name', name);
  S.name = name;
  return name;
}
function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const code = (h.get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = h.get('b');
  return { code: code.length === 6 ? code : null, b: b != null && /^\d$/.test(b) ? +b : null };
}
function initHome() {
  $('#name').value = store.get('traque.name', '');
  S.emoji = store.get('traque.emoji') || EMOJIS[Math.floor(Math.random() * 8)];
  $('#emoji-pick').innerHTML = EMOJIS.map((e) => `<button type="button" role="radio" aria-checked="${e === S.emoji}" data-emoji="${e}">${e}</button>`).join('');
  const h = parseHash(), last = store.get('traque.last');
  if (h.code) $('#code').value = h.code;
  const resume = $('#btn-resume');
  if (last && last.code && !h.code) {
    resume.hidden = false; resume.textContent = `Reprendre la partie ${last.code}`;
  } else resume.hidden = true;
}

$('#emoji-pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b) return;
  S.emoji = b.dataset.emoji; store.set('traque.emoji', S.emoji);
  for (const x of document.querySelectorAll('#emoji-pick [data-emoji]')) x.setAttribute('aria-checked', String(x === b));
});
$('#btn-create').onclick = () => { if (needName()) enterRoom({ code: randStr(6, CODE_ALPHABET), create: true }); };
$('#btn-join').onclick = () => {
  if (!needName()) return;
  const code = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { toast('Le code fait 6 caractères.'); return; }
  const h = parseHash();
  enterRoom({ code, b: h.code === code ? h.b : null });
};
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#btn-resume').onclick = () => {
  if (!needName()) return;
  const last = store.get('traque.last');
  if (last) enterRoom({ code: last.code, b: last.b });
};

$('#btn-leave').onclick = async () => { if (await confirmBox('Quitter le salon ?', '', 'Quitter', 'danger')) leaveRoom(); };
$('#btn-share').onclick = shareLink;
$('#btn-qr').onclick = () => {
  const box = $('#qr');
  if (!box.hidden) { box.hidden = true; return; }
  const qr = qrcode(0, 'M');
  qr.addData(`${location.origin}${location.pathname}#join=${S.code}&b=${S.b}`);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  box.hidden = false;
};
$('#lobby-players').addEventListener('click', async (e) => {
  const r = e.target.closest('[data-role]');
  if (r && isHost()) {
    const id = r.dataset.role;
    const next = baseRole(id) === 'F' ? 'H' : 'F';
    await pubCfg({ roles: { ...S.cfg.roles, [id]: next } });
    return;
  }
  const k = e.target.closest('[data-kick]');
  if (k && isHost()) {
    const id = k.dataset.kick;
    if (!(await confirmBox(`Retirer ${nameOf(id)} ?`, 'Utile pour un joueur parti ou en double.', 'Retirer', 'danger'))) return;
    const roles = { ...S.cfg.roles }; delete roles[id];
    await pubCfg({ roles });
    await pub('p/' + id, null, { retain: true });
    await pub('on/' + id, null, { retain: true });
  }
});
$('#draw-box').addEventListener('click', async (e) => {
  if (!e.target.closest('#btn-draw') || !isHost()) return;
  const ids = Object.keys(S.players), n = +$('#draw-n').value;
  const shuffled = ids.map((id) => [crypto.getRandomValues(new Uint32Array(1))[0], id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const roles = {};
  shuffled.forEach((id, i) => { roles[id] = i < n ? 'F' : 'H'; });
  await pubCfg({ roles });
  toast('🎲 Rôles tirés au sort !');
});
$('#rules-form').addEventListener('change', (e) => {
  const el = e.target.closest('[data-rule]');
  if (!el || !isHost()) return;
  pubRules({ [el.dataset.rule]: el.type === 'checkbox' ? el.checked : el.dataset.type === 'str' ? el.value : +el.value });
});
$('#btn-zone-here').onclick = () => {
  if (!S.fix) { toast(S.geoErr === 'denied' ? 'Localisation refusée dans le navigateur.' : 'Position pas encore trouvée…'); return; }
  const r = (S.cfg.rules.zone && S.cfg.rules.zone.r) || +$('#zone-r').value || 1000;
  lobbyCentered = false;
  pubRules({ zone: { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), r } });
};
$('#zone-r').addEventListener('input', () => {
  $('#zone-r-val').textContent = fmtDist(+$('#zone-r').value);
  const z = S.cfg.rules.zone;
  if (z) { const prev = { ...z, r: +$('#zone-r').value }; lobbyZoneKey = zoneKey(prev); lobbyZone = drawZone(lobbyMap, lobbyZone, prev); }
});
$('#zone-r').addEventListener('change', () => {
  const z = S.cfg.rules.zone;
  if (z) pubRules({ zone: { ...z, r: +$('#zone-r').value } });
});
$('#btn-zone-clear').onclick = () => pubRules({ zone: null });
$('#map-mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  S.mapMode = b.dataset.mode; scheduleRender();
});
$('#btn-prison-clear').onclick = () => pubRules({ prison: null });
$('#btn-nogo-clear').onclick = () => pubRules({ nogo: [] });

/* Zones enregistrées : partagées avec le groupe (dans la partie) et gardées sur ce téléphone. */
function savedZones() {
  const all = [...((S.cfg && S.cfg.savedZones) || []), ...(store.get('traque.zones') || [])];
  const seen = new Set();
  return all.filter((z) => z && z.name && !seen.has(z.name) && seen.add(z.name));
}
function renderSavedZones() {
  const sel = $('#zone-saved'), list = savedZones();
  const html = '<option value="">📂 Zones enregistrées…</option>' + list.map((z, i) => `<option value="${i}">${esc(z.name)}</option>`).join('');
  if (sel.dataset.html !== html) { sel.dataset.html = html; sel.innerHTML = html; }
  sel.disabled = !list.length;
}
$('#zone-saved').addEventListener('change', (e) => {
  const z = savedZones()[+e.target.value];
  e.target.value = '';
  if (!z || !isHost()) return;
  lobbyCentered = false;
  pubRules({ zone: z.zone, prison: z.prison || null, nogo: z.nogo || [] });
  toast(`📂 Zone « ${z.name} » chargée`);
});
$('#btn-zone-save').onclick = () => {
  const r = S.cfg.rules;
  if (!r.zone) { toast('Place d’abord une zone.'); return; }
  const name = (prompt('Nom de cette zone (ex. « Parc de la Hotoie ») :') || '').trim().slice(0, 40);
  if (!name) return;
  const entry = { name, zone: r.zone, prison: r.prison || null, nogo: r.nogo || [] };
  const local = (store.get('traque.zones') || []).filter((z) => z.name !== name);
  store.set('traque.zones', [entry, ...local].slice(0, 20));
  const shared = ((S.cfg.savedZones) || []).filter((z) => z.name !== name);
  pubCfg({ savedZones: [entry, ...shared].slice(0, 10) });
  toast(`💾 Zone « ${name} » enregistrée pour le groupe`);
};
$('#btn-start').onclick = startGame;
$('#btn-become-host').onclick = async () => {
  if (await confirmBox('Devenir organisateur ?', `${nameOf(S.cfg.host)} ne pourra plus changer les réglages.`, 'Oui')) pubCfg({ host: S.me });
};

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]');
  if (a) {
    const act = a.dataset.act;
    if (act === 'caught-self') catchSelf();
    else if (act === 'catch') catchSomeone();
    else if (act === 'ping') usePing();
    else if (act === 'jam') usePower('jam');
    else if (act === 'counter') usePower('counter');
    else if (act === 'riposte') useRiposte();
    else if (act === 'gps') openGpsHelp();
    else if (act === 'reminders') openReminders();
    else if (act === 'see-map') { S.endDismissed = true; scheduleRender(); }
    else if (act === 'lobby') pubCfg({ status: 'lobby' });
    else if (act === 'leave') { if (await confirmBox('Quitter la partie ?', 'Tu pourras revenir avec le même code.', 'Quitter', 'danger')) leaveRoom(); }
    else if (act === 'become-host') { if (await confirmBox('Prendre le relais ?', 'Tu pourras terminer la partie et en relancer une.', 'Oui')) pubCfg({ host: S.me }); }
    else if (act === 'end') {
      if (await confirmBox('Terminer la partie ?', 'Les fugitifs encore en fuite gagnent.', 'Terminer', 'danger')) {
        pubCfg({ status: 'ended', winner: 'F', endReason: 'host', endedAt: Date.now() });
      }
    }
    return;
  }
  const u = e.target.closest('[data-uncatch]');
  if (u && isHost()) {
    if (await confirmBox(`Annuler la capture de ${nameOf(u.dataset.uncatch)} ?`, '', 'Annuler la capture')) pub('caught/' + u.dataset.uncatch, null, { retain: true });
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f && markers[f.dataset.focus]) {
    gameMap.setView(markers[f.dataset.focus].getLatLng(), Math.max(gameMap.getZoom(), 16));
    $('#sheet').classList.remove('open'); syncSheetHeight();
  }
});
for (const tab of document.querySelectorAll('.tabs [role=tab]')) {
  tab.onclick = () => {
    S.tab = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tabs [role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    $('#tab-players').hidden = S.tab !== 'players';
    $('#tab-log').hidden = S.tab !== 'log';
    scheduleRender();
  };
}
function setFullMap(on) {
  S.fullmap = on;
  document.body.classList.toggle('fullmap', on);
  $('#btn-full').textContent = on ? '✕' : '⛶';
  $('#btn-full').title = on ? 'Quitter le plein écran' : 'Plein écran';
  try {
    if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch { /* iPhone : pas de plein écran du navigateur, la carte prend quand même tout l'écran */ }
  syncSheetHeight();
  setTimeout(() => gameMap && gameMap.invalidateSize(), 300);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.fullmap) setFullMap(false); });
function syncSheetHeight() {
  requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-h', (S.fullmap ? 0 : $('#sheet').getBoundingClientRect().height) + 'px'));
}
new ResizeObserver(syncSheetHeight).observe($('#sheet'));
$('#btn-sheet').onclick = () => { $('#sheet').classList.toggle('open'); syncSheetHeight(); };
$('#btn-me').onclick = () => { if (S.fix && gameMap) gameMap.setView([S.fix.lat, S.fix.lng], Math.max(gameMap.getZoom(), 16)); else toast('Position pas encore trouvée…'); };
$('#btn-fit').onclick = fitAll;
$('#btn-style').onclick = cycleMapStyle;
$('#btn-full').onclick = () => setFullMap(!S.fullmap);
$('#chat').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim().slice(0, 200);
  if (!text) return;
  $('#chat-input').value = '';
  const ev = { type: 'chat', from: S.me, text, t: Date.now() };
  await pub('ev', ev);
});

// Horloge : compte à rebours, obligations (révélations, radars…), rafraîchissement.
let ticks = 0;
setInterval(() => {
  if (!S.room || !S.cfg) return;
  ticks++;
  if (S.screen === 'game') {
    dutyTick();
    renderHud(phase(), outcome(), roleOf(S.me), Date.now());
    updateGameZone();
    if (ticks % 5 === 0 || outcome()) scheduleRender();
  }
}, 1000);

// Démarrage
if (qs.get('fast')) window.__traque = { S, zoneState };
initHome();
const h0 = parseHash();
if (h0.code) $(store.get('traque.name') ? '#btn-join' : '#name').focus();
