/*
 * Relais de jeu Traque (Cloudflare Worker + Durable Object).
 *
 * Une « salle » (Durable Object) par partie, identifiée par l'empreinte du code de la partie.
 * Elle relaie les messages entre téléphones par WebSocket et garde le dernier message de chaque sujet
 * (configuration, joueurs, positions révélées…) pour ceux qui arrivent en cours de partie.
 * Le relais ne voit que des messages chiffrés : la clé est tirée du code de la partie, qu'il ne connaît pas.
 *
 * Elle envoie aussi les notifications (Web Push, voir push.js) :
 *  - rappels programmés par chaque joueur (révélation, zone, fin…), envoyés à l'heure même appli fermée ;
 *  - notifications d'événements demandées par un joueur (début, radar, capture…).
 * Seul le texte des notifications est lisible par le relais (rien d'autre : ni noms, ni positions).
 *
 * Une salle sans activité pendant 2 jours s'efface toute seule.
 *
 * Protocole (JSON) :
 *   téléphone → relais : {t:'pub', topic, payload, retain}   {t:'will', topic, payload}   'ping'
 *                        {t:'sub', id, sub}   {t:'sched', id, items:[{at, title, body, tag}]}
 *                        {t:'push', to:[id…], title, body, tag}
 *   relais → téléphone : {t:'retained', m:[[topic, payload]…]}   {t:'msg', topic, payload}   'pong'
 */
import { DurableObject } from 'cloudflare:workers';
import { sendPush, validSub, vapidKeys } from './push.js';

