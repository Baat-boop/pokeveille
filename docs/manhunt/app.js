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
};
const LIVE_EVERY = 5000;        // chasseurs : position envoyée au plus toutes les 5 s
const LIVE_KEEPALIVE = 20000;   // … et au moins toutes les 20 s
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
      case 'on': S.online[id] = !!(data && data.on); break;
      case 'pos': if (data) onPos(id, data); else delete S.pos[id]; break;
      case 'caught': if (data) onCaught(id, data); else onUncaught(id); break;
      case 'pings':
        if (data) {
          S.pings[id] = data;
          if (S.cfg && data.gameId === S.cfg.gameId) {
            for (const t of data.list) addLog('pinguse:' + id + ':' + t, t, `📡 <b>${esc(nameOf(id))}</b> lance un radar.`);
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
    client.on('connect', () => { S.connected = true; pub('on/' + S.me, { on: true, t: Date.now() }, { retain: true }); scheduleRender(); });
    client.on('close', () => { S.connected = false; scheduleRender(); });
    client.on('offline', () => { S.connected = false; scheduleRender(); });
    await new Promise((res, rej) => client.subscribe(NS + S.room.id + '/#', { qos: 1 }, (err) => (err ? rej(err) : res())));

    await pub('p/' + S.me, { id: S.me, name: S.name, t: Date.now() }, { retain: true });
    await pub('on/' + S.me, { on: true, t: Date.now() }, { retain: true });

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
function resetLog() { S.log = []; S.logKeys = new Set(); S.logSeen = 0; S.warnedReveal = 0; S.finalSent = false; S.wasOut = false; S.endDismissed = false; S.lastOutcomeKey = null; }
function addLog(key, t, html, { notify = false } = {}) {
  if (S.logKeys.has(key)) return;
  S.logKeys.add(key);
  S.log.push({ t, html });
  S.log.sort((a, b) => a.t - b.t);
  if (notify && S.tab !== 'log') S.logSeen = Math.min(S.logSeen, S.log.length - 1);
}
const nameOf = (id) => (S.players[id] && S.players[id].name) || 'Quelqu’un';
const isHost = () => S.cfg && S.cfg.host === S.me;
function isCaught(id) { const k = S.caught[id]; return !!k && !!S.cfg && k.gameId === S.cfg.gameId; }
function baseRole(id) { return (S.cfg && S.cfg.roles && S.cfg.roles[id]) || (S.cfg && S.cfg.status === 'lobby' ? 'H' : 'S'); }
function roleOf(id) {
  const r = baseRole(id);
  if (r === 'F' && isCaught(id)) return S.cfg.rules.caughtBecomesHunter ? 'H' : 'S';
  return r;
}
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
  const who = mine ? 'Ta position' : `Position de <b>${esc(nameOf(id))}</b>`;
  const late = data.late ? ' (en retard)' : '';
  let html;
  if (data.kind === 'reveal') html = `📍 ${who} révélée${late}.`;
  else if (data.kind === 'ping') html = `📡 Radar : ${mine ? 'ta position a été révélée' : `<b>${esc(nameOf(id))}</b> repéré·e`}.`;
  else if (data.kind === 'outzone') html = `🚧 ${mine ? 'Tu es' : `<b>${esc(nameOf(id))}</b> est`} hors zone, position révélée.`;
  else if (data.kind === 'final') html = `🏁 ${mine ? 'Ta cachette' : `Cachette de <b>${esc(nameOf(id))}</b>`} dévoilée.`;
  else return;
  const fresh = Date.now() - data.t < 60000;
  addLog('pos:' + id + ':' + data.t, data.t, html, { notify: true });
  if (fresh && !mine && data.kind !== 'final' && roleOf(S.me) !== 'F') beep('info');
}
function onCaught(id, data) {
  S.caught[id] = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId) return;
  const by = data.by ? ` par <b>${esc(nameOf(data.by))}</b>` : '';
  addLog('caught:' + id + ':' + data.t, data.t, `🎯 <b>${esc(nameOf(id))}</b> s'est fait attraper${by} !`, { notify: true });
  if (Date.now() - data.t < 60000) {
    beep(id === S.me ? 'alarm' : 'good');
    if (id === S.me) toast(S.cfg.rules.caughtBecomesHunter ? 'Attrapé·e ! Tu deviens chasseur 🔦' : 'Attrapé·e ! Tu passes spectateur 👀', 5000);
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
function startGeo() {
  if (S.geoWatch != null || !navigator.geolocation) { if (!navigator.geolocation) S.geoErr = 'unsupported'; return; }
  S.geoWatch = navigator.geolocation.watchPosition((p) => {
    S.fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
    S.geoErr = null;
    onFix();
  }, (e) => {
    S.geoErr = e.code === 1 ? 'denied' : 'unavailable';
    scheduleRender();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function onFix() {
  if (S.screen === 'game') { updateSelfMarker(); dutyTick(); }
  if (S.screen === 'lobby') renderLobbyMap();
  scheduleRender();
}
async function publishPos(kind, extra = {}) {
  if (!S.fix) return false;
  const p = { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), acc: S.fix.acc, fixT: S.fix.t, t: Date.now(), kind, gameId: S.cfg.gameId, ...extra };
  S.pos[S.me] = p;
  await pub('pos/' + S.me, p, { retain: true, qos: kind === 'live' ? 0 : 1 });
  if (kind !== 'live') onPos(S.me, p);
  return true;
}
function outOfZone() {
  const z = S.cfg && S.cfg.rules.zone;
  if (!z || !S.fix) return false;
  return dist(S.fix, z) > z.r;
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

    // Sortie de zone (tout le monde est prévenu)
    const isOut = outOfZone();
    if (isOut && !S.wasOut) { S.wasOut = true; beep('alarm'); }
    if (!isOut) S.wasOut = false;

    if (role === 'F') {
      if (ph.name === 'hunt') {
        // Révélation programmée
        const key = 'traque.rev.' + gid;
        const last = store.get(key, -1);
        if (ph.k > last && S.fix) {
          const late = now - (ph.release + ph.k * c.rules.interval * MIN) > 60000;
          if (await publishPos('reveal', { idx: ph.k, late })) store.set(key, ph.k);
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
          if (await publishPos('ping', { pingT: t })) {
            answered.push(t); store.set(answeredKey, answered);
            beep('alarm'); toast('📡 Radar ! Les chasseurs viennent de voir ta position.', 4500);
          }
        }
      }
      if (isOut && now - S.lastOutzone > OUTZONE_EVERY) {
        S.lastOutzone = now; await publishPos('outzone');
      }
    } else if (role === 'H') {
      if (S.fix && (now - S.lastLive > LIVE_KEEPALIVE || (S.fix.t > S.lastLive && now - S.lastLive > LIVE_EVERY))) {
        S.lastLive = now; await publishPos('live');
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
    `${nF} fugitif${nF > 1 ? 's' : ''} contre ${nH} chasseur${nH > 1 ? 's' : ''}. ${minutesLabel(r.headStart)} d'avance, révélation toutes les ${minutesLabel(r.interval)}, ${minutesLabel(r.duration)} au total.${r.zone ? '' : ' Aucune zone de jeu définie.'}`,
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
async function shareLink() {
  const url = `${location.origin}${location.pathname}#join=${S.code}&b=${S.b}`;
  const text = `Rejoins ma partie de Traque (code ${S.code})`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Traque', text, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Lien copié !'); } catch { prompt('Copie ce lien :', url); }
}

/* ---------- cartes ---------- */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
let lobbyMap, lobbyZone, lobbyMe, gameMap, gameZone, selfMarker, selfAcc;
const markers = {};
let didFit = false;

function ensureLobbyMap() {
  if (lobbyMap) return;
  lobbyMap = L.map('lobby-map', { zoomControl: true, attributionControl: true }).setView([46.6, 2.4], 5);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(lobbyMap);
  lobbyMap.on('click', (e) => {
    if (!isHost()) return;
    const r = (S.cfg.rules.zone && S.cfg.rules.zone.r) || 1000;
    pubRules({ zone: { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6), r } });
  });
}
let lobbyCentered = false;
function renderLobbyMap() {
  ensureLobbyMap();
  const z = S.cfg && S.cfg.rules.zone;
  if (z) {
    if (!lobbyZone) lobbyZone = L.circle([z.lat, z.lng], { radius: z.r, color: '#e8590c', weight: 2, fillOpacity: 0.08 }).addTo(lobbyMap);
    lobbyZone.setLatLng([z.lat, z.lng]); lobbyZone.setRadius(z.r);
  } else if (lobbyZone) { lobbyZone.remove(); lobbyZone = null; }
  if (S.fix) {
    if (!lobbyMe) lobbyMe = L.marker([S.fix.lat, S.fix.lng], { icon: L.divIcon({ className: 'pm', html: '<div class="me-dot"></div>', iconSize: [0, 0] }) }).addTo(lobbyMap);
    lobbyMe.setLatLng([S.fix.lat, S.fix.lng]);
  }
  if (!lobbyCentered && (z || S.fix)) {
    lobbyCentered = true;
    if (z) lobbyMap.fitBounds(lobbyZone.getBounds(), { padding: [10, 10] });
    else lobbyMap.setView([S.fix.lat, S.fix.lng], 15);
  }
}

function ensureGameMap() {
  if (gameMap) return;
  gameMap = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 5);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(gameMap);
}
function updateSelfMarker() {
  if (!gameMap || !S.fix) return;
  const ll = [S.fix.lat, S.fix.lng];
  const cls = roleOf(S.me) === 'F' ? 'F' : '';
  if (!selfMarker) {
    selfAcc = L.circle(ll, { radius: S.fix.acc, color: '#1971c2', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(gameMap);
    selfMarker = L.marker(ll, { zIndexOffset: 1000, icon: L.divIcon({ className: 'pm', html: `<div class="me-dot ${cls}"></div>`, iconSize: [0, 0] }) }).addTo(gameMap);
  }
  selfMarker.setLatLng(ll); selfAcc.setLatLng(ll); selfAcc.setRadius(S.fix.acc);
  selfMarker.setIcon(L.divIcon({ className: 'pm', html: `<div class="me-dot ${cls}"></div>`, iconSize: [0, 0] }));
}
/** Position d'un autre joueur que j'ai le droit de voir, ou null. */
function visiblePos(id) {
  const p = S.pos[id];
  if (!p || !S.cfg || p.gameId !== S.cfg.gameId || id === S.me) return null;
  if (p.kind === 'live') {
    if (roleOf(id) !== 'H') return null;
    const ended = !!outcome();
    if (roleOf(S.me) === 'F' && !S.cfg.rules.fugitivesSeeHunters && !ended) return null;
  }
  return p;
}
function renderGameMap() {
  ensureGameMap();
  const z = S.cfg.rules.zone;
  if (z) {
    if (!gameZone) gameZone = L.circle([z.lat, z.lng], { radius: z.r, color: '#e8590c', weight: 3, fill: false, dashArray: '8 6', interactive: false }).addTo(gameMap);
    gameZone.setLatLng([z.lat, z.lng]); gameZone.setRadius(z.r);
  } else if (gameZone) { gameZone.remove(); gameZone = null; }
  updateSelfMarker();

  const seen = new Set();
  for (const id of Object.keys(S.players)) {
    const p = visiblePos(id);
    if (!p) continue;
    seen.add(id);
    const role = p.kind === 'live' ? 'H' : 'F';
    const age = Date.now() - p.t;
    const old = p.kind === 'live' ? age > 90000 : false;
    const label = esc(nameOf(id)) + (p.kind === 'live' ? '' : ' · ' + (age < 45000 ? 'maintenant' : ago(p.t).replace('il y a ', '')));
    const html = `<div class="pin ${role} ${old ? 'old' : ''}">${esc(nameOf(id).slice(0, 1).toUpperCase())}</div><div class="pin-label">${label}</div>`;
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
  if (gameZone) bounds = bounds ? bounds.extend(gameZone.getBounds()) : gameZone.getBounds();
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
      <div class="who"><div class="pname">${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''}</div>${meta ? `<div class="pmeta">${meta}</div>` : ''}</div>
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
  $('#zone-hint').textContent = z
    ? `Cercle de ${fmtDist(z.r)} de rayon.` + (host ? ' Touche la carte pour déplacer le centre.' : '')
    : (host ? 'Aucune zone pour l’instant. Touche la carte ou « Centrer sur moi » pour en créer une.' : 'Pas de zone définie : on joue partout.');
  const rr = $('#zone-r');
  if (document.activeElement !== rr) rr.value = z ? z.r : 1000;
  $('#zone-r-val').textContent = fmtDist(z ? z.r : +rr.value);
  $('#btn-zone-clear').hidden = !z;
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
    else if (outOfZone()) bannerText = role === 'F' ? '🚧 Tu es hors zone ! Ta position est révélée.' : '🚧 Tu es hors zone !';
    else if (!S.connected) { bannerText = 'Connexion perdue, reconnexion…'; bannerInfo = true; }
  }
  banner.hidden = !bannerText; banner.textContent = bannerText; banner.classList.toggle('info', bannerInfo);
  if (bannerText) banner.style.top = ($('#hud').getBoundingClientRect().bottom + 8) + 'px';

  // Actions
  let acts = '';
  if (!out && c.status === 'running') {
    if (role === 'F') acts = '<button class="btn fug" data-act="caught-self">Je me suis fait attraper</button>';
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
    const p = visiblePos(id);
    const meta = [];
    if (caught) {
      const k = S.caught[id];
      meta.push(`attrapé·e${k.by ? ' par ' + esc(nameOf(k.by)) : ''} à ${hhmm(k.t)}`);
    }
    if (p) {
      let s = (p.kind === 'live' ? 'en direct' : 'vu·e ' + ago(p.t));
      if (S.fix) s += ' · à ' + fmtDist(dist(S.fix, p));
      meta.push(s);
    } else if (base === 'F' && !caught && id !== S.me) meta.push('position cachée');
    if (!S.online[id]) meta.push('hors ligne');
    const chip = caught && r !== 'H' ? 'Attrapé·e' : ROLE_LABEL[r];
    return `<li class="player ${caught ? 'caught' : ''} ${p ? 'clickable' : ''}" ${p ? `data-focus="${esc(id)}"` : ''}>
      <span class="dot ${S.online[id] ? 'on' : ''}"></span>
      <div class="who"><div class="pname">${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''}</div><div class="pmeta">${meta.join(' · ') || '&nbsp;'}</div></div>
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
  tools += '<button class="btn small ghost" data-act="leave">Quitter</button>';
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
  badge.textContent = caught && role !== 'H' ? 'Attrapé·e' : ROLE_LABEL[role];
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
  const h = parseHash(), last = store.get('traque.last');
  if (h.code) $('#code').value = h.code;
  const resume = $('#btn-resume');
  if (last && last.code && !h.code) {
    resume.hidden = false; resume.textContent = `Reprendre la partie ${last.code}`;
  } else resume.hidden = true;
}

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
  pubRules({ [el.dataset.rule]: el.type === 'checkbox' ? el.checked : +el.value });
});
$('#btn-zone-here').onclick = () => {
  if (!S.fix) { toast(S.geoErr === 'denied' ? 'Localisation refusée dans le navigateur.' : 'Position pas encore trouvée…'); return; }
  const r = (S.cfg.rules.zone && S.cfg.rules.zone.r) || +$('#zone-r').value || 1000;
  lobbyCentered = false;
  pubRules({ zone: { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), r } });
};
$('#zone-r').addEventListener('input', () => {
  $('#zone-r-val').textContent = fmtDist(+$('#zone-r').value);
  if (lobbyZone) lobbyZone.setRadius(+$('#zone-r').value);
});
$('#zone-r').addEventListener('change', () => {
  const z = S.cfg.rules.zone;
  if (z) pubRules({ zone: { ...z, r: +$('#zone-r').value } });
});
$('#btn-zone-clear').onclick = () => pubRules({ zone: null });
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
function syncSheetHeight() {
  requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-h', $('#sheet').getBoundingClientRect().height + 'px'));
}
new ResizeObserver(syncSheetHeight).observe($('#sheet'));
$('#btn-sheet').onclick = () => { $('#sheet').classList.toggle('open'); syncSheetHeight(); };
$('#btn-me').onclick = () => { if (S.fix && gameMap) gameMap.setView([S.fix.lat, S.fix.lng], Math.max(gameMap.getZoom(), 16)); else toast('Position pas encore trouvée…'); };
$('#btn-fit').onclick = fitAll;
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
    if (ticks % 5 === 0 || outcome()) scheduleRender();
  }
}, 1000);

// Démarrage
initHome();
const h0 = parseHash();
if (h0.code) $(store.get('traque.name') ? '#btn-join' : '#name').focus();
