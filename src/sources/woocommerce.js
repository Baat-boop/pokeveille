// WooCommerce shops expose a public, read-only Store API (used by their own storefront).
import { politeJson } from '../http.js';
import { classifyProduct } from '../../docs/shared/classify.js';
import { decodeEntities } from '../../docs/shared/text.js';

const MAX_PAGES = 30;

export async function fetchWooCommerce(source) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, headers } = await politeJson(`${source.baseUrl}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('format Store API inattendu');
    products.push(...data);
    const totalPages = parseInt(headers.get('x-wp-totalpages') || '1', 10);
    if (page >= totalPages || data.length < 100) break;
  }
  return products.flatMap(p => wooToOffers(p, source));
}

export function wooToOffers(p, source) {
  const title = decodeEntities(p.name).trim();
  const secondary = [...(p.categories ?? []).map(c => c.name), ...(p.tags ?? []).map(t => t.name), p.slug, p.stock_availability?.text].join(' ');
  const cls = classifyProduct({ title, secondary, source });
  if (!cls) return [];
  const minor = p.prices?.currency_minor_unit ?? 2;
  const toEur = v => (v == null || v === '' || !(Number(v) > 0) ? null : Math.round(Number(v)) / 10 ** minor);
  const price = toEur(p.prices?.price);
  const regular = toEur(p.prices?.regular_price);
  let status = 'rupture';
  if (p.is_in_stock) status = cls.preorderHint ? 'precommande' : 'disponible';
  if (p.is_on_backorder) status = 'precommande';
  return [{
    key: `${source.id}:${p.id}`,
    sourceId: source.id,
    sourceName: source.name,
    channel: 'online',
    title,
    url: p.permalink,
    image: p.images?.[0]?.thumbnail ?? null,
    price,
    compareAtPrice: p.on_sale && regular > price ? regular : null,
    promo: !!(p.on_sale && regular > price),
    currency: p.prices?.currency_code ?? 'EUR',
    status,
    type: cls.type,
    lang: cls.lang,
    langGuessed: cls.langGuessed,
    setCode: cls.setCode,
  }];
}
