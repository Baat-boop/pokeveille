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
const BROKERS = qs.get('broker') === 'none' ? []
  : qs.get('broker') ? qs.get('broker').split(',')
    : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'];
// Notre relais sur Cloudflare (?relay=none pour le couper, ?relay=ws://… pour en tester un autre).
const OUR_HOST = 'traque.jeu-traque.workers.dev';
const OUR_RELAY = qs.get('relay') === 'none' || (qs.get('broker') && !qs.get('relay')) ? null
  : qs.get('relay') || `wss://${location.hostname === OUR_HOST ? location.host : OUR_HOST}/relay/`;
const RELAYS = [...(OUR_RELAY ? ['relay:' + OUR_RELAY] : []), ...BROKERS];
const relayName = (u) => (u === 'local' ? 'Robots (local)' : u.startsWith('relay:') ? 'Cloudflare (le nôtre)' : u.replace(/^wss?:\/\//, '').split(/[:/]/)[0]);
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
  mode: 'classic',  // classic | infection | cachecache | drapeau
  flag: null,       // {lat, lng} : drapeau à atteindre (mode drapeau)
  missions: [],     // balises [{lat, lng}] : +1 pouvoir pour le fugitif qui y passe
  bonusEvery: 0,    // un pouvoir offert aux fugitifs toutes les N minutes de survie (0 = non)
  teams: 0,         // nombre d'équipes de fugitifs (0 = pas d'équipes)
  testMode: false,  // mode test : tout le monde voit tout, panneau de diagnostic, pas de points
};
const MODE_HINT = {
  classic: 'Classique : les chasseurs doivent attraper tous les fugitifs avant la fin du temps.',
  infection: 'Infection : chaque fugitif attrapé devient chasseur. Le dernier fugitif libre gagne.',
  cachecache: 'Cache-cache : après l’avance, les fugitifs ne bougent plus. Quitter sa cachette (plus de 40 m) révèle sa position.',
  drapeau: 'Capture du drapeau : place le drapeau 🚩 sur la carte. Un fugitif qui l’atteint fait gagner les fugitifs.',
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
  const s = Math.round((tnow() - t) / 1000);
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
  clients: [], relayUrls: [], relayStats: [], kindStats: {}, dbg: {}, playerT: {}, mates: {}, tlRaw: {}, teamKey: null, ecdh: null, onlineBy: {}, tracks: {}, balises: {}, flag: null, solo: false,
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
/** Alerte : 'sound' (son + vibreur), 'vibrate' (vibreur seul) ou 'silent'. En auto, les fugitifs sont en vibreur : un bip trahirait leur cachette. */
function alertMode() {
  const m = store.get('traque.alert') || 'auto';
  if (m !== 'auto') return m;
  return S.cfg && S.cfg.status !== 'lobby' && baseRole(S.me) === 'F' ? 'vibrate' : 'sound';
}
const ALERT_LABEL = { auto: '🔔 Alertes : auto', sound: '🔊 Son + vibreur', vibrate: '📳 Vibreur seul', silent: '🔕 Muet' };
const ecoOn = () => store.get('traque.eco') === true || (S.bat != null && S.bat <= 20 && !S.charging);
function beep(kind = 'info') {
  const mode = alertMode();
  if (mode === 'silent') return;
  if (mode === 'sound') try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'alarm' ? [880, 660, 880] : kind === 'good' ? [523, 659, 784] : [740, 988];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'square'; g.gain.value = 0.06;
      o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.16; o.start(t0); o.stop(t0 + 0.12);
    });
  } catch { /* pas de son */ }
  try { if (navigator.vibrate) navigator.vibrate(kind === 'alarm' ? [300, 120, 300, 120, 300] : [200, 80, 200]); } catch { /* idem */ }
}
document.addEventListener('pointerdown', () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* idem */ } }, { once: true });

/* ---------- réseau ----------
 * Chaque téléphone se connecte à TOUS les relais en même temps et publie sur chacun.
 * Si un relais tombe en pleine partie, les autres prennent le relais sans que personne ne s'en rende compte.
 * Les messages reçus en double (un par relais) ou en retard sont triés grâce à leur horodatage. */
/** Client de notre relais Cloudflare (WebSocket), avec la même interface que les clients MQTT. */
function relayClient(base, will) {
  const h = {}, prefix = NS + S.room.id + '/';
  let ws = null, closed = false, retry = 0, pingT = null;
  const c = {
    connected: false,
    on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return c; },
    once(ev, fn) { const w = (...a) => { h[ev] = h[ev].filter((x) => x !== w); fn(...a); }; return c.on(ev, w); },
    emit(ev, ...a) { (h[ev] || []).slice().forEach((f) => f(...a)); },
    subscribe(_t, _o, cb) { if (cb) cb(null); },
    publish(topic, payload, o = {}) {
      if (!ws || ws.readyState !== 1 || !topic.startsWith(prefix)) return;
      ws.send(JSON.stringify({ t: 'pub', topic: topic.slice(prefix.length), payload: String(payload), retain: !!o.retain }));
    },
    end() { closed = true; clearInterval(pingT); c.connected = false; try { ws.close(1000); } catch { /* déjà fermé */ } },
    raw(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
  };
  const open = () => {
    try { ws = new WebSocket(base + S.room.id); } catch { return; }
    ws.onopen = () => {
      retry = 0; c.connected = true;
      if (will) ws.send(JSON.stringify({ t: 'will', topic: will.topic.slice(prefix.length), payload: String(will.payload) }));
      clearInterval(pingT); pingT = setInterval(() => { try { ws.send('ping'); } catch { /* fermé */ } }, 25000);
      c.emit('connect');
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'retained') for (const [t, pl] of m.m) c.emit('message', prefix + t, pl);
      else if (m.t === 'msg') c.emit('message', prefix + m.topic, m.payload);
    };
    ws.onclose = () => {
      clearInterval(pingT);
      const was = c.connected; c.connected = false;
      if (was) c.emit('close');
      if (!closed) setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
    };
    ws.onerror = () => {};
  };
  open();
  return c;
}
function mkClient(url, will) {
  if (url === 'local') return localBroker.client();
  if (url.startsWith('relay:')) return relayClient(url.slice(6), will);
  return mqtt.connect(url, {
    clientId: 'tq_' + randStr(12), clean: true, keepalive: 30, reconnectPeriod: 3000,
    connectTimeout: 8000, protocolVersion: 4, will, queueQoSZero: false,
  });
}
/** Relais local en mémoire (partie d'essai solo avec des robots, sans réseau). */
class LocalBroker {
  constructor() { this.retained = new Map(); this.clients = new Set(); }
  client() {
    const b = this, h = {};
    const c = {
      connected: false, subs: [],
      on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return c; },
      once(ev, fn) { const w = (...a) => { h[ev] = h[ev].filter((x) => x !== w); fn(...a); }; return c.on(ev, w); },
      emit(ev, ...a) { (h[ev] || []).slice().forEach((f) => f(...a)); },
      subscribe(t, _o, cb) {
        const pre = t.replace('#', ''); c.subs.push(pre);
        for (const [k, v] of b.retained) if (k.startsWith(pre)) setTimeout(() => c.emit('message', k, v), 0);
        if (cb) cb(null);
      },
      publish(t, payload, o = {}) {
        if (o.retain) { if (payload === '') b.retained.delete(t); else b.retained.set(t, payload); }
        for (const x of b.clients) if (x.subs.some((pre) => t.startsWith(pre))) setTimeout(() => x.emit('message', t, payload), 5);
      },
      end() { b.clients.delete(c); c.connected = false; },
    };
    b.clients.add(c);
    setTimeout(() => { c.connected = true; c.emit('connect'); }, 0);
    return c;
  }
}
let localBroker = null;
function connCount() { return S.clients.filter((c) => c.connected).length; }
async function pub(sub, obj, { retain = false, qos = 1 } = {}) {
  if (!S.clients.length || !S.room) return;
  const payload = obj == null ? '' : await seal(S.room.key, obj);
  const live = S.clients.filter((c) => c.connected);
  for (const c of (live.length ? live : S.clients)) { try { c.publish(T(sub), payload, { retain, qos }); } catch { /* relais en panne */ } }
}
/** Ancien message (renvoyé par un relais qui revient, ou arrivé en double) ? */
const older = (prev, data) => prev && data && prev.t != null && data.t != null && data.t < prev.t;

/* ---------- horloge commune ----------
 * Si l'heure d'un téléphone est fausse, son compte à rebours serait décalé. On la cale sur l'heure du serveur du site. */
let CLOCK_OFF = 0;
const tnow = () => Date.now() + CLOCK_OFF;
async function syncClock() {
  try {
    const t0 = Date.now();
    const res = await fetch(location.pathname + '?horloge=' + t0, { method: 'HEAD', cache: 'no-store' });
    const t1 = Date.now();
    const d = Date.parse(res.headers.get('date') || '');
    if (!d || t1 - t0 > 3000) return;
    const off = d + 500 - (t0 + t1) / 2; // l'en-tête est à la seconde près : on vise le milieu
    CLOCK_OFF = Math.abs(off) > 1500 ? Math.round(off) : 0;
  } catch { /* pas de correction */ }
}
syncClock();

