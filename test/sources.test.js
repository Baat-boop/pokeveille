import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsAllows } from '../src/http.js';
import { shopifyToOffers } from '../src/sources/shopify.js';
import { wooToOffers } from '../src/sources/woocommerce.js';
import { parseDealabsRss } from '../src/sources/dealabs.js';

test('robots.txt : règles respectées', () => {
  const r = parseRobots('User-agent: *\nDisallow: /wp-json/\nDisallow: /*?add-to-cart=\nAllow: /wp-json/public\n\nUser-agent: Googlebot\nDisallow: /');
  assert.equal(robotsAllows(r, '/wp-json/wc/store/v1/products'), false);
  assert.equal(robotsAllows(r, '/wp-json/public/x'), true);
  assert.equal(robotsAllows(r, '/products.json?limit=250'), true);
  assert.equal(robotsAllows(r, '/shop?add-to-cart=12'), false);
  const shopify = parseRobots('User-agent: *\nDisallow: /cart\nDisallow: /collections/*sort_by*\n');
  assert.equal(robotsAllows(shopify, '/products.json?limit=250&page=2'), true);
});

test('Shopify : statut, promo, variantes', () => {
  const src = { id: 's', name: 'S', baseUrl: 'https://s.test', pokemonOnly: true };
  const [o] = shopifyToOffers({ id: 1, title: 'ETB Nuit Noire ME05 FR', handle: 'etb', tags: [], variants: [{ id: 2, title: 'Default Title', available: true, price: '59.90', compare_at_price: '69.90' }] }, src);
  assert.equal(o.status, 'disponible');
  assert.equal(o.price, 59.9);
  assert.equal(o.promo, true);
  assert.equal(o.url, 'https://s.test/products/etb');
  const pre = shopifyToOffers({ id: 3, title: 'ETB Règne Delta ME06 FR', handle: 'rd', tags: ['Précommande'], variants: [{ id: 4, title: 'Default Title', available: true, price: '64.90' }] }, src)[0];
  assert.equal(pre.status, 'precommande');
  const multi = shopifyToOffers({ id: 5, title: 'Display Storm Emeralda M6', handle: 'se', tags: [], variants: [{ id: 6, title: 'Japonais', available: false, price: '89.90' }, { id: 7, title: 'Coréen', available: true, price: '59.90' }] }, src);
  assert.deepEqual(multi.map(m => [m.lang, m.status]), [['jp', 'rupture'], ['autre', 'disponible']]);
  assert.equal(multi[0].url, 'https://s.test/products/se?variant=6');
});

test('WooCommerce Store API : prix en centimes et stock', () => {
  const [o] = wooToOffers({ id: 9, name: 'Coffret &#8211; Collection Premium Pokémon &#8211; FR', permalink: 'https://w.test/p/9', prices: { price: '4990', regular_price: '5990', currency_code: 'EUR', currency_minor_unit: 2 }, on_sale: true, is_in_stock: false, is_on_backorder: false, categories: [] }, { id: 'w', name: 'W', pokemonOnly: true });
  assert.equal(o.title, 'Coffret – Collection Premium Pokémon – FR');
  assert.equal(o.price, 49.9);
  assert.equal(o.status, 'rupture');
  assert.equal(o.type, 'coffret');
});

test('Dealabs : seuls les produits de cartes, statut jamais inventé', () => {
  const xml = `<rss><channel>
  <item><title><![CDATA[Peluche Pokémon Pikachu 20 cm]]></title><link>https://www.dealabs.com/bons-plans/a-1</link><guid>https://www.dealabs.com/bons-plans/a-1</guid><pubDate>Fri, 23 Oct 2026 13:26:38 +0200</pubDate><pepper:merchant name="Amazon" price="12,50€"/></item>
  <item><title><![CDATA[Display Pokémon Chaos Ascendant ME04 FR]]></title><link>https://www.dealabs.com/bons-plans/b-2</link><guid>https://www.dealabs.com/bons-plans/b-2</guid><pubDate>Fri, 23 Oct 2026 10:00:00 +0200</pubDate><pepper:merchant name="E.Leclerc" price="179,90€"/></item>
  </channel></rss>`;
  const offers = parseDealabsRss(xml, { id: 'dealabs', name: 'Dealabs' }, Date.parse('2026-10-24T10:00:00Z'));
  assert.equal(offers.length, 1);
  assert.equal(offers[0].merchant, 'E.Leclerc');
  assert.equal(offers[0].price, 179.9);
  assert.equal(offers[0].status, 'inconnu');
  assert.equal(offers[0].channel, 'deal');
});
