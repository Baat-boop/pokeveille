/*
 * Relais de jeu Traque (Cloudflare Worker + Durable Object).
 *
 * Une « salle » (Durable Object) par partie, identifiée par l'empreinte du code de la partie.
 * Elle relaie les messages entre téléphones par WebSocket et garde le dernier message de chaque sujet
 * (configuration, joueurs, positions révélées…) pour ceux qui arrivent en cours de partie.
 *
 * Le relais ne voit que des messages chiffrés : la clé est tirée du code de la partie, qu'il ne connaît pas.
 * Une salle sans activité pendant 2 jours s'efface toute seule.
 *
 * Protocole (JSON) :
 *   téléphone → relais : {t:'pub', topic, payload, retain}   {t:'will', topic, payload}   'ping'
 *   relais → téléphone : {t:'retained', m:[[topic, payload]…]}   {t:'msg', topic, payload}   'pong'
 */
import { DurableObject } from 'cloudflare:workers';

const MAX_MSG = 48 * 1024;          // taille maximale d'un message
const MAX_TOPICS = 400;             // sujets gardés par salle
const TTL = 2 * 24 * 3600 * 1000;   // effacement après 2 jours sans activité
const FREQUENT = /^(pos|tl|on|dbg)\//; // sujets très fréquents : écrits sur disque au plus toutes les 20 s
const TOPIC_RE = /^[A-Za-z0-9_\-/]{1,80}$/;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.latest = new Map();   // derniers messages fréquents pas encore écrits sur disque
    this.written = new Map();  // sujet → heure de la dernière écriture
    // Répond aux « ping » sans réveiller la salle (moins de coûts, connexions gardées ouvertes).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ will: null });
    const kept = await this.ctx.storage.list({ limit: MAX_TOPICS });
    for (const [k, v] of this.latest) kept.set(k, v);
    server.send(JSON.stringify({ t: 'retained', m: [...kept] }));
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'will') {
      const ok = m.topic && TOPIC_RE.test(m.topic) && typeof m.payload === 'string' && m.payload.length < 4096;
      ws.serializeAttachment({ will: ok ? { topic: m.topic, payload: m.payload } : null });
    } else if (m.t === 'pub' && typeof m.topic === 'string' && typeof m.payload === 'string') {
      await this.publish(m.topic, m.payload, !!m.retain);
    }
  }

  async publish(topic, payload, retain) {
    if (!TOPIC_RE.test(topic)) return;
    if (retain) await this.keep(topic, payload);
    const out = JSON.stringify({ t: 'msg', topic, payload });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(out); } catch { /* téléphone parti */ } }
    await this.touch();
  }

  async keep(topic, payload) {
    if (payload === '') { this.latest.delete(topic); this.written.delete(topic); await this.ctx.storage.delete(topic); return; }
    const now = Date.now();
    if (FREQUENT.test(topic) && now - (this.written.get(topic) || 0) < 20000) { this.latest.set(topic, payload); return; }
    this.latest.delete(topic);
    this.written.set(topic, now);
    await this.ctx.storage.put(topic, payload);
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    if (a && a.will) await this.publish(a.will.topic, a.will.payload, true);
    try { ws.close(code === 1005 ? 1000 : code, 'au revoir'); } catch { /* déjà fermé */ }
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }

  async touch() {
    const now = Date.now();
    if (now - (this.alarmSet || 0) > 3600 * 1000) { this.alarmSet = now; await this.ctx.storage.setAlarm(now + TTL); }
  }

  async alarm() {
    // Salle abandonnée : on écrit les derniers messages en attente puis on efface tout.
    if (this.ctx.getWebSockets().length) { await this.ctx.storage.setAlarm(Date.now() + TTL); return; }
    this.latest.clear();
    await this.ctx.storage.deleteAll();
  }
}

/** Route /relay/<salle> vers la salle correspondante. */
export function handleRelay(request, env) {
  const room = new URL(request.url).pathname.split('/')[2] || '';
  if (!/^[0-9a-f]{20}$/.test(room)) return new Response('Salle inconnue', { status: 404 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  return stub.fetch(request);
}
