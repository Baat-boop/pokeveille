// Discord incoming webhook: free, no bot, no account beyond Discord itself.
import { STATUS, CHANNELS } from '../../docs/shared/match.js';
import { TYPES, LANGS } from '../../docs/shared/classify.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = { restock: 0x2ecc71, new: 0x3498db, price: 0x1abc9c, deal: 0x9b59b6, listed: 0xe67e22, digest: 0x95a5a6, health: 0xe74c3c, healthOk: 0x2ecc71 };
const HEADLINES = { restock: '🟢 Retour en stock', new: '🆕 Nouvelle offre disponible', price: '📉 Baisse de prix', deal: '💡 Bon plan signalé', listed: '📣 Nouveau en boutique, pas encore commandable' };

const euro = v => (v == null ? 'prix non affiché' : `${v.toFixed(2).replace('.', ',')} €`);
const paris = iso => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function alertEmbed(alert, searchesById) {
  const o = alert.offer;
  const over = o.ref && o.price != null ? o.price / o.ref.price - 1 : null;
  const lines = [
    alert.kind === 'price' && alert.prevPrice
      ? `**Prix :** ${euro(o.price)} au lieu de ${euro(alert.prevPrice)} lors de la dernière alerte (−${Math.round((1 - o.price / alert.prevPrice) * 100)} %)`
      : `**Prix :** ${euro(o.price)}${o.compareAtPrice ? ` ~~${euro(o.compareAtPrice)}~~ (promo)` : ''}`,
    ...(o.overpriced ? [`⚠️ **${Math.round(over * 100)} % au-dessus du prix de référence** (${o.ref.label} : ${euro(o.ref.price)})`] : []),
    `**Boutique :** ${o.merchant ? `${o.merchant} (via ${o.sourceName})` : o.sourceName} — ${CHANNELS[o.channel]}${o.channel === 'online' ? ', livraison en France' : ''}`,
    `**Disponibilité :** ${STATUS[o.status]}${o.channel === 'deal' ? ' (vérifiez sur le site du marchand)' : ''}${alert.kind === 'listed' ? ' — vous serez prévenu dès qu’il sera commandable' : ''}`,
    ...(o.releaseHint ? [`**Sortie indiquée :** ${o.releaseHint.split('-').reverse().join('/')}`] : []),
    `**Produit :** ${TYPES[o.type] ?? o.type}${o.lang ? ` · ${LANGS[o.lang]}` : ' · langue non précisée'}${o.setCode ? ` · ${o.setCode}` : ''}`,
    `**Recherche :** ${alert.searchIds.map(id => searchesById[id]?.name ?? id).join(', ')}`,
    `**Vérifié le :** ${paris(o.checkedAt)}`,
  ];
  return {
    title: cut(o.title, 250),
    url: o.url,
    description: lines.join('\n'),
    color: COLORS[alert.kind],
    author: { name: HEADLINES[alert.kind] },
    ...(o.image ? { thumbnail: { url: o.image } } : {}),
  };
}

export function digestEmbed(search, offers, siteUrl) {
  const top = [...offers].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)).slice(0, 10);
  const body = top.map(o => `• [${cut(o.title, 90)}](${o.url}) — ${euro(o.price)} — ${o.merchant ?? o.sourceName}`).join('\n');
  return {
    title: cut(`🔎 « ${search.name} » : ${offers.length} offre(s) déjà disponible(s)`, 250),
    description: cut(`Premier passage pour cette recherche (ou ses critères ont changé, ou une boutique a été ajoutée) : voici ce qui correspond déjà. Vous serez ensuite averti uniquement des retours en stock et des nouvelles offres.\n\n${body}${offers.length > 10 ? `\n… et ${offers.length - 10} autre(s)` : ''}${siteUrl ? `\n\n[Tout voir sur le tableau de bord](${siteUrl})` : ''}`, 4000),
    color: COLORS.digest,
  };
}

/** POST one message. Honors 429 retry_after. Returns true when Discord accepted it. */
export async function postWebhook(webhookUrl, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'PokéVeille', allowed_mentions: { parse: [] }, ...payload }),
    });
    if (r.ok) return true;
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep(Math.ceil((j.retry_after ?? 2) * 1000) + 250);
      continue;
    }
    console.error(`Discord a refusé le message (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    return false;
  }
  return false;
}

/** Send alerts grouped 5 embeds per message (stays under Discord's 6000-character total). Calls onSent(alert) for each delivered alert. */
export async function sendAlerts(webhookUrl, alerts, searchesById, onSent) {
  for (let i = 0; i < alerts.length; i += 5) {
    const chunk = alerts.slice(i, i + 5);
    const ok = await postWebhook(webhookUrl, { embeds: chunk.map(a => alertEmbed(a, searchesById)) });
    if (ok) chunk.forEach(onSent);
    await sleep(1200);
  }
}