let msgQueue = Promise.resolve();
function onMessage(topic, payload, relay = 0) {
  if (S.relayStats) S.relayStats[relay] = (S.relayStats[relay] || 0) + 1;
  msgQueue = msgQueue.then(async () => {
    if (!S.room) return;
    const prefix = NS + S.room.id + '/';
    if (!topic.startsWith(prefix)) return;
    const [kind, id] = topic.slice(prefix.length).split('/');
    S.kindStats[kind] = (S.kindStats[kind] || 0) + 1;
    let data = null;
    if (payload && payload.length) {
      try { data = await unseal(S.room.key, payload.toString()); } catch { return; }
    }
    switch (kind) {
      case 'cfg':
        if (!data) break;
        if (S.cfg && data.rev != null && S.cfg.rev != null && (data.rev < S.cfg.rev || (data.rev === S.cfg.rev && data.updatedAt < S.cfg.updatedAt))) {
          if (isHost() && data.rev < S.cfg.rev) pub('cfg', S.cfg, { retain: true }); // remet à jour un relais revenu avec une vieille version
          break;
        }
        onCfg(data); break;
      case 'p': {
        const prev = S.playerT[id];
        if (data && prev && data.t < prev) break;
        if (data) S.playerT[id] = data.t;
        if (data && !data.removed) S.players[id] = data;
        else if (S.players[id]) {
          delete S.players[id];
          if (id === S.me) { toast('Tu as été retiré de la partie.'); leaveRoom(false); return; }
        }
        break;
      }
      case 'on': {
        const by = S.onlineBy[id] || (S.onlineBy[id] = {});
        by[relay] = !!(data && data.on);
        S.online[id] = Object.values(by).some(Boolean);
        if (data && data.bat != null) S.batt[id] = { lvl: data.bat, chg: !!data.chg };
        break;
      }
      case 'pw':
        if (data && S.powers[id] && S.powers[id].gameId === data.gameId && data.list.length < S.powers[id].list.length) break;
        if (data) onPowers(id, data); else delete S.powers[id];
        break;
      case 'pos': if (data) onPos(id, data); break;
      case 'caught':
        if (data && older(S.caught[id], data)) break;
        if (data && data.cleared) onUncaught(id); else if (data) onCaught(id, data);
        break;
      case 'trk': if (data && !older(S.tracks[id], data)) S.tracks[id] = data; break;
      case 'dbg': if (data && !older(S.dbg[id], data)) S.dbg[id] = data; break;
      case 'tk': if (data && id === S.me) await onTeamKey(data); break;
      case 'tl': if (data && id !== S.me) { S.tlRaw[id] = data; await decodeMates(); } break;
      case 'bal': if (data && !older(S.balises[id], data)) onBalise(+id, data); break;
      case 'flag': if (data && !older(S.flag, data)) onFlag(data); break;
      case 'pings':
        if (data && S.pings[id] && S.pings[id].gameId === data.gameId && data.list.length < S.pings[id].list.length) break;
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

async function enterRoom({ code, create = false, solo = null }) {
  busy(solo ? 'Préparation de la partie d’essai…' : create ? 'Création de la partie…' : 'Connexion à la partie…');
  try {
    S.code = code;
    S.room = await deriveRoom(code);
    S.me = store.get('traque.id.' + code) || randStr(12);
    store.set('traque.id.' + code, S.me);
    S.cfg = null; S.players = {}; S.playerT = {}; S.online = {}; S.onlineBy = {}; S.pos = {}; S.caught = {}; S.pings = {};
    S.tracks = {}; S.balises = {}; S.flag = null; S.solo = !!solo;
    resetLog();

    const will = { topic: T('on/' + S.me), payload: await seal(S.room.key, { on: false }), qos: 1, retain: true };
    if (solo) localBroker = new LocalBroker();
    const urls = solo ? ['local'] : RELAYS;
    S.relayUrls = urls; S.relayStats = urls.map(() => 0);
    S.clients = urls.map((u) => mkClient(u, will));
    S.clients.forEach((c, i) => {
      c.on('message', (t, pl) => onMessage(t, pl, i));
      c.on('connect', () => { c.subscribe(NS + S.room.id + '/#', { qos: 1 }); pubPresence(true); if (c.raw) registerPush(); scheduleRender(); });
      c.on('close', scheduleRender);
      c.on('offline', scheduleRender);
      c.on('error', () => { /* mqtt.js réessaie tout seul */ });
    });
    // On attend qu'au moins un relais réponde.
    const t0 = tnow();
    while (!connCount() && tnow() - t0 < 9000) await sleep(100);
    if (!connCount()) throw new Error('Impossible de joindre le serveur de jeu. Vérifie ta connexion et réessaie.');
    await sleep(150);

    await myKeyPair();
    await pub('p/' + S.me, { id: S.me, name: S.name, emoji: S.emoji, pk: S.ecdh ? S.ecdh.pub : null, t: tnow() }, { retain: true });
    await pubPresence(true);

    if (create || solo) {
      S.cfg = { v: 1, rev: 1, host: S.me, status: 'lobby', gameId: randStr(8), rules: { ...DEFAULT_RULES, ...(solo ? solo.rules : {}) }, roles: { [S.me]: solo ? solo.role : 'H' }, updatedAt: tnow() };
      S.gameId = S.cfg.gameId;
      await pub('cfg', S.cfg, { retain: true });
    } else {
      busy('Recherche de la partie…');
      const t1 = tnow();
      while (!S.cfg && tnow() - t1 < 9000) await sleep(100);
      if (!S.cfg) throw new Error('Partie introuvable. Vérifie le code et ta connexion.');
    }

    if (!solo) {
      store.set('traque.last', { code });
      history.replaceState(null, '', location.pathname + location.search + '#join=' + code);
    }
    startGeo();
    initBattery();
    initPush();
    if (solo) startBots(solo.role);
    route();
  } catch (e) {
    for (const c of S.clients) { try { c.end(true); } catch { /* déjà fermé */ } }
    S.clients = []; S.room = null; S.code = null;
    toast(e.message || 'Erreur de connexion');
    show('home');
  } finally {
    busy(false);
  }
}

/** Présence (en ligne + batterie). Republiée quand la batterie change d'au moins 5 points. */
async function pubPresence(force = false) {
  if (!S.clients.length || !S.room) return;
  if (!force && S.lastBatSent != null && S.bat != null && Math.abs(S.bat - S.lastBatSent) < 5 && S.lastChgSent === S.charging) return;
  S.lastBatSent = S.bat; S.lastChgSent = S.charging;
  await pub('on/' + S.me, { on: true, t: tnow(), bat: S.bat, chg: S.charging }, { retain: true });
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
  stopBots();
  if (S.pushSub) relaySend({ t: 'sched', id: S.me, items: [] });
  if (S.clients.length) {
    if (removeMe) {
      await pub('on/' + S.me, null, { retain: true });
      await pub('p/' + S.me, { removed: true, t: tnow() }, { retain: true });
    }
    const cs = S.clients; S.clients = [];
    setTimeout(() => cs.forEach((c) => { try { c.end(); } catch { /* déjà fermé */ } }), 400);
  }
  if (replay) closeReplay();
  if (S.geoWatch != null) { navigator.geolocation.clearWatch(S.geoWatch); S.geoWatch = null; }
  keepAwake(false);
  store.del('traque.last');
  history.replaceState(null, '', location.pathname + location.search);
  S.room = null; S.code = null; S.cfg = null;
  initHome();
  show('home');
}

/* ---------- logique du jeu ---------- */
function resetLog() { S.log = []; S.logKeys = new Set(); S.logSeen = 0; S.warnedReveal = 0; S.finalSent = false; S.wasOut = false; S.endDismissed = false; S.lastOutcomeKey = null; S.hist = {}; S.nearWarned = false; S.inCircleAlerted = {}; S.catches = {}; S.mates = {}; S.tlRaw = {}; S.teamKey = null; S.teamKeyGame = null; S.teamKeyMine = false; S.tkSent = {}; S.pendingTk = null; S.track = null; S.trackSent = null; S.bonusSeen = 0; S.movedWarned = false; }
function addLog(key, t, html, { notify = false } = {}) {
  if (S.logKeys.has(key)) return;
  S.logKeys.add(key);
  S.log.push({ t, html });
  S.log.sort((a, b) => a.t - b.t);
  if (notify && S.tab !== 'log') S.logSeen = Math.min(S.logSeen, S.log.length - 1);
}
const nameOf = (id) => (S.players[id] && S.players[id].name) || 'Quelqu’un';
const isHost = () => S.cfg && S.cfg.host === S.me;
function isCaught(id) { const k = S.caught[id]; return !!k && !!S.cfg && k.gameId === S.cfg.gameId && !k.freed && !k.cleared; }
function baseRole(id) { return (S.cfg && S.cfg.roles && S.cfg.roles[id]) || (S.cfg && S.cfg.status === 'lobby' ? 'H' : 'S'); }
function roleOf(id) {
  const r = baseRole(id);
  if (r === 'F' && isCaught(id)) {
    if (S.cfg.rules.mode === 'infection') return 'H';
    return S.cfg.rules.caughtBecomesHunter && !S.cfg.rules.prison ? 'H' : 'S';
  }
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

function phase(now = tnow()) {
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
  if (c.status === 'ended') return { winner: c.winner, reason: c.endReason, at: c.endedAt, by: c.endBy };
  const fug = fugitives();
  if (c.rules.mode === 'drapeau' && S.flag && S.flag.gameId === c.gameId) return { winner: 'F', reason: 'flag', at: S.flag.t, by: S.flag.by };
  if (fug.length && fug.every(isCaught)) {
    const at = Math.max(...fug.map((id) => S.caught[id].t));
    return { winner: 'H', reason: 'all-caught', at };
  }
  if (c.rules.mode === 'infection' && fug.length >= 2) {
    const free = fug.filter((id) => !isCaught(id));
    if (free.length === 1) return { winner: 'F', reason: 'last', at: Math.max(...fug.filter(isCaught).map((id) => S.caught[id].t)), by: free[0] };
  }
  const end = c.startAt + c.rules.duration * MIN;
  if (tnow() >= end) return { winner: 'F', reason: 'time', at: end };
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
    if (prev && tnow() - data.startAt < 10000) {
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
  else if (data.kind === 'outzone' && data.why === 'moved') html = `🙈 ${mine ? 'Tu as' : `${dnb(id)} a`} quitté ${mine ? 'ta' : 'sa'} cachette, position révélée.`;
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
  const fresh = tnow() - data.t < 60000;
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
    if (tnow() - data.t < 60000) {
      beep('good');
      if (id === S.me) { toast('🔓 Tu es libre ! Cours !', 5000); notify('Tu es libre !', `${nameOf(data.by)} t'a libéré·e.`); }
      else if (roleOf(S.me) === 'H') toast(`🔓 ${nameOf(id)} s'est échappé·e de prison !`, 4000);
    }
    return;
  }
  if (data.by) S.catches[id + ':' + data.t] = data.by;
  const by = data.by ? ` par <b>${esc(nameOf(data.by))}</b>` : '';
  addLog('caught:' + id + ':' + data.t, data.t, `🎯 <b>${esc(nameOf(id))}</b> s'est fait attraper${by} !`, { notify: true });
  const tm = teamOf(id);
  if (tm != null && teamMembers(tm).every(isCaught)) addLog('teamout:' + S.cfg.gameId + ':' + tm + ':' + data.t, data.t + 1, `💀 L'équipe ${teamLabel(tm)} est éliminée !`, { notify: true });
  if (tnow() - data.t < 60000) {
    beep(id === S.me ? 'alarm' : 'good');
    if (id === S.me) toast(S.cfg.rules.prison ? '🔒 Attrapé·e ! Va à la prison (🔒 sur la carte) et attends qu’on te libère.'
      : S.cfg.rules.caughtBecomesHunter ? 'Attrapé·e ! Tu deviens chasseur 🔦' : 'Attrapé·e ! Tu passes spectateur 👀', 6000);
  }
}
function onUncaught(id) {
  if (S.caught[id] && S.cfg && S.caught[id].gameId === S.cfg.gameId) addLog('uncaught:' + id + ':' + tnow(), tnow(), `↩️ Capture de <b>${esc(nameOf(id))}</b> annulée.`);
  delete S.caught[id];
}
/** Équipe pour le chat privé : 'F' (fugitifs, prisonniers compris), 'H' (chasseurs) ou null. */
function myTeam() {
  if (!S.cfg || S.cfg.status === 'lobby') return null;
  if (roleOf(S.me) === 'H') return 'H';
  if (baseRole(S.me) !== 'F') return null;
  return S.cfg.rules.teams ? 'T' + teamOf(S.me) : 'F';
}
async function onEvent(ev) {
  if (ev.type === 'chat') {
    if (ev.team && ev.team !== myTeam()) return;
    let text = ev.text;
    if (ev.enc) { try { text = (await aesDec(S.teamKey, ev.enc)).text; } catch { return; } }
    const label = !ev.team ? '' : ev.team === 'F' ? '🏃 équipe' : ev.team === 'H' ? '🔦 équipe' : teamLabel(+ev.team.slice(1));
    const tag = label ? `<span class="team-tag">${label}</span> ` : '';
    addLog('chat:' + ev.from + ':' + ev.t, ev.t, `${tag}<span class="chat-from">${esc(nameOf(ev.from))} :</span> ${esc(text)}`, { notify: true });
    scheduleRender();
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
    const c = p.coords, now = tnow();
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
  recordTrack();
  if (S.screen === 'game') { updateSelfMarker(); dutyTick(); }
  if (S.screen === 'lobby') renderLobbyMap();
  scheduleRender();
}
/** Direction de marche (degrés, 0 = nord) ou null si on ne bouge plus depuis une minute. */
function myHeading() {
  if (!S.fix || S.fix.heading == null || !S.lastMoveT || tnow() - S.lastMoveT > 60000) return null;
  return Math.round(S.fix.heading);
}
/** Vitesse en m/s (0 si on ne bouge plus depuis 20 s). */
function mySpeed() {
  if (!S.fix || !S.lastMoveT || tnow() - S.lastMoveT > 20000) return 0;
  return +(S.fix.spd || 0).toFixed(1);
}
const kmh = (ms) => Math.round(ms * 3.6) + ' km/h';
async function publishPos(kind, extra = {}) {
  if (!S.fix) return false;
  let p = { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), acc: S.fix.acc, hdg: myHeading(), spd: mySpeed(), fixT: S.fix.t, t: tnow(), kind, gameId: S.cfg.gameId, ...extra };
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
function zoneState(t = tnow()) {
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
  if (dutyBusy || !S.cfg || !S.clients.length) return;
  dutyBusy = true;
  try {
    const ph = phase(), now = tnow(), c = S.cfg, gid = c.gameId;
    const role = roleOf(S.me), out = outcome();

    if (c.status === 'running' && !out) keepAwake(true); else keepAwake(false);
    if (c.status !== 'lobby') addLog('start:' + gid, c.startAt, `🚦 La partie commence. Les fugitifs ont <b>${minutesLabel(c.rules.headStart)}</b> d'avance.`);

    // Trajet (récap et replay) : enregistré même sans bouger ; partagé à la fin.
    recordTrack();
    if (out) await publishTrack();
    // Fin de partie : l'organisateur l'enregistre ; les fugitifs libres dévoilent leur cachette.
    if (c.status === 'running' && out) {
      if (isHost()) {
        await pubCfg({ status: 'ended', winner: out.winner, endReason: out.reason, endedAt: out.at, endBy: out.by || null, ...scoreUpdate(out) });
        pushTo(everyone(), '🏁 Partie terminée', out.winner === 'F' ? 'Victoire des fugitifs ! Ouvre Traque pour le récap.' : 'Victoire des chasseurs ! Ouvre Traque pour le récap.', 'end');
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

    // Équipes : clé d'équipe et position en direct pour les coéquipiers (même en prison, pour se faire libérer)
    if (c.rules.teams && baseRole(S.me) === 'F' && roleOf(S.me) !== 'H' && ph.name !== 'lobby') {
      await teamKeyDuty();
      await publishMate(now);
    }


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
      // Balises : +1 pouvoir pour le premier fugitif qui y passe
      if (ph.name === 'hunt' && S.fix) {
        for (const [i, m] of (c.rules.missions || []).entries()) {
          const taken = S.balises[i] && S.balises[i].gameId === gid;
          if (taken || dist(S.fix, m) > 25 + Math.min(S.fix.acc, 15)) continue;
          const gift = seededRandom(gid + '|balise|' + i)() < 0.5 ? 'jam' : 'counter';
          const data = { by: S.me, t: now, gameId: gid, gift };
          await pub('bal/' + i, data, { retain: true });
          onBalise(i, data);
        }
      }
      // Drapeau : un fugitif qui l'atteint fait gagner les fugitifs
      if (c.rules.mode === 'drapeau' && c.rules.flag && ph.name === 'hunt' && S.fix && !(S.flag && S.flag.gameId === gid)
          && dist(S.fix, c.rules.flag) <= 20 + Math.min(S.fix.acc, 15)) {
        const data = { by: S.me, t: now, gameId: gid };
        await pub('flag', data, { retain: true });
        onFlag(data);
      }
      // Cache-cache : interdit de quitter sa cachette après l'avance
      if (c.rules.mode === 'cachecache' && ph.name === 'hunt' && S.fix) {
        const key = 'traque.hide.' + gid;
        let spot = store.get(key);
        if (!spot) { spot = { lat: S.fix.lat, lng: S.fix.lng }; store.set(key, spot); }
        S.movedOut = dist(S.fix, spot) > 40 + Math.min(S.fix.acc, 30);
        if (S.movedOut && now - (S.lastMoved || 0) > OUTZONE_EVERY) {
          S.lastMoved = now; await publishPos('outzone', { lvl: 1, why: 'moved' });
          if (!S.movedWarned) { S.movedWarned = true; beep('alarm'); }
        }
        if (!S.movedOut) S.movedWarned = false;
      } else S.movedOut = false;
      // Bonus de survie
      const nb = survivalBonusCount(S.me);
      if (ph.name === 'hunt' && nb > (S.bonusSeen || 0)) {
        S.bonusSeen = nb; beep('good');
        toast(`⏱️ Bonus de survie : +1 ${nb % 2 ? 'contre-radar 🔍' : 'brouillage 🌫️'} !`, 4500);
      }
      // Prison : un fugitif libre qui y entre libère tous les prisonniers
      const pr = c.rules.prison;
      if (pr && ph.name === 'hunt' && S.fix && now - (S.lastFree || 0) > 10000 && dist(S.fix, pr) <= pr.r + Math.min(S.fix.acc, 20)) {
        const prisoners = fugitives().filter((id) => id !== S.me && isCaught(id) && (!c.rules.teams || teamOf(id) === teamOf(S.me)));
        if (prisoners.length) {
          S.lastFree = now;
          for (const id of prisoners) await pub('caught/' + id, { freed: true, by: S.me, t: now, gameId: gid }, { retain: true });
          pushTo(prisoners, '🔓 Tu es libre !', `${S.name} t’a libéré·e de prison : cours !`, 'free');
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
      const eco = ecoOn();
      const every = Math.max(c.rules.liveEvery * 1000, eco ? 15000 : 0), keep = eco ? 60000 : Math.max(20000, every);
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
  S.cfg = { ...S.cfg, ...patch, rev: (S.cfg.rev || 0) + 1, updatedAt: tnow() };
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
  if (S.cfg.rules.teams && new Set(Object.keys(roles).filter((id) => roles[id] === 'F').map(teamOf)).size < 2) {
    toast('Il faut des fugitifs dans au moins 2 équipes (ou mets « Équipes : non »).'); return;
  }
  const r = S.cfg.rules;
  if (r.mode === 'drapeau' && !r.flag) { toast('🚩 Place d’abord le drapeau sur la carte (bouton « 🚩 Drapeau »).'); return; }
  const ok = await confirmBox('Lancer la partie ?',
    `${nF} fugitif${nF > 1 ? 's' : ''} contre ${nH} chasseur${nH > 1 ? 's' : ''}. ${minutesLabel(r.headStart)} d'avance, révélation toutes les ${minutesLabel(r.interval)}, ${minutesLabel(r.duration)} au total.${r.prison ? ' Prison active : les fugitifs attrapés peuvent être libérés.' : ''}${r.anon ? ' Mode anonyme.' : ''}${r.zone ? (r.shrink > 0 ? ' La zone rétrécit au fil du temps.' : '') : ' Aucune zone de jeu définie.'}${r.fuzzy > 0 ? ` Les fugitifs apparaissent dans un cercle de ${fmtDist(r.fuzzy)}.` : ''}`,
    'C’est parti !');
  if (!ok) return;
  pushTo(everyone(), '🚦 C’est parti !', `La partie commence : les fugitifs ont ${minutesLabel(r.headStart)} d’avance. Ouvre Traque.`, 'start');
  await pubCfg({ status: 'running', startAt: tnow(), gameId: randStr(8), roles, winner: null, endReason: null, endedAt: null });
}
async function catchSelf() {
  const ok = await confirmBox('Tu t’es fait attraper ?', 'Tout le monde sera prévenu.', 'Oui, attrapé·e', 'fug');
  if (!ok) return;
  await pub('caught/' + S.me, { by: null, t: tnow(), gameId: S.cfg.gameId }, { retain: true });
  pushTo(everyone(), '🎯 Capture !', `${S.name} s’est fait attraper.`, 'catch');
}
async function catchSomeone() {
  const free = fugitives().filter((id) => !isCaught(id));
  if (!free.length) { toast('Plus aucun fugitif en fuite.'); return; }
  const body = '<p>Qui as-tu touché ?</p><div class="pick-list">' +
    free.map((id) => `<button class="btn" data-pick="${esc(id)}">🏃 ${esc(nameOf(id))}</button>`).join('') + '</div>';
  const id = await ask('J’ai attrapé…', body, [{ label: 'Annuler', value: null, cls: 'ghost' }]);
  if (!id) return;
  await pub('caught/' + id, { by: S.me, t: tnow(), gameId: S.cfg.gameId }, { retain: true });
  pushTo(everyone(), '🎯 Capture !', `${nameOf(id)} s’est fait attraper par ${S.name}.`, 'catch');
}
async function usePing() {
  const used = pingTimes().length, left = S.cfg.rules.pings - used;
  if (left <= 0) { toast('Plus de radar disponible.'); return; }
  const ok = await confirmBox('Lancer un radar ?', `La position de tous les fugitifs sera révélée maintenant. Il en restera ${left - 1} à l'équipe.`, '📡 Lancer');
  if (!ok) return;
  const mine = S.pings[S.me] && S.pings[S.me].gameId === S.cfg.gameId ? S.pings[S.me].list : [];
  const next = { gameId: S.cfg.gameId, list: [...mine, tnow()] };
  S.pings[S.me] = next;
  await pub('pings/' + S.me, next, { retain: true });
  pushTo(fugitives().filter((id) => !isCaught(id)), '📡 Radar !', 'Les chasseurs lancent un radar : ouvre Traque tout de suite pour envoyer ta position.', 'radar');
  addLog('pinguse:' + S.me + ':' + next.list.at(-1), next.list.at(-1), `📡 <b>${esc(S.name)}</b> lance un radar.`);
  scheduleRender();
}
/* ---------- pouvoirs des fugitifs ---------- */
const myPowers = (id) => (S.powers[id] && S.cfg && S.powers[id].gameId === S.cfg.gameId ? S.powers[id].list : []);
const powersUsed = (id, type) => myPowers(id).filter((x) => x.type === type).length;
/** Nombre de bonus de survie gagnés (un toutes les N minutes passées sans se faire attraper). */
function survivalBonusCount(id) {
  const c = S.cfg;
  if (!c || !c.rules.bonusEvery || c.status === 'lobby' || !c.startAt) return 0;
  const release = c.startAt + c.rules.headStart * MIN;
  const until = isCaught(id) ? S.caught[id].t : Math.min(tnow(), c.endedAt || Infinity);
  return Math.max(0, Math.floor((until - release) / (c.rules.bonusEvery * MIN)));
}
function bonusPowers(id, type) {
  let n = 0;
  for (const b of Object.values(S.balises)) if (S.cfg && b.gameId === S.cfg.gameId && b.by === id && b.gift === type) n++;
  const k = survivalBonusCount(id); // en alternance : contre-radar, brouillage, contre-radar…
  return n + (type === 'counter' ? Math.ceil(k / 2) : Math.floor(k / 2));
}
const powersTotal = (id, type) => (type === 'jam' ? S.cfg.rules.jams : S.cfg.rules.counters) + bonusPowers(id, type);
const powersLeft = (id, type) => powersTotal(id, type) - powersUsed(id, type);
const jammed = (id, idx) => myPowers(id).some((x) => x.type === 'jam' && x.idx === idx);
function counterLeft(id) {
  const last = myPowers(id).filter((x) => x.type === 'counter').map((x) => x.t).sort((a, b) => b - a)[0];
  return last ? Math.max(0, last + COUNTER_MS - tnow()) : 0;
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
  if (!lp || tnow() - lp.t > 60000) return null;
  if (myPowers(S.me).some((x) => x.type === 'riposte' && x.pingT === lp.t)) return null;
  return lp;
}
const riposteOn = (target) => myPowers(S.me).some((x) => x.type === 'riposte' && x.target === target && tnow() - x.t < COUNTER_MS);
function riposteLeft() {
  const x = myPowers(S.me).filter((y) => y.type === 'riposte').sort((a, b) => b.t - a.t)[0];
  return x ? { left: Math.max(0, x.t + COUNTER_MS - tnow()), target: x.target } : { left: 0 };
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
    const fresh = tnow() - x.t < 30000 && !S.logKeys.has('pw:' + id + ':' + x.t);
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
  const entry = { type: 'riposte', t: tnow(), target: lp.by, pingT: lp.t };
  const data = { gameId: S.cfg.gameId, list: [...myPowers(S.me), entry] };
  S.powers[S.me] = data;
  await pub('pw/' + S.me, data, { retain: true });
  onPowers(S.me, data);
  setTimeout(() => { if (markers[lp.by] && gameMap) gameMap.setView(markers[lp.by].getLatLng(), Math.max(gameMap.getZoom(), 16)); }, 500);
  scheduleRender();
}
async function usePower(type) {
  const ph = phase(), r = S.cfg.rules;
  const left = powersLeft(S.me, type); void r;
  if (left <= 0 || ph.name !== 'hunt') return;
  const ok = type === 'jam'
    ? await confirmBox('Brouiller ta prochaine révélation ?', 'Les chasseurs ne recevront pas ta position à la prochaine révélation (ils sauront qu’elle est brouillée). Les radars marchent quand même.', '🌫️ Brouiller')
    : await confirmBox('Lancer un contre-radar ?', 'Tu vois tous les chasseurs sur la carte pendant 30 s. Ils seront prévenus.', '🔍 Lancer');
  if (!ok) return;
  const entry = { type, t: tnow() };
  if (type === 'jam') entry.idx = ph.k + 1;
  const data = { gameId: S.cfg.gameId, list: [...myPowers(S.me), entry] };
  S.powers[S.me] = data;
  await pub('pw/' + S.me, data, { retain: true });
  onPowers(S.me, data);
  if (type === 'counter' && gameMap) setTimeout(fitAll, 400);
  scheduleRender();
}

/* ---------- équipes de fugitifs ----------
 * Les coéquipiers se voient en direct. Leurs positions sont chiffrées avec une clé d'équipe que les chasseurs
 * (organisateur compris) ne peuvent pas lire : la clé est transmise de téléphone à téléphone par échange de clés
 * (ECDH), chaque téléphone ayant sa propre paire de clés. */
const TEAMS = [
  { n: 'Rouges', e: '🔴', c: '#e03131' }, { n: 'Violets', e: '🟣', c: '#9c36b5' },
  { n: 'Verts', e: '🟢', c: '#2f9e44' }, { n: 'Jaunes', e: '🟡', c: '#f08c00' },
];
function teamOf(id) {
  const c = S.cfg;
  if (!c || !c.rules.teams || baseRole(id) !== 'F') return null;
  return ((c.teams && c.teams[id]) || 0) % c.rules.teams;
}
const teamLabel = (t) => (t == null ? '' : `${TEAMS[t].e} ${TEAMS[t].n}`);
/** Répartit les fugitifs présents en `n` équipes équilibrées (au hasard). */
function distributeTeams(n, roles = S.cfg.roles) {
  const fug = Object.keys(S.players).filter((id) => (roles[id] || 'H') === 'F');
  const shuffled = fug.map((id) => [crypto.getRandomValues(new Uint32Array(1))[0], id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const teams = {};
  shuffled.forEach((id, i) => { teams[id] = i % n; });
  return teams;
}
function smallestTeam(except) {
  const n = S.cfg.rules.teams, count = Array(n).fill(0);
  for (const id of Object.keys(S.cfg.roles)) if (id !== except && S.cfg.roles[id] === 'F') count[((S.cfg.teams || {})[id] || 0) % n]++;
  return count.indexOf(Math.min(...count));
}
const teamMembers = (t) => fugitives().filter((id) => teamOf(id) === t);
const aliveTeams = () => [...new Set(fugitives().filter((id) => !isCaught(id)).map(teamOf))].filter((t) => t != null).sort();

async function aesEnc(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return { iv: b64(iv), ct: b64(ct) };
}
async function aesDec(key, d) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(d.iv) }, key, unb64(d.ct));
  return JSON.parse(td.decode(pt));
}
const EC = { name: 'ECDH', namedCurve: 'P-256' };
async function myKeyPair() {
  if (S.ecdh) return;
  try {
    let jwk = store.get('traque.ecdh');
    if (!jwk) {
      const kp = await crypto.subtle.generateKey(EC, true, ['deriveKey']);
      jwk = { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      store.set('traque.ecdh', jwk);
    }
    S.ecdh = { pub: { kty: jwk.pub.kty, crv: jwk.pub.crv, x: jwk.pub.x, y: jwk.pub.y }, priv: await crypto.subtle.importKey('jwk', jwk.priv, EC, false, ['deriveKey']) };
  } catch { S.ecdh = null; /* navigateur trop ancien : pas de position d'équipe en direct */ }
}
async function sharedKey(pubJwk) {
  const pub = await crypto.subtle.importKey('jwk', pubJwk, EC, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, S.ecdh.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function setTeamKey(raw, gameId, t) {
  S.teamKey = await crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  S.teamKeyGame = gameId; S.teamKeyT = t;
  await decodeMates();
}
/** Clé d'équipe reçue d'un coéquipier (chiffrée pour moi seul). */
async function onTeamKey(data) {
  if (!S.cfg || data.gameId !== S.cfg.gameId || !S.ecdh) return;
  const from = S.players[data.from];
  if (!from || !from.pk) { S.pendingTk = data; return; }
  if (S.teamKeyGame === data.gameId && S.teamKeyT && data.t < S.teamKeyT) return;
  try {
    const { k } = await aesDec(await sharedKey(from.pk), data);
    await setTeamKey(k, data.gameId, data.t);
    S.pendingTk = null;
  } catch { /* pas pour cette clé */ }
}
/** Le « chef » d'équipe (plus petit identifiant) crée la clé et l'envoie à chaque coéquipier. */
async function teamKeyDuty() {
  const c = S.cfg;
  if (!c.rules.teams || c.status !== 'running' || !S.ecdh || roleOf(S.me) === 'H') return;
  const t = teamOf(S.me);
  if (t == null) return;
  if (S.pendingTk) await onTeamKey(S.pendingTk);
  const members = teamMembers(t).filter((id) => S.players[id] && S.players[id].pk).sort();
  if (members[0] !== S.me) return;
  const store_key = 'traque.tk.' + c.gameId;
  let raw = store.get(store_key);
  if (!raw) { raw = b64(crypto.getRandomValues(new Uint8Array(32))); store.set(store_key, raw); }
  if (S.teamKeyGame !== c.gameId || !S.teamKeyMine) { S.teamKeyMine = true; await setTeamKey(raw, c.gameId, tnow()); }
  S.tkSent = S.tkSent || {};
  for (const m of members) {
    if (m === S.me || S.tkSent[m] === c.gameId + ':' + JSON.stringify(S.players[m].pk.x)) continue;
    const enc = await aesEnc(await sharedKey(S.players[m].pk), { k: raw });
    await pub('tk/' + m, { gameId: c.gameId, team: t, from: S.me, t: S.teamKeyT, ...enc }, { retain: true });
    S.tkSent[m] = c.gameId + ':' + JSON.stringify(S.players[m].pk.x);
  }
}
/** Position en direct pour mon équipe (chiffrée avec la clé d'équipe). */
async function publishMate(now) {
  if (!S.teamKey || S.teamKeyGame !== S.cfg.gameId || !S.fix) return;
  const every = ecoOn() ? 15000 : 5000;
  if (now - (S.lastMate || 0) < every && !(S.fix.t > (S.lastMate || 0) && now - (S.lastMate || 0) > every)) return;
  S.lastMate = now;
  const enc = await aesEnc(S.teamKey, { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), acc: S.fix.acc, hdg: myHeading(), spd: mySpeed(), t: now });
  await pub('tl/' + S.me, { gameId: S.cfg.gameId, t: now, ...enc }, { retain: true });
}
async function decodeMates() {
  if (!S.teamKey || !S.cfg) return;
  for (const [id, d] of Object.entries(S.tlRaw)) {
    if (d.gameId !== S.cfg.gameId || teamOf(id) !== teamOf(S.me) || id === S.me) continue;
    try { S.mates[id] = { ...(await aesDec(S.teamKey, d)), gameId: d.gameId }; delete S.tlRaw[id]; } catch { /* clé d'une autre équipe ou en cours de changement */ }
  }
  scheduleRender();
}
/** Coéquipier visible en direct (ou null). */
function mateLive(id) {
  const c = S.cfg;
  if (!c || !c.rules.teams || id === S.me || baseRole(S.me) !== 'F' || roleOf(S.me) === 'H' || teamOf(id) !== teamOf(S.me)) return null;
  const m = S.mates[id];
  return m && m.gameId === c.gameId ? { ...m, kind: 'mate' } : null;
}

/* ---------- mode test ----------
 * Tout le monde voit la position exacte de tout le monde, et un onglet « Test » montre l'état de chaque téléphone
 * (relais, GPS, batterie, horloge, version). Les points du classement ne sont pas comptés. */
const testOn = () => !!(S.cfg && S.cfg.rules.testMode);
async function publishDebug() {
  const now = tnow();
  if (now - (S.lastDbg || 0) < 3000) return;
  S.lastDbg = now;
  const ua = navigator.userAgent, os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : 'Autre';
  await pub('dbg/' + S.me, {
    t: now, lat: S.fix ? +S.fix.lat.toFixed(6) : null, lng: S.fix ? +S.fix.lng.toFixed(6) : null, acc: S.fix ? S.fix.acc : null,
    spd: mySpeed(), hdg: myHeading(), bat: S.bat, chg: S.charging, role: roleOf(S.me), ver: APP_VERSION,
    relays: S.clients.map((c) => (c.connected ? 1 : 0)), off: CLOCK_OFF, geo: S.geoErr || null,
    vis: document.visibilityState, wake: !!S.wake, os,
  }, { retain: true });
}
function dbgPos(id) {
  const d = S.dbg[id];
  if (!testOn() || id === S.me || !d || d.lat == null || tnow() - d.t > 60000) return null;
  return { lat: d.lat, lng: d.lng, hdg: d.hdg, spd: d.spd, acc: d.acc, t: d.t, kind: roleOf(id) === 'H' ? 'live' : 'test', gameId: S.cfg.gameId };
}
function renderTest() {
  const el = $('#tab-test');
  if (!testOn() || S.tab !== 'test') return;
  const c = S.cfg, now = tnow(), dot = (on) => (on ? '🟢' : '⚪');
  const relays = S.relayUrls.map((u, i) => `<li>${dot(S.clients[i] && S.clients[i].connected)} ${esc(relayName(u))} · ${S.relayStats[i] || 0} messages reçus</li>`).join('');
  const kinds = Object.entries(S.kindStats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} : ${n}`).join(' · ');
  const rows = sortedPlayers().map((id) => {
    const d = id === S.me ? { acc: S.fix && S.fix.acc, spd: mySpeed(), bat: S.bat, chg: S.charging, ver: APP_VERSION, relays: S.clients.map((x) => (x.connected ? 1 : 0)), off: CLOCK_OFF, t: now, geo: S.geoErr, os: '' } : S.dbg[id];
    if (!d) return `<tr><td>${esc(avatarOf(id))} ${esc(nameOf(id))}</td><td colspan="6" class="muted">pas d'infos (mode test activé après son arrivée ?)</td></tr>`;
    const old = now - d.t > 15000;
    return `<tr class="${old ? 'stale' : ''}">
      <td>${esc(avatarOf(id))} ${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''}<div class="muted">${ROLE_LABEL[roleOf(id)] || ''}${d.os ? ' · ' + esc(d.os) : ''}</div></td>
      <td>${d.geo ? '❌ ' + esc(d.geo) : d.acc != null ? '±' + d.acc + ' m' : '…'}</td>
      <td>${d.spd >= 0.5 ? kmh(d.spd) : '—'}</td>
      <td>${d.bat != null ? (d.chg ? '⚡' : '') + d.bat + ' %' : '—'}</td>
      <td>${(d.relays || []).map((x) => (x ? '●' : '○')).join('')}</td>
      <td class="${d.ver !== APP_VERSION ? 'warn' : ''}">${esc((d.ver || '?').slice(5))}</td>
      <td>${old ? ago(d.t).replace('il y a ', '') : 'ok'}${d.off ? `<div class="muted">horloge ${d.off > 0 ? '+' : ''}${(d.off / 1000).toFixed(1)} s</div>` : ''}</td>
    </tr>`;
  }).join('');
  const host = isHost() && c.status === 'running' && !outcome();
  const html = `
    ${host ? `<div class="test-ctrl"><button class="btn small" data-test="skip1">⏩ +1 min</button><button class="btn small" data-test="skip5">⏩ +5 min</button><button class="btn small" data-test="reveal">📍 Révélation tout de suite</button></div>` : ''}
    <h4>Ce téléphone</h4>
    <ul class="test-list">
      <li>Version ${esc(APP_VERSION)} · horloge corrigée de ${(CLOCK_OFF / 1000).toFixed(1)} s · écran ${S.wake ? 'maintenu allumé' : 'normal'}</li>
      <li>GPS : ${S.geoErr ? '❌ ' + esc(S.geoErr) : S.fix ? `±${S.fix.acc} m, mis à jour ${ago(S.fix.t)}` : 'en attente…'}</li>
      ${relays}
      <li class="muted">Messages par type : ${kinds || '—'}</li>
    </ul>
    <h4>Joueurs</h4>
    <div class="test-table"><table><thead><tr><th>Joueur</th><th>GPS</th><th>Vitesse</th><th>Batt.</th><th>Relais</th><th>Version</th><th>Vu</th></tr></thead><tbody>${rows}</tbody></table></div>
    <details><summary>Configuration de la partie (brute)</summary><pre>${esc(JSON.stringify(c, null, 1))}</pre></details>`;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-test]');
  if (!b || !isHost() || !S.cfg || S.cfg.status !== 'running') return;
  const c = S.cfg, ph = phase();
  if (b.dataset.test === 'skip1' || b.dataset.test === 'skip5') {
    const m = b.dataset.test === 'skip1' ? 1 : 5;
    await pubCfg({ startAt: c.startAt - m * MIN });
    toast(`⏩ La partie avance de ${m} min`);
  } else if (b.dataset.test === 'reveal') {
    // Décale le temps juste avant la prochaine révélation.
    const target = ph.name === 'head' ? ph.release : ph.nextReveal;
    if (!target) { toast('Plus de révélation prévue.'); return; }
    await pubCfg({ startAt: c.startAt - (target - tnow()) - 500 });
    toast('📍 Révélation déclenchée');
  }
});

/* ---------- balises et drapeau ---------- */
function onBalise(i, data) {
  S.balises[i] = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId) return;
  const gift = data.gift === 'jam' ? 'brouillage 🌫️' : 'contre-radar 🔍';
  const mine = data.by === S.me;
  addLog('bal:' + i + ':' + data.gameId, data.t, mine ? `🎁 Tu as pris une balise : +1 ${gift} !` : `🎁 ${dnb(data.by)} a pris une balise (+1 ${gift}).`, { notify: true });
  if (tnow() - data.t < 30000) {
    if (mine) { beep('good'); toast(`🎁 Balise prise : +1 ${gift} !`, 4500); }
    else if (roleOf(S.me) === 'H') toast(`🎁 ${dn(data.by)} a pris une balise`, 3000);
  }
  scheduleRender();
}
function onFlag(data) {
  S.flag = data;
  if (!S.cfg || data.gameId !== S.cfg.gameId) return;
  addLog('flag:' + data.gameId, data.t, `🚩 <b>${esc(nameOf(data.by))}</b> a capturé le drapeau !`, { notify: true });
  if (tnow() - data.t < 30000) beep(data.by === S.me ? 'good' : 'alarm');
  scheduleRender();
}

/* ---------- classement de la soirée ---------- */
function scoreUpdate(out) {
  const c = S.cfg;
  if (c.scoredGame === c.gameId || c.rules.testMode) return {};
  const scores = { ...(c.scores || {}) };
  const add = (id, n) => { if (n) scores[id] = (scores[id] || 0) + n; };
  const release = c.startAt + c.rules.headStart * MIN, end = out.at || tnow();
  for (const id of fugitives()) {
    const k = isCaught(id) ? S.caught[id] : null;
    add(id, Math.floor(Math.max(0, (k ? k.t : end) - release) / (5 * MIN))); // 1 pt toutes les 5 min de survie
    if (!k) add(id, 5);                                                       // jamais attrapé
    if (out.by === id) add(id, 5);                                            // drapeau ou dernier survivant
  }
  for (const by of Object.values(S.catches)) add(by, 3);                     // 3 pts par capture
  if (out.winner === 'H') for (const id of Object.keys(c.roles)) if (c.roles[id] === 'H') add(id, 2);
  if (c.rules.teams && out.winner === 'F') for (const id of fugitives()) if (aliveTeams().includes(teamOf(id))) add(id, 3); // équipe survivante
  return { scores, scoredGame: c.gameId, games: (c.games || 0) + 1 };
}
function renderScores() {
  const c = S.cfg, sc = c.scores || {};
  const ids = Object.keys(sc).filter((id) => sc[id] > 0).sort((a, b) => sc[b] - sc[a]);
  $('#score-card').hidden = !ids.length;
  if (!ids.length) return;
  const medal = ['🥇', '🥈', '🥉'];
  $('#scores').innerHTML = ids.map((id, i) => `<li><span>${medal[i] || (i + 1) + '.'}</span> ${esc(avatarOf(id))} <b>${esc(nameOf(id))}</b><span class="pts">${sc[id]} pt${sc[id] > 1 ? 's' : ''}</span></li>`).join('');
  $('#scores-hint').textContent = `${c.games || 0} partie${(c.games || 0) > 1 ? 's' : ''} jouée${(c.games || 0) > 1 ? 's' : ''}. Fugitif : 1 pt toutes les 5 min de survie, +5 si jamais attrapé, +3 si son équipe survit. Chasseur : 3 pts par capture, +2 si victoire.`;
  $('#btn-score-reset').hidden = !isHost();
}

/* ---------- trajets : enregistrement, récap, replay ---------- */
function recordTrack() {
  const c = S.cfg;
  if (!c || c.status !== 'running' || !S.fix || outcome()) return;
  const key = 'traque.trk.' + c.gameId;
  if (!S.track || S.trackGame !== c.gameId) { S.track = store.get(key) || []; S.trackGame = c.gameId; }
  const last = S.track[S.track.length - 1], now = tnow();
  if (last && now - last[0] < 8000 && dist({ lat: last[1], lng: last[2] }, S.fix) < 15) return;
  S.track.push([now, +S.fix.lat.toFixed(5), +S.fix.lng.toFixed(5)]);
  if (S.track.length > 1500) S.track.splice(0, S.track.length - 1500);
  if (now - (S.trackSaved || 0) > 30000) { S.trackSaved = now; store.set(key, S.track); }
}
function trackStats(pts) {
  let d = 0, vmax = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = (b[0] - a[0]) / 1000;
    if (dt <= 0) continue;
    const seg = dist({ lat: a[1], lng: a[2] }, { lat: b[1], lng: b[2] }), v = seg / dt;
    if (v < 12) { d += seg; if (dt >= 5) vmax = Math.max(vmax, v); } // au-delà de 43 km/h : saut de GPS ignoré
  }
  return { dist: Math.round(d), vmax: +vmax.toFixed(1) };
}
async function publishTrack() {
  const c = S.cfg;
  if (!c || S.trackSent === c.gameId) return;
  S.trackSent = c.gameId;
  const pts = (S.track && S.trackGame === c.gameId ? S.track : store.get('traque.trk.' + c.gameId)) || [];
  if (!pts.length) return;
  const step = Math.ceil(pts.length / 400);
  const sample = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const st = trackStats(pts);
  await pub('trk/' + S.me, {
    gameId: c.gameId, t: tnow(), role: baseRole(S.me), ...st,
    pts: sample.map((x) => [Math.round((x[0] - c.startAt) / 1000), Math.round(x[1] * 1e5), Math.round(x[2] * 1e5)]),
  }, { retain: true });
}
const gameTracks = () => Object.entries(S.tracks).filter(([, t]) => S.cfg && t.gameId === S.cfg.gameId);
function recapHtml(out) {
  const c = S.cfg, tr = Object.fromEntries(gameTracks());
  const catches = {};
  for (const by of Object.values(S.catches)) catches[by] = (catches[by] || 0) + 1;
  const ids = Object.keys(c.roles);
  const rows = ids.map((id) => {
    const t = tr[id], bits = [];
    if (t) { bits.push(`${fmtDist(t.dist)} parcourus`); if (t.vmax >= 0.5) bits.push(`max ${kmh(t.vmax)}`); }
    if (c.roles[id] === 'F') {
      const k = isCaught(id) ? S.caught[id] : null;
      bits.push(k ? `attrapé·e après ${clock(k.t - c.startAt)}` : 'jamais attrapé·e');
    }
    if (catches[id]) bits.push(`${catches[id]} capture${catches[id] > 1 ? 's' : ''}`);
    return `<li>${c.roles[id] === 'F' ? '🏃' : '🔦'} ${esc(avatarOf(id))} <b>${esc(nameOf(id))}</b> : ${bits.join(' · ') || '—'}</li>`;
  });
  const awards = [];
  const best = (f) => ids.map((id) => [id, f(id)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
  const h = best((id) => catches[id] || 0);
  if (h) awards.push(`🏆 Meilleur chasseur : <b>${esc(nameOf(h[0]))}</b> (${h[1]} capture${h[1] > 1 ? 's' : ''})`);
  const f = best((id) => (c.roles[id] === 'F' ? (isCaught(id) ? S.caught[id].t - c.startAt : (out.at || tnow()) - c.startAt + 1) : 0));
  if (f) awards.push(`🏃 Meilleur fugitif : <b>${esc(nameOf(f[0]))}</b>`);
  const m = best((id) => (tr[id] ? tr[id].dist : 0));
  if (m) awards.push(`👟 Marathonien : <b>${esc(nameOf(m[0]))}</b> (${fmtDist(m[1])})`);
  const v = best((id) => (tr[id] ? tr[id].vmax : 0));
  if (v) awards.push(`⚡ Fusée : <b>${esc(nameOf(v[0]))}</b> (${kmh(v[1])})`);
  const teamRows = c.rules.teams ? TEAMS.slice(0, c.rules.teams).map((tt, i) => {
    const mem = teamMembers(i);
    if (!mem.length) return '';
    const free = mem.filter((id) => !isCaught(id)).length;
    return `<li class="team-row" style="--team:${tt.c}">${teamLabel(i)} : ${free ? `${free} survivant${free > 1 ? 's' : ''} sur ${mem.length} ✅` : 'éliminée 💀'}</li>`;
  }).join('') : '';
  return (awards.length ? `<li class="awards">${awards.join('<br>')}</li>` : '') + teamRows + rows.join('');
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

/* ---------- notifications automatiques (Web Push, sans appli tierce) ----------
 * Le téléphone s'abonne aux notifications du navigateur avec la clé publique de notre relais Cloudflare.
 * Chaque joueur envoie au relais ses rappels (révélation, zone, fin…) : le relais les déclenche à l'heure,
 * même appli fermée. Les événements (début, radar, capture…) sont envoyés par le joueur qui les provoque.
 * Sur iPhone, Apple ne les autorise que si Traque est ajouté à l'écran d'accueil. */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const PUSH_KEY_URL = OUR_RELAY ? OUR_RELAY.replace(/^ws/, 'http').replace(/\/relay\/$/, '/push-key') : null;
const LEAD = Math.min(60000, MIN); // rappels 1 min avant
function relaySend(obj) {
  for (const c of S.clients) if (c.raw && c.connected) c.raw(obj);
}
const urlB64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function pushKey() {
  if (S.pushKey) return S.pushKey;
  const res = await fetch(PUSH_KEY_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('clé indisponible');
  S.pushKey = (await res.text()).trim();
  return S.pushKey;
}
/** Abonne ce téléphone (à appeler sur un geste du joueur la première fois). */
async function enablePush() {
  if (!pushSupported() || !PUSH_KEY_URL) throw new Error('unsupported');
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const reg = await navigator.serviceWorker.ready;
  const key = await pushKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = urlB64ToBytes(key);
    if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
  S.pushSub = sub.toJSON();
  store.set('traque.push', true);
  return S.pushSub;
}
/** Au retour dans une partie : reprend l'abonnement sans rien demander. */
async function initPush() {
  try {
    if (!store.get('traque.push') || !pushSupported() || Notification.permission !== 'granted') return;
    await enablePush();
    registerPush();
  } catch { /* on réessaiera via le bouton */ }
}
function registerPush(test = false) {
  if (!S.pushSub || !S.me || !S.room) return;
  relaySend({ t: 'sub', id: S.me, sub: S.pushSub, test });
  S.lastSchedKey = null; // renvoyer les rappels (le relais a pu redémarrer)
}
async function disablePush() {
  relaySend({ t: 'sub', id: S.me, sub: null });
  relaySend({ t: 'sched', id: S.me, items: [] });
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch { /* déjà fait */ }
  S.pushSub = null;
  store.set('traque.push', false);
}
/** Rappels de ce joueur pour la partie en cours (vide hors partie : annule les rappels restants). */
function computeSchedule() {
  const c = S.cfg;
  if (!c || c.status !== 'running' || outcome() || S.solo) return [];
  const r = c.rules, release = c.startAt + r.headStart * MIN, end = c.startAt + r.duration * MIN, now = tnow();
  const role = roleOf(S.me), free = baseRole(S.me) === 'F' && !isCaught(S.me);
  if (role === 'S' && !free) return [];
  const items = [];
  // Liste complète de la partie (pas filtrée sur l'heure) : elle ne change que si la partie change.
  const add = (at, title, body, tag) => { if (at > c.startAt && at < end) items.push({ at: Math.round(at), title, body, tag }); };
  void now;
  if (free) {
    for (let t = release, k = 0; t < end; t += r.interval * MIN, k++) {
      if (!jammed(S.me, k)) add(t - LEAD, '📍 Révélation dans 1 min', 'Ouvre Traque pour envoyer ta position aux chasseurs.', 'reveal');
    }
  }
  if (role === 'H' && r.headStart >= 1) add(release, '🔓 Les chasseurs sont lâchés !', 'La chasse commence : ouvre Traque.', 'release');
  const sc = zoneSchedule();
  if (sc && sc.n) for (let i = 0; i < sc.n; i++) add(sc.release + (i + SHRINK_HOLD) * sc.step - LEAD, '⭕ La zone rétrécit dans 1 min', 'Vérifie que tu seras dans la prochaine zone.', 'zone');
  if (r.duration > 10) add(end - 5 * MIN, '⏱️ Plus que 5 minutes !', 'Dernière ligne droite.', 'end5');
  return items;
}
function pushSchedule() {
  if (!S.pushSub || !S.room) return;
  const items = computeSchedule();
  const key = (S.cfg && S.cfg.gameId) + ':' + JSON.stringify(items.map((x) => [x.at, x.tag]));
  if (key === S.lastSchedKey) return;
  S.lastSchedKey = key;
  // On n'envoie que les rappels encore à venir (un rappel déjà passé ne doit pas repartir).
  const now = tnow();
  relaySend({ t: 'sched', id: S.me, items: items.filter((x) => x.at > now + 1500).slice(0, 80) });
}
/** Notification d'événement aux autres joueurs listés (seulement ceux qui ont activé les notifications la reçoivent). */
function pushTo(ids, title, body, tag) {
  const to = ids.filter((id) => id !== S.me && !String(id).startsWith('bot'));
  if (to.length) relaySend({ t: 'push', to, title, body, tag });
}
const everyone = () => Object.keys(S.players);
function openNotifications() {
  let body;
  if (!pushSupported() || !PUSH_KEY_URL) {
    body = isIOS && !standalone()
      ? `<p>Sur iPhone, Apple n'autorise les notifications que si Traque est installé sur l'écran d'accueil :</p>
         <ol class="steps"><li>Dans Safari, touche le bouton <b>Partager</b> (carré avec une flèche).</li><li>Choisis <b>Sur l'écran d'accueil</b>.</li><li>Ouvre Traque depuis la nouvelle icône, rejoins la partie et reviens ici.</li></ol>`
      : '<p>Ce navigateur ne gère pas les notifications. Utilise Chrome sur Android, ou Safari sur iPhone (depuis l’écran d’accueil).</p>';
  } else if (Notification.permission === 'denied') {
    body = '<p>Les notifications sont bloquées pour Traque. Autorise-les dans les réglages du navigateur (cadenas à côté de l’adresse › Notifications), puis reviens ici.</p>';
  } else {
    body = `<p>Reçois les infos importantes <b>même quand Traque est fermé</b> :</p>
      <ul class="steps"><li>📍 1 min avant chacune de tes révélations</li><li>📡 quand un radar est lancé</li><li>⭕ avant chaque rétrécissement de la zone</li><li>🎯 captures, 🔓 libérations, 🚦 début et 🏁 fin de partie</li></ul>
      <p class="hint">Aucune appli à installer. Les rappels sont annulés si la partie s'arrête plus tôt.</p>
      <div class="rem-actions">${S.pushSub
        ? '<span class="push-on">✅ Activées sur ce téléphone</span><button class="btn small" data-push="test">Envoyer un test</button><button class="btn small ghost" data-push="off">Désactiver</button>'
        : '<button class="btn primary" data-push="on">🔔 Activer les notifications</button>'}</div>`;
  }
  ask('🔔 Notifications', body, [{ label: 'Fermer', value: null, cls: 'ghost' }]);
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-push]');
  if (!b) return;
  const act = b.dataset.push;
  try {
    if (act === 'on') { b.disabled = true; await enablePush(); registerPush(true); toast('🔔 Notifications activées : un test arrive.'); }
    else if (act === 'test') { registerPush(true); toast('Test envoyé.'); }
    else if (act === 'off') { await disablePush(); toast('Notifications désactivées.'); }
  } catch (err) {
    toast(err.message === 'denied' ? 'Notifications refusées : autorise-les dans les réglages du navigateur.' : 'Impossible d’activer les notifications sur ce navigateur.');
  }
  $('#modal').hidden = true;
  setTimeout(openNotifications, 150);
  scheduleRender();
});

async function shareLink() {
  const url = `${location.origin}${location.pathname}#join=${S.code}`;
  const text = `Rejoins ma partie de Traque (code ${S.code})`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Traque', text, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Lien copié !'); } catch { prompt('Copie ce lien :', url); }
}

/* ---------- cartes ---------- */
/* Fonds de carte en haute définition ({r} = tuiles @2x sur les écrans de téléphone). */
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
/* Fonds de carte gratuits et sans clé d'accès. (CARTO, utilisé avant, exige désormais une clé.) */
const OSMFR_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · tuiles <a href="https://www.openstreetmap.fr">OSM France</a>';
const ESRI = (path) => `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;
const MAP_STYLES = {
  plan: { name: 'Plan', layers: [{ url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', opts: { subdomains: 'abc', maxNativeZoom: 20, maxZoom: 20 } }], attr: OSMFR_ATTR },
  // Mode sombre : le même plan, inversé en couleurs (aucun fournisseur gratuit de tuiles sombres sans clé).
  sombre: { name: 'Sombre', dark: true, layers: [{ url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', opts: { subdomains: 'abc', maxNativeZoom: 20, maxZoom: 20, className: 'tiles-dark' } }], attr: OSMFR_ATTR },
  satellite: {
    name: 'Satellite', dark: true,
    layers: [
      { url: ESRI('World_Imagery'), opts: { maxNativeZoom: 19, maxZoom: 20 } },
      { url: ESRI('Reference/World_Transportation'), opts: { maxNativeZoom: 19, maxZoom: 20, opacity: 0.7 } },
      { url: ESRI('Reference/World_Boundaries_and_Places'), opts: { maxNativeZoom: 19, maxZoom: 20 } },
    ],
    attr: '© Esri, Maxar, Earthstar Geographics, HERE',
  },
  osm: { name: 'OpenStreetMap', layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxNativeZoom: 19, maxZoom: 20 } }], attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
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
  const key = mapStyle, st = MAP_STYLES[key];
  if (map._tiles) map._tiles.remove();
  const layers = st.layers.map((l) => L.tileLayer(l.url, l.opts));
  map._tiles = L.layerGroup(layers).addTo(map);
  map._info.setText(st.attr);
  document.body.classList.toggle('map-dark', !!st.dark);
  // Filet de sécurité : si le fond ne se charge pas (fournisseur en panne ou bloqué), on passe au suivant.
  let ok = 0, ko = 0;
  layers[0].on('tileload', () => { ok++; });
  layers[0].on('tileerror', () => {
    ko++;
    if (ko === 6 && ok === 0 && mapStyle === key) {
      const fallback = key === 'osm' ? 'plan' : 'osm';
      if (store.get('traque.mapFailed') === fallback) return; // les deux sont KO : sans doute pas de réseau
      store.set('traque.mapFailed', key);
      mapStyle = fallback; store.set('traque.map', fallback);
      for (const m of [lobbyMap, gameMap]) if (m) applyStyle(m);
      toast(`🗺️ Le fond « ${st.name} » ne répond pas : passage à « ${MAP_STYLES[fallback].name} »`, 3500);
    }
  });
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
    L.circle([n.lat, n.lng], { radius: n.r, color: '#c92a2a', weight: 3, dashArray: '6 5', fillColor: '#e03131', fillOpacity: 0.28, interactive: false, className: 'zp' }).addTo(g);
    L.marker([n.lat, n.lng], { interactive: false, icon: L.divIcon({ className: 'pm keep', html: '<div class="spot">⛔</div>', iconSize: [0, 0] }) }).addTo(g);
  }
  for (const [i, m] of (rules.missions || []).entries()) {
    const taken = S.balises[i] && S.cfg && S.balises[i].gameId === S.cfg.gameId && S.cfg.status !== 'lobby';
    L.marker([m.lat, m.lng], { interactive: false, icon: L.divIcon({ className: 'pm keep', html: `<div class="spot ${taken ? 'taken' : ''}">${taken ? '✅' : '🎁'}</div>`, iconSize: [0, 0] }) }).addTo(g);
  }
  if (rules.flag && rules.mode === 'drapeau') {
    L.circle([rules.flag.lat, rules.flag.lng], { radius: 20, color: '#2f9e44', weight: 3, fillOpacity: 0.2, interactive: false, className: 'zp' }).addTo(g);
    L.marker([rules.flag.lat, rules.flag.lng], { interactive: false, icon: L.divIcon({ className: 'pm keep', html: '<div class="spot">🚩</div><div class="pin-label">Drapeau</div>', iconSize: [0, 0] }) }).addTo(g);
  }
  if (rules.prison) {
    const pr = rules.prison;
    L.circle([pr.lat, pr.lng], { radius: pr.r, color: '#212529', weight: 3, dashArray: '4 4', fillColor: '#495057', fillOpacity: 0.3, interactive: false, className: 'zp' }).addTo(g);
    L.marker([pr.lat, pr.lng], { interactive: false, icon: L.divIcon({ className: 'pm keep', html: '<div class="spot">🔒</div><div class="pin-label">Prison</div>', iconSize: [0, 0] }) }).addTo(g);
  }
  return g.addTo(map);
}
const extrasKey = (r) => JSON.stringify([r.prison, r.nogo, r.missions, r.mode === 'drapeau' && r.flag, Object.keys(S.balises).filter((i) => S.cfg && S.balises[i].gameId === S.cfg.gameId)]);
let lobbyExtras = null, lobbyExtrasKey = '', gameExtras = null, gameExtrasKey = '';
const zoneColor = () => ZONE_COLORS[(S.cfg && S.cfg.rules.zoneColor) || 'orange'] || ZONE_COLORS.orange;
function drawZone(map, group, z) {
  if (group) group.remove();
  if (!z) return null;
  const ring = circlePts(z);
  const world = [[-89, -540], [89, -540], [89, 540], [-89, 540]];
  const g = L.layerGroup([
    L.polygon([world, ring], { stroke: false, fillColor: '#10121a', fillOpacity: 0.32, interactive: false, smoothFactor: 0, className: 'zp' }),
    L.circle([z.lat, z.lng], { radius: z.r, color: '#ffffff', weight: 10, opacity: 0.95, fill: false, interactive: false, className: 'zp' }),
    L.circle([z.lat, z.lng], { radius: z.r, color: zoneColor(), weight: 5, opacity: 1, fill: false, interactive: false, className: 'zp' }),
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
    if (S.mapMode === 'flag') { pubRules({ flag: pt, mode: 'drapeau' }); return; }
    if (S.mapMode === 'mission') {
      const list = S.cfg.rules.missions || [];
      const hit = list.findIndex((m) => dist(m, pt) <= 40);
      if (hit >= 0) pubRules({ missions: list.filter((_, i) => i !== hit) });
      else if (list.length >= 10) toast('10 balises au maximum.');
      else pubRules({ missions: [...list, pt] });
      return;
    }
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
    const mate = mateLive(id);
    const p = mate || dbgPos(id) || visiblePos(id);
    if (!p) continue;
    seen.add(id);
    const role = p.kind === 'live' ? 'H' : p.kind === 'test' && roleOf(id) === 'S' ? 'S' : 'F';
    const age = tnow() - p.t;
    const old = p.kind === 'live' || mate ? age > 90000 : false;
    const tm = !anonHidden(id) ? teamOf(id) : null;
    const label = esc(anonHidden(id) ? '❓ ' + (role === 'F' ? 'Fugitif' : 'Chasseur') : nameOf(id))
      + (p.kind === 'test' ? ` · 🧪 ±${p.acc} m` : mate ? ' · équipier' : p.kind === 'live' ? '' : ' · ' + (age < 45000 ? 'maintenant' : ago(p.t).replace('il y a ', '')))
      + (p.r && !mate ? ` · cercle n°${p.lvl || 1} ≈${fmtDist(p.r)}` : '');
    const html = `${old ? '' : headingHtml(p.hdg, role)}<div class="pin ${role} ${old ? 'old' : ''} ${p.r && !mate ? 'fuzzy' : ''} ${tm != null ? 'teamed' : ''}" ${tm != null ? `style="--team:${TEAMS[tm].c}"` : ''}>${anonHidden(id) ? '?' : esc(avatarOf(id) || nameOf(id).slice(0, 1).toUpperCase())}</div><div class="pin-label">${label}</div>`;
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
    const n = connCount(), tot = S.clients.length;
    $(id).classList.toggle('ok', n === tot && n > 0);
    $(id).classList.toggle('part', n > 0 && n < tot);
    $(id).title = S.solo ? 'Partie d’essai (hors ligne)' : n ? `Connecté à ${n} relais sur ${tot}` : 'Reconnexion…';
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
  $('#lobby-code').textContent = S.solo ? '🤖 ESSAI' : S.code;
  $('.code-actions').hidden = S.solo;
  $('#lobby-count').textContent = `(${ids.length})`;
  $('#lobby-players').innerHTML = ids.map((id) => {
    const role = baseRole(id);
    const meta = [id === c.host ? '⭐ organisateur' : '', S.online[id] ? '' : 'hors ligne'].filter(Boolean).join(' · ');
    return `<li class="player">
      <span class="dot ${S.online[id] ? 'on' : ''}"></span>
      <div class="who"><div class="pname">${esc(avatarOf(id))} ${esc(nameOf(id))}${id === S.me ? ' (toi)' : ''} ${battHtml(id)}</div>${meta ? `<div class="pmeta">${meta}</div>` : ''}</div>
      <button class="role-chip role-${role} ${c.rules.teams ? 'compact' : ''}" data-role="${esc(id)}" title="${ROLE_LABEL[role].slice(3)}" ${host ? '' : 'disabled'}>${c.rules.teams ? ROLE_LABEL[role].split(' ')[0] : ROLE_LABEL[role]}</button>
      ${role === 'F' && c.rules.teams ? `<button class="team-chip" data-team="${esc(id)}" style="--team:${TEAMS[teamOf(id)].c}" ${host ? '' : 'disabled'}>${teamLabel(teamOf(id))}</button>` : ''}
      ${host && id !== S.me ? `<button class="kick" data-kick="${esc(id)}" aria-label="Retirer ${esc(nameOf(id))}">✕</button>` : ''}
    </li>`;
  }).join('');
  const nF = ids.filter((id) => baseRole(id) === 'F').length, nH = ids.filter((id) => baseRole(id) === 'H').length;
  const teamsTxt = c.rules.teams ? ' · ' + TEAMS.slice(0, c.rules.teams).map((tt, i) => `${tt.e} ${ids.filter((id) => teamOf(id) === i).length}`).join('  ') : '';
  $('#lobby-roles-hint').textContent = `${nF} fugitif${nF > 1 ? 's' : ''}, ${nH} chasseur${nH > 1 ? 's' : ''}` + teamsTxt + (host ? ' · touche un rôle ou une équipe pour la changer.' : '');

  // Tirage au sort
  const box = $('#draw-box');
  if (host && ids.length >= 2) {
    if (!box.dataset.n || +box.dataset.n !== ids.length) {
      box.dataset.n = ids.length;
      const opts = [];
      for (let i = 1; i < ids.length; i++) opts.push(`<option value="${i}">${i} fugitif${i > 1 ? 's' : ''}</option>`);
      box.innerHTML = `<select id="draw-n" aria-label="Nombre de fugitifs">${opts.join('')}</select><button class="btn small" id="btn-draw">🎲 Tirer au sort</button><button class="btn small" id="btn-draw-teams">🎲 Équipes</button>`;
    }
    $('#btn-draw-teams').hidden = !c.rules.teams;
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
  const extra = [r0.prison ? '🔒 Prison placée.' : '', (r0.missions || []).length ? `🎁 ${r0.missions.length} balise${r0.missions.length > 1 ? 's' : ''}.` : '', r0.mode === 'drapeau' ? (r0.flag ? '🚩 Drapeau placé.' : '🚩 Drapeau à placer !') : '', (r0.nogo || []).length ? `⛔ ${r0.nogo.length} zone${r0.nogo.length > 1 ? 's' : ''} interdite${r0.nogo.length > 1 ? 's' : ''}.` : ''].filter(Boolean).join(' ');
  if (extra) $('#zone-hint').textContent += ' ' + extra;
  $('#map-mode').hidden = !host; $('#zone-extra').hidden = !host; $('#zone-saved-box').hidden = !host;
  $('#map-mode-hint').hidden = !host;
  $('#map-mode-hint').textContent = {
    zone: 'Touche la carte pour placer le centre de la zone.',
    prison: `Touche la carte pour placer la prison (cercle de ${PRISON_R} m). Un fugitif attrapé y va ; un fugitif libre qui y entre libère tout le monde.`,
    nogo: 'Touche la carte pour ajouter une zone interdite ; touche-en une pour l’enlever. Y entrer révèle la position comme une sortie de zone.',
    mission: 'Touche la carte pour poser une balise 🎁 (touche-la à nouveau pour l’enlever). Le premier fugitif qui y passe gagne un pouvoir.',
    flag: 'Touche la carte pour placer le drapeau 🚩 (passe le mode de jeu en « Capture du drapeau »).',
  }[S.mapMode || 'zone'];
  for (const b of document.querySelectorAll('#map-mode [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === (S.mapMode || 'zone')));
  $('#nogo-r-box').hidden = (S.mapMode || 'zone') !== 'nogo';
  $('#btn-prison-clear').hidden = !r0.prison;
  $('#btn-nogo-clear').hidden = !(r0.nogo || []).length;
  $('#btn-missions-clear').hidden = !(r0.missions || []).length;
  $('#btn-flag-clear').hidden = !r0.flag;
  $('#mode-hint').textContent = MODE_HINT[r0.mode] || '';
  renderScores();
  const nb = $('#btn-notifs');
  const nbTxt = S.pushSub ? '🔔 Notifications activées ✓' : '🔔 Activer les notifications';
  if (nb.textContent !== nbTxt) nb.textContent = nbTxt;
  nb.classList.toggle('primary', !S.pushSub);
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
  const c = S.cfg, ph = phase(), out = outcome(), role = roleOf(S.me), now = tnow();
  renderHud(ph, out, role, now);

  // Bandeau
  const banner = $('#banner');
  let bannerText = '', bannerInfo = false;
  if (!out && c.status === 'running') {
    if (S.geoErr === 'denied') bannerText = '📍 Localisation refusée : autorise-la pour cette page, sinon personne ne te verra.';
    else if (S.geoErr) bannerText = '📍 Position introuvable pour l’instant…';
    else if (role === 'F' && S.movedOut) bannerText = '🙈 Tu as quitté ta cachette ! Ta position est révélée.';
    else if (outOfZone() === 'nogo') bannerText = role === 'F' ? '⛔ Zone interdite ! Sors-en, ta position est révélée.' : '⛔ Tu es dans une zone interdite !';
    else if (outOfZone()) bannerText = role === 'F' ? '🚧 Tu es hors zone ! Ta position est révélée.' : '🚧 Tu es hors zone !';
    else if (baseRole(S.me) === 'F' && isCaught(S.me) && c.rules.prison) {
      const d = S.fix ? dist(S.fix, c.rules.prison) : null;
      bannerText = d != null && d <= c.rules.prison.r + 15 ? '🔒 Tu es en prison. Attends qu’un fugitif vienne te libérer.' : `🔒 Va à la prison${d != null ? ` (à ${fmtDist(d)})` : ''} et attends qu’on te libère.`;
      bannerInfo = true;
    }
    else if (!connCount()) { bannerText = 'Connexion perdue, reconnexion…'; bannerInfo = true; }
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
      const jl = powersLeft(S.me, 'jam'), cl = powersLeft(S.me, 'counter');
      if (powersTotal(S.me, 'jam') > 0) acts += `<button class="btn" data-act="jam" ${jl > 0 && hunting && ph.nextReveal ? '' : 'disabled'}>🌫️ Brouillage (${jl})</button>`;
      if (powersTotal(S.me, 'counter') > 0) acts += `<button class="btn" data-act="counter" ${cl > 0 && hunting && !counterActive(S.me) ? '' : 'disabled'}>🔍 Contre-radar (${cl})</button>`;
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
    const mate = mateLive(id);
    const p = mate || (anonHidden(id) ? null : visiblePos(id));
    const meta = [];
    if (caught) {
      const k = S.caught[id];
      meta.push(`attrapé·e${k.by ? ' par ' + esc(nameOf(k.by)) : ''} à ${hhmm(k.t)}`);
    }
    if (p) {
      let s = (mate ? '🤝 équipier · en direct' : p.kind === 'live' ? 'en direct' : 'vu·e ' + ago(p.t));
      if (S.fix && p.r && !mate) {
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
    const tmb = !anonHidden(id) ? teamOf(id) : null;
    if (tmb != null) meta.unshift(`<span class="team-badge" style="--team:${TEAMS[tmb].c}">${teamLabel(tmb)}</span>`);
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
  tools += `<button class="btn small ghost" data-act="alert">${ALERT_LABEL[store.get('traque.alert') || 'auto']}</button>`
    + `<button class="btn small ghost" data-act="eco">${ecoOn() ? '🔋 Éco : oui' : '🔋 Éco : non'}</button>`
    + (S.solo ? '' : `<button class="btn small ghost" data-act="reminders">${S.pushSub ? '🔔 Notifs : oui' : '🔕 Notifs : non'}</button>`)
    + '<button class="btn small ghost" data-act="leave">Quitter</button>';
  const ht = $('#host-tools');
  if (ht.dataset.html !== tools) { ht.dataset.html = tools; ht.innerHTML = tools; }

  // Journal
  const log = $('#log');
  const html = S.log.slice().reverse().map((e) => `<li><time>${hhmm(e.t)}</time><span>${e.html}</span></li>`).join('');
  if (log.dataset.n !== String(S.log.length)) { log.dataset.n = String(S.log.length); log.innerHTML = html; }
  if (S.tab === 'log') S.logSeen = S.log.length;
  const unread = S.log.length - S.logSeen;
  $('#log-unread').hidden = unread <= 0; $('#log-unread').textContent = unread;

  $('#tab-test-btn').hidden = !testOn();
  if (!testOn() && S.tab === 'test') $('[data-tab=players]').click();
  renderTest();
  renderGameMap();
  renderEnd(out);
}

function renderHud(ph, out, role, now) {
  const caught = baseRole(S.me) === 'F' && isCaught(S.me);
  const badge = $('#hud-role');
  badge.textContent = (testOn() ? '🧪 ' : '') + (caught && role !== 'H' ? (S.cfg.rules.prison ? '🔒 En prison' : 'Attrapé·e') : ROLE_LABEL[role]);
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
    addLog('end:' + S.cfg.gameId, out.at || tnow(), out.reason === 'flag' ? '🏁 Drapeau capturé : victoire des fugitifs !'
      : out.reason === 'last' ? `🏁 ${esc(nameOf(out.by))} est le dernier survivant !`
        : out.winner === 'F' ? '🏁 Victoire des fugitifs !' : '🏁 Victoire des chasseurs !');
    beep('good');
  }
  el.hidden = S.endDismissed;
  if (S.endDismissed) return;
  const c = S.cfg;
  $('#end-emoji').textContent = out.winner === 'F' ? '🏃' : '🔦';
  const alive = c.rules.teams && out.winner === 'F' ? aliveTeams() : [];
  $('#end-title').textContent = alive.length
    ? `${alive.map(teamLabel).join(' et ')} ${alive.length > 1 ? 'gagnent' : 'gagnent'} !`
    : out.winner === 'F' ? 'Les fugitifs gagnent !' : 'Les chasseurs gagnent !';
  $('#end-reason').textContent = out.reason === 'time' ? 'Le temps est écoulé.'
    : out.reason === 'all-caught' ? 'Tous les fugitifs ont été attrapés.'
      : out.reason === 'host' ? 'Partie arrêtée par l’organisateur.'
        : out.reason === 'flag' ? `🚩 ${nameOf(out.by)} a capturé le drapeau !`
          : out.reason === 'last' ? `🦠 ${nameOf(out.by)} est le dernier survivant !` : '';
  const recap = recapHtml(out);
  if ($('#end-recap').dataset.html !== recap) { $('#end-recap').dataset.html = recap; $('#end-recap').innerHTML = recap; }
  const acts = (gameTracks().length ? '<button class="btn primary" data-act="replay">▶️ Revoir la partie</button>' : '') +
    '<button class="btn" data-act="see-map">Voir la carte</button>' +
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
  enterRoom({ code });
};
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#btn-resume').onclick = () => {
  if (!needName()) return;
  const last = store.get('traque.last');
  if (last) enterRoom({ code: last.code });
};

$('#btn-leave').onclick = async () => { if (await confirmBox('Quitter le salon ?', '', 'Quitter', 'danger')) leaveRoom(); };
$('#btn-share').onclick = shareLink;
$('#btn-qr').onclick = () => {
  const box = $('#qr');
  if (!box.hidden) { box.hidden = true; return; }
  const qr = qrcode(0, 'M');
  qr.addData(`${location.origin}${location.pathname}#join=${S.code}`);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  box.hidden = false;
};
$('#lobby-players').addEventListener('click', async (e) => {
  const r = e.target.closest('[data-role]');
  if (r && isHost()) {
    const id = r.dataset.role;
    const next = baseRole(id) === 'F' ? 'H' : 'F';
    const teams = { ...(S.cfg.teams || {}) };
    if (next === 'F' && S.cfg.rules.teams) teams[id] = smallestTeam(id);
    await pubCfg({ roles: { ...S.cfg.roles, [id]: next }, teams });
    return;
  }
  const tc = e.target.closest('[data-team]');
  if (tc && isHost()) {
    const id = tc.dataset.team;
    await pubCfg({ teams: { ...(S.cfg.teams || {}), [id]: (teamOf(id) + 1) % S.cfg.rules.teams } });
    return;
  }
  const k = e.target.closest('[data-kick]');
  if (k && isHost()) {
    const id = k.dataset.kick;
    if (!(await confirmBox(`Retirer ${nameOf(id)} ?`, 'Utile pour un joueur parti ou en double.', 'Retirer', 'danger'))) return;
    const roles = { ...S.cfg.roles }; delete roles[id];
    await pubCfg({ roles });
    await pub('p/' + id, { removed: true, t: tnow() }, { retain: true });
    await pub('on/' + id, null, { retain: true });
  }
});
$('#draw-box').addEventListener('click', async (e) => {
  if (e.target.closest('#btn-draw-teams') && isHost()) {
    await pubCfg({ teams: distributeTeams(S.cfg.rules.teams) });
    toast('🎲 Équipes tirées au sort !');
    return;
  }
  if (!e.target.closest('#btn-draw') || !isHost()) return;
  const ids = Object.keys(S.players), n = +$('#draw-n').value;
  const shuffled = ids.map((id) => [crypto.getRandomValues(new Uint32Array(1))[0], id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const roles = {};
  shuffled.forEach((id, i) => { roles[id] = i < n ? 'F' : 'H'; });
  await pubCfg({ roles, ...(S.cfg.rules.teams ? { teams: distributeTeams(S.cfg.rules.teams, roles) } : {}) });
  toast('🎲 Rôles tirés au sort !');
});
$('#rules-form').addEventListener('change', (e) => {
  const el = e.target.closest('[data-rule]');
  if (!el || !isHost()) return;
  const val = el.type === 'checkbox' ? el.checked : el.dataset.type === 'str' ? el.value : +el.value;
  if (el.dataset.rule === 'teams' && val > 0) {
    S.cfg = { ...S.cfg, rules: { ...S.cfg.rules, teams: val } };
    pubCfg({ teams: distributeTeams(val) });
    return;
  }
  pubRules({ [el.dataset.rule]: val });
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
$('#btn-missions-clear').onclick = () => pubRules({ missions: [] });
$('#btn-flag-clear').onclick = () => pubRules({ flag: null });
$('#btn-score-reset').onclick = async () => { if (await confirmBox('Remettre le classement à zéro ?', '', 'Remettre à zéro', 'danger')) pubCfg({ scores: {}, games: 0 }); };
S.chatScope = 'all';
$('#chat-scope').onclick = () => {
  if (!myTeam()) { toast('Pas d’équipe pour l’instant : message à tout le monde.'); return; }
  S.chatScope = S.chatScope === 'all' ? 'team' : 'all';
  $('#chat-scope').textContent = S.chatScope === 'team' ? '🔒 Équipe' : '👥 Tous';
  $('#chat-input').placeholder = S.chatScope === 'team' ? 'Message à ton équipe…' : 'Message à tout le monde…';
};

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
    else if (act === 'replay') openReplay();
    else if (act === 'alert') {
      const order = ['auto', 'sound', 'vibrate', 'silent'];
      const next = order[(order.indexOf(store.get('traque.alert') || 'auto') + 1) % order.length];
      store.set('traque.alert', next);
      toast({ auto: '🔔 Auto : vibreur seul quand tu es fugitif, son sinon', sound: '🔊 Son + vibreur', vibrate: '📳 Vibreur seul', silent: '🔕 Aucune alerte' }[next], 3000);
      scheduleRender();
    } else if (act === 'eco') {
      store.set('traque.eco', !(store.get('traque.eco') === true));
      toast(store.get('traque.eco') ? '🔋 Économie de batterie : chasseurs mis à jour toutes les 15 s, carte rafraîchie moins souvent' : 'Économie de batterie désactivée', 3500);
      scheduleRender();
    }
    else if (act === 'gps') openGpsHelp();
    else if (act === 'reminders') openNotifications();
    else if (act === 'see-map') { S.endDismissed = true; scheduleRender(); }
    else if (act === 'lobby') pubCfg({ status: 'lobby' });
    else if (act === 'leave') { if (await confirmBox('Quitter la partie ?', 'Tu pourras revenir avec le même code.', 'Quitter', 'danger')) leaveRoom(); }
    else if (act === 'become-host') { if (await confirmBox('Prendre le relais ?', 'Tu pourras terminer la partie et en relancer une.', 'Oui')) pubCfg({ host: S.me }); }
    else if (act === 'end') {
      if (await confirmBox('Terminer la partie ?', 'Les fugitifs encore en fuite gagnent.', 'Terminer', 'danger')) {
        const at = tnow();
        pubCfg({ status: 'ended', winner: 'F', endReason: 'host', endedAt: at, ...scoreUpdate({ winner: 'F', reason: 'host', at }) });
        pushTo(everyone(), '🏁 Partie terminée', 'L’organisateur a arrêté la partie. Ouvre Traque pour le récap.', 'end');
      }
    }
    return;
  }
  const u = e.target.closest('[data-uncatch]');
  if (u && isHost()) {
    if (await confirmBox(`Annuler la capture de ${nameOf(u.dataset.uncatch)} ?`, '', 'Annuler la capture')) pub('caught/' + u.dataset.uncatch, { cleared: true, t: tnow(), gameId: S.cfg.gameId }, { retain: true });
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
    $('#tab-test').hidden = S.tab !== 'test';
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
  const team = S.chatScope === 'team' ? myTeam() : null;
  if (team && team[0] === 'T') {
    if (!S.teamKey) { toast('🔒 Clé d’équipe pas encore reçue : réessaie dans quelques secondes.'); $('#chat-input').value = text; return; }
    await pub('ev', { type: 'chat', from: S.me, t: tnow(), team, enc: await aesEnc(S.teamKey, { text }) });
    return;
  }
  const ev = { type: 'chat', from: S.me, text, t: tnow(), team };
  await pub('ev', ev);
});

/* ---------- replay de la partie ---------- */
let replay = null;
function posAt(track, T) {
  const p = track.pts;
  if (!p.length || T < p[0][0]) return null;
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i][0] <= T) {
      const a = p[i], b = p[i + 1];
      if (!b) return [a[1], a[2]];
      const k = (T - a[0]) / (b[0] - a[0] || 1);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return null;
}
function openReplay() {
  const c = S.cfg, list = gameTracks();
  if (!list.length || !gameMap) return;
  const tracks = list.map(([id, t]) => ({ id, role: t.role || baseRole(id), pts: t.pts.map(([sec, a, b]) => [c.startAt + sec * 1000, a / 1e5, b / 1e5]) })).filter((t) => t.pts.length);
  if (!tracks.length) return;
  const t0 = c.startAt, t1 = Math.max(c.endedAt || 0, ...tracks.map((t) => t.pts[t.pts.length - 1][0]));
  const layer = L.layerGroup().addTo(gameMap);
  for (const t of tracks) {
    const col = t.role === 'F' ? '#e03131' : '#1c7ed6';
    t.line = L.polyline([], { color: col, weight: 4, opacity: 0.85, className: 'rp', interactive: false }).addTo(layer);
    t.marker = L.marker([t.pts[0][1], t.pts[0][2]], { interactive: false, zIndexOffset: 800, icon: L.divIcon({ className: 'pm rp', html: `<div class="pin ${t.role}">${esc(avatarOf(t.id) || nameOf(t.id).slice(0, 1).toUpperCase())}</div><div class="pin-label">${esc(nameOf(t.id))}</div>`, iconSize: [0, 0] }) });
  }
  const catches = Object.entries(S.catches).map(([k, by]) => { const i = k.lastIndexOf(':'); return { id: k.slice(0, i), by, t: +k.slice(i + 1) }; });
  replay = { tracks, t0, t1, T: t0, playing: true, speed: 60, layer, catches, shown: new Map(), last: performance.now() };
  const all = tracks.flatMap((t) => t.pts.map((x) => [x[1], x[2]]));
  gameMap.fitBounds(L.latLngBounds(all), { padding: [30, 30], paddingTopLeft: [20, $('#hud').getBoundingClientRect().bottom + 10], maxZoom: 17 });
  document.body.classList.add('replay');
  S.endDismissed = true; $('#end').hidden = true; $('#replay-bar').hidden = false;
  rpUpdate();
  requestAnimationFrame(rpLoop);
}
function rpUpdate() {
  const r = replay;
  if (!r) return;
  for (const t of r.tracks) {
    const pts = t.pts.filter((x) => x[0] <= r.T).map((x) => [x[1], x[2]]);
    const cur = posAt(t, r.T);
    if (cur) pts.push(cur);
    t.line.setLatLngs(pts);
    if (cur) { t.marker.setLatLng(cur); if (!r.layer.hasLayer(t.marker)) t.marker.addTo(r.layer); } else t.marker.remove();
  }
  for (const k of r.catches) {
    const key = k.id + ':' + k.t;
    if (k.t <= r.T && !r.shown.has(key)) {
      const tr = r.tracks.find((t) => t.id === k.id) || r.tracks.find((t) => t.id === k.by);
      const at = tr && posAt(tr, k.t);
      if (at) r.shown.set(key, L.marker(at, { interactive: false, icon: L.divIcon({ className: 'pm rp', html: '<div class="spot">🎯</div>', iconSize: [0, 0] }) }).addTo(r.layer));
    } else if (k.t > r.T && r.shown.has(key)) { r.shown.get(key).remove(); r.shown.delete(key); }
  }
  $('#rp-range').value = Math.round(((r.T - r.t0) / Math.max(1, r.t1 - r.t0)) * 1000);
  $('#rp-time').textContent = clock(r.T - r.t0);
  $('#rp-play').textContent = r.playing ? '⏸' : '▶️';
}
function rpLoop(ts) {
  if (!replay) return;
  const dt = ts - replay.last; replay.last = ts;
  if (replay.playing) {
    replay.T = Math.min(replay.t1, replay.T + dt * replay.speed);
    if (replay.T >= replay.t1) replay.playing = false;
    rpUpdate();
  }
  requestAnimationFrame(rpLoop);
}
function closeReplay() {
  if (!replay) return;
  replay.layer.remove(); replay = null;
  document.body.classList.remove('replay');
  $('#replay-bar').hidden = true;
  S.endDismissed = false;
  scheduleRender();
}
$('#rp-play').onclick = () => {
  if (!replay) return;
  if (replay.T >= replay.t1) replay.T = replay.t0;
  replay.playing = !replay.playing; replay.last = performance.now(); rpUpdate();
};
$('#rp-range').addEventListener('input', (e) => {
  if (!replay) return;
  replay.T = replay.t0 + (+e.target.value / 1000) * (replay.t1 - replay.t0);
  replay.playing = false; rpUpdate();
});
$('#rp-speed').onclick = () => {
  if (!replay) return;
  const sp = [30, 60, 120, 300];
  replay.speed = sp[(sp.indexOf(replay.speed) + 1) % sp.length];
  $('#rp-speed').textContent = '×' + replay.speed;
};
$('#rp-close').onclick = closeReplay;

/* ---------- partie d'essai : robots ----------
 * Tout se passe dans le téléphone (relais local en mémoire). Les robots parlent le même « langage »
 * que de vrais joueurs : messages chiffrés, révélations, radars, cercles, captures. */
let bots = [], botTimer = null;
const BOT_DEFS = {
  F: [['Robot Rex', '🤖', 'H'], ['Robot Mia', '👾', 'H'], ['Robot Zed', '🦾', 'F']],
  H: [['Robot Zed', '🦾', 'F'], ['Robot Lou', '🛸', 'F'], ['Robot Rex', '🤖', 'H']],
};
async function botPub(b, sub, obj, retain = false) {
  b.c.publish(T(sub), await seal(S.room.key, obj), { retain, qos: 1 });
}
function randomIn(z) { return destination(z, Math.sqrt(Math.random()) * z.r * 0.85, Math.random() * 2 * Math.PI); }
function botStep(b, target, speed) {
  const d = dist(b.pos, target);
  if (d < 1) return;
  b.hdg = Math.round(bearing(b.pos, target));
  b.pos = destination(b.pos, Math.min(d, speed * (0.85 + Math.random() * 0.3)), (b.hdg * Math.PI) / 180);
}
async function startBots(myRole) {
  stopBots();
  const z = S.cfg.rules.zone, roles = { ...S.cfg.roles };
  for (const [name, emoji, role] of BOT_DEFS[myRole] || BOT_DEFS.F) {
    const id = 'bot' + randStr(8);
    const b = { id, name, emoji, c: localBroker.client(), pos: destination(z, 30 + Math.random() * 150, Math.random() * 2 * Math.PI), hdg: 0, lastLive: 0, revSent: -1, pings: new Set(), lastShrink: 0, circle: null, track: [], wander: null };
    bots.push(b);
    await botPub(b, 'p/' + id, { id, name, emoji, t: tnow() }, true);
    await botPub(b, 'on/' + id, { on: true, t: tnow(), bat: 40 + Math.round(Math.random() * 60) }, true);
    roles[id] = role;
  }
  await pubCfg({ roles });
  botTimer = setInterval(() => { botTick().catch(() => {}); }, 1000);
}
function stopBots() {
  if (botTimer) clearInterval(botTimer);
  botTimer = null;
  for (const b of bots) { try { b.c.end(); } catch { /* déjà fermé */ } }
  bots = [];
}
const truePos = (id) => (id === S.me ? S.fix : (bots.find((x) => x.id === id) || {}).pos);
async function botTick() {
  const c = S.cfg;
  if (!c || !S.room || c.status === 'lobby') return;
  const ph = phase(), now = tnow(), out = outcome(), gid = c.gameId;
  if (out) {
    for (const b of bots) {
      if (b.trkSent === gid || !b.track.length) continue;
      b.trkSent = gid;
      const st = trackStats(b.track);
      await botPub(b, 'trk/' + b.id, { gameId: gid, t: now, role: c.roles[b.id], ...st, pts: b.track.map((x) => [Math.round((x[0] - c.startAt) / 1000), Math.round(x[1] * 1e5), Math.round(x[2] * 1e5)]) }, true);
    }
    return;
  }
  if (c.status !== 'running') return;
  const z = currentZone() || c.rules.zone;
  for (const b of bots) {
    const role = roleOf(b.id);
    if (role === 'S') continue;
    const last = b.track[b.track.length - 1];
    if (!last || now - last[0] > 8000) b.track.push([now, b.pos.lat, b.pos.lng]);
    if (role === 'H') {
      if (ph.name === 'head') {
        if (now - b.lastLive > 5000) { b.lastLive = now; await botPub(b, 'pos/' + b.id, { lat: b.pos.lat, lng: b.pos.lng, acc: 8, hdg: null, spd: 0, t: now, kind: 'live', gameId: gid }, true); }
        continue;
      }
      // Cible : dernière position révélée d'un fugitif ; s'il est tout près, le robot le « voit » et fonce.
      let target = null, best = Infinity;
      for (const id of fugitives()) {
        if (isCaught(id)) continue;
        const p = S.pos[id];
        if (p && p.gameId === gid && p.kind !== 'live') { const d = dist(b.pos, p); if (d < best) { best = d; target = p; } }
        const tp = truePos(id);
        if (tp && dist(b.pos, tp) < 60) { target = tp; best = 0; }
      }
      if (!target || (best > 0 && dist(b.pos, target) < 15)) target = b.wander && dist(b.pos, b.wander) > 15 ? b.wander : (b.wander = randomIn(z));
      botStep(b, target, 1.8);
      for (const id of fugitives()) {
        const tp = truePos(id);
        if (!isCaught(id) && tp && dist(b.pos, tp) < 12) await botPub(b, 'caught/' + id, { by: b.id, t: now, gameId: gid }, true);
      }
      if (now - b.lastLive > 5000) { b.lastLive = now; await botPub(b, 'pos/' + b.id, { lat: b.pos.lat, lng: b.pos.lng, acc: 8, hdg: b.hdg, spd: 1.8, t: now, kind: 'live', gameId: gid }, true); }
    } else {
      // Fugitif : fuit le chasseur le plus proche, sinon se promène dans la zone.
      let threat = null, dmin = Infinity;
      for (const [id, p] of Object.entries(S.pos)) if (p.kind === 'live' && p.gameId === gid && roleOf(id) === 'H') { const d = dist(b.pos, p); if (d < dmin) { dmin = d; threat = p; } }
      if (roleOf(S.me) === 'H' && S.fix) { const d = dist(b.pos, S.fix); if (d < dmin) { dmin = d; threat = S.fix; } }
      let target;
      if (threat && dmin < 150) {
        target = destination(b.pos, 60, (bearing(threat, b.pos) * Math.PI) / 180);
        if (dist(target, z) > z.r * 0.9) target = randomIn(z);
      } else target = b.wander && dist(b.pos, b.wander) > 15 ? b.wander : (b.wander = randomIn(z));
      botStep(b, target, ph.name === 'head' ? 2.2 : 1.4);
      if (ph.name !== 'hunt') continue;
      const fz = c.rules.fuzzy;
      const circle = (r, lvl) => {
        if (!fz) return { lat: b.pos.lat, lng: b.pos.lng, lvl };
        const cc = destination(b.pos, Math.sqrt(Math.random()) * r * 0.8, Math.random() * 2 * Math.PI);
        return { lat: cc.lat, lng: cc.lng, r: Math.round(r), lvl };
      };
      if (ph.k > b.revSent) {
        b.revSent = ph.k; b.circle = circle(fz, 1);
        await botPub(b, 'pos/' + b.id, { ...b.circle, hdg: b.hdg, t: now, kind: 'reveal', idx: ph.k, gameId: gid }, true);
      }
      for (const t of pingTimes()) {
        if (b.pings.has(t) || now - t > 60000) continue;
        b.pings.add(t); b.circle = circle(fz, 1);
        await botPub(b, 'pos/' + b.id, { ...b.circle, hdg: b.hdg, t: now, kind: 'ping', pingT: t, gameId: gid }, true);
      }
      if (fz && b.circle && b.circle.r > c.rules.fuzzMin && now - b.lastShrink > 30000) {
        const hunters = [...Object.entries(S.pos).filter(([id, p]) => p.kind === 'live' && p.gameId === gid && roleOf(id) === 'H' && now - p.t < 30000)];
        if (roleOf(S.me) === 'H' && S.fix) hunters.push([S.me, S.fix]);
        const intr = hunters.find(([, p]) => dist(p, b.circle) <= b.circle.r);
        if (intr) {
          b.lastShrink = now;
          b.circle = circle(Math.max(c.rules.fuzzMin, (b.circle.r * c.rules.fuzzShrink) / 100), b.circle.lvl + 1);
          await botPub(b, 'pos/' + b.id, { ...b.circle, hdg: b.hdg, t: now, kind: 'shrink', by: intr[0], gameId: gid }, true);
        }
      }
    }
  }
}
$('#btn-solo').onclick = async () => {
  if (!needName()) return;
  const role = await ask('🤖 Partie d’essai', `<p>Tu joues seul contre des robots, sans connexion : parfait pour découvrir l’appli. Ils se déplacent autour de toi (zone de 500 m, partie de 15 min).</p>
    <div class="pick-list"><button class="btn fug" data-pick="F">🏃 Je suis fugitif</button><button class="btn hunt" data-pick="H">🔦 Je suis chasseur</button></div>`,
  [{ label: 'Annuler', value: null, cls: 'ghost' }]);
  if (!role) return;
  busy('Recherche de ta position…');
  startGeo();
  const t0 = Date.now();
  while (!S.fix && Date.now() - t0 < 12000) await sleep(200);
  busy(false);
  if (!S.fix) { toast('Il faut ta position pour la partie d’essai : autorise la localisation.'); return; }
  const z = { lat: +S.fix.lat.toFixed(6), lng: +S.fix.lng.toFixed(6), r: 500 };
  const missions = [0, 1, 2].map((i) => {
    const m = destination(z, 120 + Math.random() * 220, ((i * 2 + Math.random()) * Math.PI) / 3);
    return { lat: +m.lat.toFixed(6), lng: +m.lng.toFixed(6) };
  });
  enterRoom({ code: randStr(6, CODE_ALPHABET), solo: { role, rules: { duration: 15, headStart: 1, interval: 2, pings: 2, fuzzy: 150, shrink: 50, shrinkEvery: 3, zone: z, missions } } });
};

// Horloge : compte à rebours, obligations (révélations, radars…), rafraîchissement.
let ticks = 0;
setInterval(() => {
  if (!S.room || !S.cfg) return;
  ticks++;
  if (testOn()) publishDebug();
  pushSchedule(); // ne renvoie la liste que si la partie a changé
  if (S.screen === 'game') {
    dutyTick();
    renderHud(phase(), outcome(), roleOf(S.me), tnow());
    updateGameZone();
    if (ticks % (ecoOn() ? 10 : 5) === 0 || outcome()) scheduleRender();
  }
}, 1000);

/* ---------- mise à jour automatique ----------
 * GitHub Pages laisse les navigateurs garder les fichiers jusqu'à 10 min. Au démarrage (et au retour sur la page),
 * on compare la version chargée à celle du site ; si elle est plus récente, on recharge sans cache.
 * À chaque modification de l'appli : changer APP_VERSION, version.txt et les ?v= de index.html. */
const APP_VERSION = '2026-11-19a';
async function checkUpdate() {
  try {
    if (S.screen === 'game' && S.cfg && S.cfg.status === 'running') return; // jamais en pleine partie
    const res = await fetch('version.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const v = (await res.text()).trim();
    if (v && v !== APP_VERSION && store.get('traque.reloadedFor') !== v) {
      store.set('traque.reloadedFor', v);
      const q = new URLSearchParams(location.search); q.set('v', v);
      location.replace(location.pathname + '?' + q + location.hash);
    }
  } catch { /* hors ligne : on garde la version chargée */ }
}
checkUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });

// Démarrage
if (qs.get('fast')) window.__traque = { registerPush, computeSchedule, RELAYS, S, zoneState, pubRules, pubCfg, outcome, powersLeft, connCount, teamOf, mateLive };
initHome();
const h0 = parseHash();
if (h0.code) $(store.get('traque.name') ? '#btn-join' : '#name').focus();