const MAX_MSG = 48 * 1024;          // taille maximale d'un message
const MAX_TOPICS = 400;             // sujets gardés par salle
const TTL = 2 * 24 * 3600 * 1000;   // effacement après 2 jours sans activité
const FREQUENT = /^(pos|tl|on|dbg)\//; // sujets très fréquents : écrits sur disque au plus toutes les 20 s
const TOPIC_RE = /^[A-Za-z0-9_\-/]{1,80}$/;
const ID_RE = /^[A-Za-z0-9]{4,24}$/;
const MAX_SUBS = 60, MAX_SCHED = 80, PUSH_PER_MIN = 30;
// Clés de stockage : r/<sujet> messages gardés, sub/<joueur> abonnement, sched/<joueur> rappels, meta/… divers.
const R = 'r/', SUB = 'sub/', SCHED = 'sched/';
const clean = (s, n) => String(s || '').slice(0, n);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.latest = new Map();   // derniers messages fréquents pas encore écrits sur disque
    this.written = new Map();  // sujet → heure de la dernière écriture
    this.pushes = [];          // heures des dernières notifications d'événements (limite anti-abus)
    // Répond aux « ping » sans réveiller la salle (moins de coûts, connexions gardées ouvertes).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ will: null });
    const kept = new Map();
    for (const [k, v] of await this.ctx.storage.list({ prefix: R, limit: MAX_TOPICS })) kept.set(k.slice(R.length), v);
    for (const [k, v] of this.latest) kept.set(k, v);
    server.send(JSON.stringify({ t: 'retained', m: [...kept] }));
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'pub' && typeof m.topic === 'string' && typeof m.payload === 'string') {
      await this.publish(m.topic, m.payload, !!m.retain);
    } else if (m.t === 'will') {
      const ok = m.topic && TOPIC_RE.test(m.topic) && typeof m.payload === 'string' && m.payload.length < 4096;
      ws.serializeAttachment({ will: ok ? { topic: m.topic, payload: m.payload } : null });
    } else if (m.t === 'sub' && ID_RE.test(m.id || '')) {
      if (m.sub === null) { await this.ctx.storage.delete(SUB + m.id); return; }
      if (!validSub(m.sub)) return;
      const subs = await this.ctx.storage.list({ prefix: SUB, limit: MAX_SUBS + 1 });
      if (subs.size >= MAX_SUBS && !subs.has(SUB + m.id)) return;
      await this.ctx.storage.put(SUB + m.id, { endpoint: m.sub.endpoint, keys: { p256dh: m.sub.keys.p256dh, auth: m.sub.keys.auth } });
      if (m.test) await this.notify([m.id], { title: '✅ Notifications activées', body: 'Tu seras prévenu même quand Traque est fermé.', tag: 'test' });
    } else if (m.t === 'sched' && ID_RE.test(m.id || '') && Array.isArray(m.items)) {
      const now = Date.now();
      const items = m.items
        .filter((x) => x && Number.isFinite(x.at) && x.at > now - 60000 && x.at < now + 7 * 24 * 3600 * 1000)
        .slice(0, MAX_SCHED)
        .map((x) => ({ at: Math.round(x.at), title: clean(x.title, 80), body: clean(x.body, 200), tag: clean(x.tag, 40) }))
        .sort((a, b) => a.at - b.at);
      if (items.length) await this.ctx.storage.put(SCHED + m.id, items); else await this.ctx.storage.delete(SCHED + m.id);
      await this.planAlarm();
    } else if (m.t === 'push' && Array.isArray(m.to)) {
      const now = Date.now();
      this.pushes = this.pushes.filter((t) => now - t < 60000);
      if (this.pushes.length >= PUSH_PER_MIN) return;
      this.pushes.push(now);
      const to = m.to.filter((id) => ID_RE.test(String(id))).slice(0, MAX_SUBS);
      await this.notify(to, { title: clean(m.title, 80), body: clean(m.body, 200), tag: clean(m.tag, 40) });
    }
  }

  /** Envoie une notification aux joueurs listés (ceux qui sont abonnés). */
  async notify(ids, msg) {
    if (!ids.length || !msg.title) return;
    const subs = await this.ctx.storage.get(ids.map((id) => SUB + id));
    await Promise.all([...subs].map(async ([key, sub]) => {
      const r = await sendPush(this.env, sub, msg);
      if (r === 'gone') await this.ctx.storage.delete(key);
    }));
  }

  async publish(topic, payload, retain) {
    if (!TOPIC_RE.test(topic)) return;
    if (retain) await this.keep(topic, payload);
    const out = JSON.stringify({ t: 'msg', topic, payload });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(out); } catch { /* téléphone parti */ } }
    await this.touch();
  }

  async keep(topic, payload) {
    if (payload === '') { this.latest.delete(topic); this.written.delete(topic); await this.ctx.storage.delete(R + topic); return; }
    const now = Date.now();
    if (FREQUENT.test(topic) && now - (this.written.get(topic) || 0) < 20000) { this.latest.set(topic, payload); return; }
    this.latest.delete(topic);
    this.written.set(topic, now);
    await this.ctx.storage.put(R + topic, payload);
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    if (a && a.will) await this.publish(a.will.topic, a.will.payload, true);
    try { ws.close(code === 1005 ? 1000 : code, 'au revoir'); } catch { /* déjà fermé */ }
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }

  /** Note l'activité (au plus une écriture par heure) et replanifie le réveil. */
  async touch() {
    const now = Date.now();
    if (now - (this.lastTouch || 0) < 3600 * 1000) return;
    this.lastTouch = now;
    await this.ctx.storage.put('meta/last', now);
    await this.planAlarm();
  }

  /** Un seul réveil : le prochain rappel à envoyer, sinon l'effacement de la salle abandonnée. */
  async planAlarm() {
    const last = (await this.ctx.storage.get('meta/last')) || Date.now();
    let next = last + TTL;
    for (const items of (await this.ctx.storage.list({ prefix: SCHED })).values()) if (items.length) next = Math.min(next, items[0].at);
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  async alarm() {
    const now = Date.now();
    // 1. Rappels arrivés à échéance
    const scheds = await this.ctx.storage.list({ prefix: SCHED });
    for (const [key, items] of scheds) {
      const due = items.filter((x) => x.at <= now + 500);
      if (!due.length) continue;
      const id = key.slice(SCHED.length);
      // Un rappel trop vieux n'a plus de sens ; s'il y en a plusieurs du même type, seul le dernier compte.
      const byTag = new Map();
      for (const x of due) if (now - x.at < 5 * 60000) byTag.set(x.tag || x.title, x);
      for (const x of byTag.values()) await this.notify([id], x);
      const rest = items.filter((x) => x.at > now + 500);
      if (rest.length) await this.ctx.storage.put(key, rest); else await this.ctx.storage.delete(key);
    }
    // 2. Salle abandonnée : on efface tout (sauf si des téléphones sont encore connectés)
    const last = (await this.ctx.storage.get('meta/last')) || now;
    if (now - last >= TTL && !this.ctx.getWebSockets().length) {
      this.latest.clear();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.planAlarm();
  }
}

/** Route /relay/<salle> vers la salle correspondante, /push-key vers la clé publique des notifications. */
export async function handleRelay(request, env) {
  const room = new URL(request.url).pathname.split('/')[2] || '';
  if (!/^[0-9a-f]{20}$/.test(room)) return new Response('Salle inconnue', { status: 404 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  return stub.fetch(request);
}
export async function pushKey(env) {
  try {
    const { pub } = await vapidKeys(env);
    return new Response(pub, { headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
  } catch {
    return new Response('', { status: 503 });
  }
}
