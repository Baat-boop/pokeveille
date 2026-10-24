// One verification pass: fetch every enabled source, merge with the previous run, send alerts, save data.
// Usage: node src/check.js [--data .data] [--only id1,id2]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchShopify } from './sources/shopify.js';
import { fetchWooCommerce } from './sources/woocommerce.js';
import { fetchDealabs } from './sources/dealabs.js';
import { mergeOffers, computeAlerts, markSent } from './alerts.js';
import { sendAlerts, postWebhook, digestEmbed } from './notify/discord.js';
import { matchOffer } from '../docs/shared/match.js';
import { referencePrice } from './pricing.js';

const MAX_ALERTS_PER_RUN = 40;
export const SOURCE_DOWN_ALERT_MS = 3 * 3600 * 1000; // warn on Discord when a shop has been unreachable for 3 hours
const HISTORY_SIZE = 300;
const FETCHERS = { shopify: fetchShopify, woocommerce: fetchWooCommerce, dealabs: fetchDealabs };

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const readJson = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');

export async function runCheck({ dataDir, root = process.cwd(), only = null, webhookUrl = process.env.DISCORD_WEBHOOK_URL, siteUrl = process.env.SITE_URL, now = Date.now(), fetchers = FETCHERS, log = console.log }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const sources = readJson(path.join(root, 'config/sources.json'), []).filter(s => s.enabled !== false && (!only || only.includes(s.id)));
  const searches = readJson(path.join(root, 'config/searches.json'), { searches: [] }).searches ?? [];
  const prevList = readJson(path.join(dataDir, 'offers.json'), { offers: [] }).offers ?? [];
  const prevOffers = Object.fromEntries(prevList.map(o => [o.key, o]));
  const state = readJson(path.join(dataDir, 'state.json'), {});
  const history = readJson(path.join(dataDir, 'alerts.json'), { alerts: [] }).alerts ?? [];

  const runs = {};
  const sourceStatus = [];
  for (const src of sources) {
    const t0 = Date.now();
    try {
      const fetcher = fetchers[src.type];
      if (!fetcher) throw new Error(`type de source inconnu: ${src.type}`);
      const offers = await fetcher(src, now);
      runs[src.id] = { ok: true, offers };
      sourceStatus.push({ id: src.id, name: src.name, type: src.type, ok: true, count: offers.length, available: offers.filter(o => o.status === 'disponible' || o.status === 'precommande').length, ms: Date.now() - t0 });
      log(`✔ ${src.name}: ${offers.length} produits Pokémon`);
    } catch (e) {
      runs[src.id] = { ok: false };
      const prevOk = state.sources?.[src.id]?.lastOkAt ?? null;
      sourceStatus.push({ id: src.id, name: src.name, type: src.type, ok: false, error: e.message, lastOkAt: prevOk, ms: Date.now() - t0 });
      log(`✘ ${src.name}: ${e.message}`);
    }
  }
  // Sources removed from the config: drop their offers.
  const known = new Set(sources.map(s => s.id));
  const keptPrev = Object.fromEntries(Object.entries(prevOffers).filter(([, o]) => known.has(o.sourceId)));

  const offers = mergeOffers(keptPrev, runs, now);
  // Reference price: flags resale far above the usual price.
  const ctx = { prices: readJson(path.join(root, 'config/prices.json'), null), releases: readJson(path.join(root, 'config/releases.json'), null) };
  const ratio = ctx.prices?.overpricedRatio ?? 1.3;
  for (const o of Object.values(offers)) {
    const ref = referencePrice(o, ctx);
    if (ref) { o.ref = ref; o.overpriced = o.price != null && o.price >= ref.price * ratio; } else { delete o.ref; delete o.overpriced; }
  }
  const { alerts, digests, state: next } = computeAlerts({ prevOffers: keptPrev, offers, runs, searches, state, now });
  for (const s of sourceStatus) {
    const cur = next.sources[s.id] ?? {};
    next.sources[s.id] = { ...cur, ...(s.ok ? { lastOkAt: new Date(now).toISOString(), failingSince: null } : { failingSince: cur.failingSince ?? new Date(now).toISOString() }), lastError: s.ok ? null : s.error };
  }

  const searchesById = Object.fromEntries(searches.map(s => [s.id, s]));
  const toSend = alerts.slice(0, MAX_ALERTS_PER_RUN);
  const overflow = alerts.slice(MAX_ALERTS_PER_RUN);
  const sent = [];
  const record = a => { markSent(next, a, now); sent.push(a); };

  next.webhookWelcomed = state.webhookWelcomed ?? false;
  if (webhookUrl) {
    if (!next.webhookWelcomed) {
      const avail = Object.values(offers).filter(o => o.status === 'disponible' || o.status === 'precommande');
      const lines = searches.filter(s => s.enabled !== false).map(s => `• **${s.name}** : ${avail.filter(o => matchOffer(o, s)).length} offre(s) disponible(s) en ce moment`);
      next.webhookWelcomed = await postWebhook(webhookUrl, { embeds: [{ title: '✅ PokéVeille est connecté à Discord', description: `Vous recevrez ici les retours en stock et les nouvelles offres de vos recherches.\n\n${lines.join('\n')}${siteUrl ? `\n\n[Voir le tableau de bord](${siteUrl})` : ''}`, color: 0x2ecc71 }] });
    }
    // Shop health: one warning when a shop stays unreachable, one message when it answers again.
    for (const s of sourceStatus) {
      const st = next.sources[s.id];
      if (!s.ok && !st.downNotifiedAt && now - Date.parse(st.failingSince) >= SOURCE_DOWN_ALERT_MS) {
        const h = Math.round((now - Date.parse(st.failingSince)) / 3600000);
        const ok = await postWebhook(webhookUrl, { embeds: [{ title: `⚠️ ${s.name} ne répond plus depuis ${h} h`, description: `Erreur : ${s.error}\n\nSes offres restent affichées avec leur dernier état connu, mais aucune alerte ne peut être envoyée pour cette boutique tant qu'elle ne répond pas. Rien à faire de votre côté : les vérifications continuent et vous serez prévenu dès qu'elle répondra à nouveau.`, color: 0xe74c3c }] });
        if (ok) st.downNotifiedAt = new Date(now).toISOString();
      } else if (s.ok && st.downNotifiedAt) {
        const ok = await postWebhook(webhookUrl, { embeds: [{ title: `✅ ${s.name} répond à nouveau`, description: 'Les alertes de cette boutique reprennent normalement.', color: 0x2ecc71 }] });
        if (ok) st.downNotifiedAt = null;
      }
    }
    for (const [sid, list] of Object.entries(digests)) {
      const s = searchesById[sid];
      const actionable = list.filter(o => o.status === 'disponible' || o.status === 'precommande');
      if (s && s.notify !== false && actionable.length) await postWebhook(webhookUrl, { embeds: [digestEmbed(s, actionable, siteUrl)] });
    }
    const notifiable = toSend.filter(a => a.searchIds.some(id => searchesById[id]?.notify !== false));
    toSend.filter(a => !notifiable.includes(a)).forEach(a => markSent(next, a, now));
    await sendAlerts(webhookUrl, notifiable, searchesById, record);
    if (overflow.length) {
      await postWebhook(webhookUrl, { content: `… et **${overflow.length}** autre(s) offre(s) correspondante(s) ce passage-ci. Voir le tableau de bord${siteUrl ? ` : ${siteUrl}` : ''}.` });
    }
  } else {
    // No webhook configured yet: record alerts without sending, so adding the webhook later does not flood.
    toSend.forEach(record);
    if (alerts.length) log('ℹ Pas de webhook Discord configuré : alertes enregistrées sans envoi.');
  }
  overflow.forEach(a => markSent(next, a, now));

  for (const a of alerts) log(`→ ${a.kind.toUpperCase()} ${a.offer.title} — ${a.offer.price ?? '?'} € — ${a.offer.sourceName} [${a.searchIds.join(',')}]${sent.includes(a) ? '' : ' (non envoyé)'}`);

  const iso = new Date(now).toISOString();
  const newHistory = [...alerts.map(a => ({ at: iso, kind: a.kind, sent: sent.includes(a), searchIds: a.searchIds, key: a.offer.key, title: a.offer.title, price: a.offer.price, status: a.offer.status, sourceName: a.offer.merchant ?? a.offer.sourceName, url: a.offer.url })), ...history].slice(0, HISTORY_SIZE);

  const offerList = Object.values(offers).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.title.localeCompare(b.title));
  writeJson(path.join(dataDir, 'offers.json'), { generatedAt: iso, demo: false, offers: offerList });
  writeJson(path.join(dataDir, 'state.json'), next);
  writeJson(path.join(dataDir, 'alerts.json'), { alerts: newHistory });
  writeJson(path.join(dataDir, 'status.json'), { lastRunAt: iso, webhookConfigured: !!webhookUrl, alertsThisRun: alerts.length, alertsSent: sent.length, sources: sourceStatus });
  return { offers: offerList, alerts, sent, digests, state: next, sourceStatus };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = arg('only', null)?.split(',') ?? null;
  await runCheck({ dataDir: path.resolve(arg('data', '.data')), only });
}
