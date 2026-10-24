// End-to-end scenarios: several successive passes through runCheck, with a fake shop and a fake Discord webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runCheck } from '../src/check.js';
import { shopifyToOffers } from '../src/sources/shopify.js';

let server, hookUrl, received = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${server.address().port}/hook`;
});
after(() => server.close());

const product = (id, title, available, price = '69.90', extra = {}) => ({ id, title, handle: `p-${id}`, product_type: '', vendor: 'Test', tags: [], variants: [{ id: id * 10, title: 'Default Title', available, price, compare_at_price: null }], ...extra });

function setup(searches) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokeveille-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/sources.json'), JSON.stringify([{ id: 'shop', name: 'Boutique Test', type: 'fake', baseUrl: 'https://shop.test', pokemonOnly: true }]));
  fs.writeFileSync(path.join(root, 'config/searches.json'), JSON.stringify({ searches }));
  let catalog = [], failing = false, now = Date.parse('2026-10-24T10:00:00Z');
  const fetchers = { fake: async src => { if (failing) throw new Error('HTTP 503'); return catalog.flatMap(p => shopifyToOffers(p, src)); } };
  return {
    root,
    set catalog(c) { catalog = c; },
    set failing(f) { failing = f; },
    advance(min) { now += min * 60000; },
    setSearches(s) { fs.writeFileSync(path.join(root, 'config/searches.json'), JSON.stringify({ searches: s })); },
    async run() {
      received = [];
      const r = await runCheck({ root, dataDir: path.join(root, '.data'), webhookUrl: hookUrl, now, fetchers, log: () => {} });
      const isWelcome = m => m.embeds?.[0]?.title?.startsWith('✅');
      const messages = received.filter(m => !isWelcome(m));
      return { ...r, welcome: received.filter(isWelcome), messages, embeds: messages.flatMap(m => m.embeds ?? []) };
    },
  };
}

const ETB_FR = { id: 'etb', name: 'ETB FR', types: ['etb'], languages: ['fr'] };
const DISPLAY_FR = { id: 'disp', name: 'Displays FR', types: ['display'], languages: ['fr'] };

test('premier passage : un seul récapitulatif, aucune alerte individuelle', async () => {
  const t = setup([ETB_FR, DISPLAY_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true), product(2, 'Display Nuit Noire ME05 FR', false, '219.90')];
  const r = await t.run();
  assert.equal(r.alerts.length, 0);
  assert.equal(r.messages.length, 1, 'un récapitulatif pour la recherche ETB (le display est en rupture)');
  assert.match(r.embeds[0].title, /ETB FR/);
});

test('retour en stock : rupture → disponible déclenche une alerte, une seule fois', async () => {
  const t = setup([ETB_FR, DISPLAY_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true), product(2, 'Display Nuit Noire ME05 FR', false, '219.90')];
  await t.run();
  t.advance(15);
  assert.equal((await t.run()).messages.length, 0, 'rien de changé → aucun message');

  t.advance(15);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true), product(2, 'Display Nuit Noire ME05 FR', true, '219.90')];
  const r = await t.run();
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, 'restock');
  assert.equal(r.embeds.length, 1);
  const e = r.embeds[0];
  assert.equal(e.author.name, '🟢 Retour en stock');
  assert.equal(e.url, 'https://shop.test/products/p-2');
  assert.match(e.description, /219,90 €/);
  assert.match(e.description, /Boutique Test/);
  assert.match(e.description, /Disponible/);
  assert.match(e.description, /Displays FR/);

  for (let i = 0; i < 3; i++) {
    t.advance(15);
    assert.equal((await t.run()).messages.length, 0, 'offre inchangée → pas de doublon');
  }
});

test('message de bienvenue Discord envoyé une seule fois', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  const first = await t.run();
  assert.equal(first.welcome.length, 1);
  assert.match(first.welcome[0].embeds[0].description, /ETB FR\*\* : 1 offre/);
  t.advance(15);
  assert.equal((await t.run()).welcome.length, 0);
});

test('changement de prix seul : pas de nouvelle alerte', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true, '69.90')];
  await t.run();
  t.advance(15);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true, '64.90')];
  assert.equal((await t.run()).messages.length, 0);
});

test('nouvelle offre disponible correspondant aux critères', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  await t.run();
  t.advance(15);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true), product(3, 'ETB Nuit Noire ME05 FR', true, '74.90'), product(4, 'ETB Nuit Noire Japonais', true), product(5, 'Display Nuit Noire FR', true)];
  const r = await t.run();
  assert.deepEqual(r.alerts.map(a => [a.kind, a.offer.title]), [['new', 'ETB Nuit Noire ME05 FR']], 'le japonais et le display ne correspondent pas');
  assert.equal(r.embeds[0].author.name, '🆕 Nouvelle offre disponible');
});

test('produit à venir : annonce quand il est référencé, puis alerte dès qu’il devient commandable', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [];
  await t.run();
  t.advance(15);
  t.catalog = [product(6, 'ETB Règne Delta ME06 FR - 6 novembre 2026', false)];
  const listed = await t.run();
  assert.deepEqual(listed.alerts.map(a => a.kind), ['listed']);
  assert.equal(listed.embeds[0].author.name, '📣 Nouveau en boutique, pas encore commandable');
  assert.match(listed.embeds[0].description, /Sortie indiquée :\*\* 06\/11\/2026/);
  t.advance(15);
  assert.equal((await t.run()).messages.length, 0, 'toujours pas en vente : pas de doublon');
  t.advance(5);
  t.catalog = [product(6, 'ETB Règne Delta ME06 FR - 6 novembre 2026', true)];
  const r = await t.run();
  assert.deepEqual(r.alerts.map(a => a.kind), ['new'], 'commandable : alerte immédiate, sans délai anti-rebond');
  t.advance(15);
  assert.equal((await t.run()).messages.length, 0);
});

test('annonce des produits à venir désactivable', async () => {
  const t = setup([{ ...ETB_FR, notifyListed: false }]);
  t.catalog = [];
  await t.run();
  t.advance(15);
  t.catalog = [product(6, 'ETB Règne Delta ME06 FR', false)];
  assert.equal((await t.run()).alerts.length, 0);
  t.advance(15);
  t.catalog = [product(6, 'ETB Règne Delta ME06 FR', true)];
  assert.equal((await t.run()).alerts[0].kind, 'restock');
});

test('nouvelle rupture puis retour : alerte à nouveau (après le délai anti-rebond d’une heure)', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', false)];
  await t.run();
  t.advance(15);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  assert.equal((await t.run()).alerts.length, 1, 'premier retour');

  t.advance(10);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', false)];
  assert.equal((await t.run()).messages.length, 0, 'rupture : pas de message');
  t.advance(10);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  assert.equal((await t.run()).messages.length, 0, 'retour 20 min après la dernière alerte : retenu (anti-rebond)');
  t.advance(45);
  const r = await t.run();
  assert.equal(r.alerts.length, 1, 'toujours disponible après le délai : alerte envoyée');
  assert.equal(r.alerts[0].kind, 'restock');
  t.advance(15);
  assert.equal((await t.run()).messages.length, 0, 'puis plus de doublon');
});

test('boutique injoignable : aucune alerte, données conservées comme non actualisées', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', false)];
  await t.run();
  t.advance(15);
  t.failing = true;
  const r = await t.run();
  assert.equal(r.messages.length, 0);
  assert.equal(r.offers[0].stale, true);
  assert.equal(r.offers[0].status, 'rupture', 'le dernier statut connu est gardé, rien n’est inventé');
  assert.equal(r.sourceStatus[0].ok, false);
  t.advance(15);
  t.failing = false;
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  assert.equal((await t.run()).alerts[0].kind, 'restock', 'détecté au retour de la boutique');
});

test('produit retiré du catalogue puis remis en vente : retour en stock', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  await t.run();
  t.advance(15);
  t.catalog = [];
  const gone = await t.run();
  assert.equal(gone.messages.length, 0);
  assert.equal(gone.offers[0].status, 'inconnu');
  assert.equal(gone.offers[0].removed, true);
  t.advance(120);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true)];
  assert.equal((await t.run()).alerts[0].kind, 'restock');
});

test('une offre qui correspond à deux recherches : un seul message qui cite les deux', async () => {
  const ALL_FR = { id: 'all', name: 'Tout en FR', types: [], languages: ['fr'] };
  const t = setup([ETB_FR, ALL_FR]);
  t.catalog = [];
  await t.run();
  t.advance(15);
  t.catalog = [product(7, 'ETB Chaos Ascendant ME04 FR', true)];
  const r = await t.run();
  assert.equal(r.embeds.length, 1);
  assert.match(r.embeds[0].description, /ETB FR, Tout en FR/);
});

test('modifier les critères d’une recherche : nouveau récapitulatif, pas d’avalanche', async () => {
  const t = setup([ETB_FR]);
  t.catalog = [product(1, 'ETB Chaos Ascendant ME04 FR', true), product(2, 'Display Nuit Noire FR', true), product(3, 'Coffret Premium Zygarde FR', true)];
  await t.run();
  t.advance(15);
  t.setSearches([{ ...ETB_FR, types: ['etb', 'display', 'coffret'] }]);
  const r = await t.run();
  assert.equal(r.alerts.length, 0);
  assert.equal(r.messages.length, 1);
  assert.match(r.embeds[0].title, /3 offre/);
});

test('précommande exclue si la recherche le demande', async () => {
  const t = setup([{ ...ETB_FR, includePreorder: false }]);
  t.catalog = [];
  await t.run();
  t.advance(15);
  t.catalog = [product(8, 'Précommande ETB Règne Delta ME06 FR', true)];
  assert.equal((await t.run()).alerts.length, 0);
});

test('recherche avec notify:false : rien n’est envoyé', async () => {
  const t = setup([{ ...ETB_FR, notify: false }]);
  t.catalog = [];
  await t.run();
  t.advance(15);
  t.catalog = [product(9, 'ETB Chaos Ascendant ME04 FR', true)];
  const r = await t.run();
  assert.equal(r.alerts.length, 1);
  assert.equal(r.messages.length, 0);
  t.advance(15);
  assert.equal((await t.run()).alerts.length, 0, 'et pas rejoué au passage suivant');
});
