// Shopify shops publish their public catalogue (with per-variant "available") at /products.json.
import { politeJson } from '../http.js';
import { classifyProduct } from '../../docs/shared/classify.js';
import { decodeEntities, parsePrice } from '../../docs/shared/text.js';

const MAX_PAGES = 30;

export async function fetchShopify(source) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await politeJson(`${source.baseUrl}/products.json?limit=250&page=${page}`);
    if (!Array.isArray(data?.products)) throw new Error('format products.json inattendu');
    products.push(...data.products);
    if (data.products.length < 250) break;
  }
  return products.flatMap(p => shopifyToOffers(p, source));
}

export function shopifyToOffers(p, source) {
  const title = decodeEntities(p.title).trim();
  const secondary = [p.product_type, p.vendor, p.handle, ...(p.tags ?? [])].join(' ');
  const cls = classifyProduct({ title, secondary, source });
  if (!cls) return [];
  const variants = p.variants?.length ? p.variants : [];
  const multi = variants.length > 1;
  return variants.map(v => {
    const vTitle = multi && v.title && v.title !== 'Default Title' ? `${title} – ${decodeEntities(v.title)}` : title;
    const vCls = multi ? classifyProduct({ title: vTitle, secondary, source }) ?? cls : cls;
    const price = parsePrice(v.price);
    const compareAt = parsePrice(v.compare_at_price);
    const status = v.available ? (vCls.preorderHint || cls.preorderHint ? 'precommande' : 'disponible') : 'rupture';
    return {
      key: `${source.id}:${p.id}:${v.id}`,
      sourceId: source.id,
      sourceName: source.name,
      channel: 'online',
      title: vTitle,
      url: `${source.baseUrl}/products/${p.handle}${multi ? `?variant=${v.id}` : ''}`,
      image: p.images?.[0]?.src ?? null,
      price,
      compareAtPrice: compareAt && price != null && compareAt > price ? compareAt : null,
      promo: !!(compareAt && price != null && compareAt > price),
      currency: 'EUR',
      status,
      type: vCls.type,
      lang: vCls.lang,
      langGuessed: vCls.langGuessed,
      setCode: vCls.setCode,
    };
  });
}
