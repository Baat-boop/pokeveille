// Dealabs publishes RSS feeds of community-posted deals. A deal is a lead, not a verified stock level.
import { politeGet } from '../http.js';
import { classifyProduct } from '../../docs/shared/classify.js';
import { decodeEntities, parsePrice } from '../../docs/shared/text.js';

const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
};

export async function fetchDealabs(source, now = Date.now()) {
  const r = await politeGet(source.url, { accept: 'application/rss+xml, text/xml' });
  return parseDealabsRss(await r.text(), source, now);
}

export function parseDealabsRss(xml, source, now = Date.now()) {
  const out = [];
  for (const item of xml.split('<item>').slice(1)) {
    const title = tag(item, 'title');
    const link = tag(item, 'link');
    const pub = Date.parse(tag(item, 'pubDate') ?? '');
    if (!title || !link) continue;
    if (Number.isFinite(pub) && now - pub > MAX_AGE_MS) continue;
    const merchantTag = item.match(/<pepper:merchant([^>]*)\/>/);
    const attr = n => merchantTag?.[1].match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? null;
    const merchant = attr('name') ? decodeEntities(attr('name')) : null;
    const cls = classifyProduct({ title, secondary: tag(item, 'category') ?? '', source: { ...source, pokemonOnly: false } });
    if (!cls || cls.type === 'accessoire' || cls.type === 'autre') continue;
    const guid = tag(item, 'guid') ?? link;
    out.push({
      key: `${source.id}:${guid.replace(/^https?:\/\/[^/]+/, '')}`,
      sourceId: source.id,
      sourceName: source.name,
      merchant,
      channel: 'deal',
      title,
      url: link,
      image: item.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null,
      price: parsePrice(attr('price')),
      compareAtPrice: null,
      promo: true,
      currency: 'EUR',
      status: 'inconnu', // a posted deal does not tell us the live stock
      postedAt: Number.isFinite(pub) ? new Date(pub).toISOString() : null,
      type: cls.type,
      lang: cls.lang,
      langGuessed: cls.langGuessed,
      setCode: cls.setCode,
    });
  }
  return out;
}
