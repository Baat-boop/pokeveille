import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { referencePrice } from '../src/pricing.js';
import { classifyProduct } from '../docs/shared/classify.js';
import { watchdogDecision, STOPPED_AFTER_MS } from '../src/watchdog.js';

const ctx = {
  prices: JSON.parse(fs.readFileSync(new URL('../config/prices.json', import.meta.url))),
  releases: JSON.parse(fs.readFileSync(new URL('../config/releases.json', import.meta.url))),
};
const offer = (title, price = 10) => ({ title, price, channel: 'online', ...classifyProduct({ title, source: { pokemonOnly: true } }) });
const ref = title => referencePrice(offer(title), ctx)?.price ?? null;

test('prix de référence : produits standard du bloc Méga-Évolution en français', () => {
  assert.equal(ref('ETB Pokémon Nuit Noire ME05 - Français'), 55.99);
  assert.equal(ref('Coffret Dresseur d\'Élite Équilibre Parfait FR'), 55.99);
  assert.equal(ref('Display 36 Boosters Chaos Ascendant ME04 FR'), 199.99);
  assert.equal(ref('Tripack Héros Transcendants FR'), 17.99);
  assert.equal(ref('Blister 3 boosters Nuit Noire FR'), 17.99, 'un blister de 3 boosters est un tripack');
  assert.equal(ref('Bundle 6 boosters Nuit Noire ME05 FR'), 35.99);
  assert.equal(ref('Booster Pokémon Équilibre Parfait ME03 FR'), 5.99);
  assert.equal(ref('ETB Règne Delta ME06 FR'), 55.99, 'sortie du calendrier');
});

test('prix de référence : rien quand on ne peut pas être sûr', () => {
  assert.equal(ref('ETB Pokémon Écarlate et Violet 151 FR'), null, 'ancien bloc, épuisé');
  assert.equal(ref('ETB Nuit Noire ME05 JP'), null, 'pas français');
  assert.equal(ref('ETB Pokémon Center Nuit Noire ME05 FR'), null, 'édition spéciale');
  assert.equal(ref('Lot de 3 ETB Nuit Noire ME05 FR'), null, 'lot');
  assert.equal(ref('ETB 30 ans Anniversaire ME05.5 FR'), null, 'édition anniversaire sans prix connu');
  assert.equal(ref('Pack ETB Nuit Noire + Display Équilibre Parfait FR'), null, 'pack combiné');
  assert.equal(ref('Demi Display 18 boosters Nuit Noire FR'), null);
  assert.equal(ref('Collection Poster Pokémon Nuit Noire - 3 Boosters + 3 Cartes Promo - Français'), null, 'pas un tripack');
  assert.equal(ref('Bundle Pokémon Héros Transcendants ME2.5 - 6 Boosters - Français'), null, 'extension spéciale « .5 »');
  assert.equal(ref('Bundle Pokémon 30e Anniversaire ME05.5 - 6 Boosters - Français'), null);
  assert.equal(ref('Case ETB ME05 Nuit Noire – Scellée'), null, 'carton de plusieurs ETB');
  assert.equal(ref('Display Promo ME01 Méga Évolution – 36 Boosters'), null, 'display avec carte promo');
  assert.equal(ref('Display Mini Tin – Méga-Évolution – ME1 – Français'), null);
  assert.equal(ref('Duo Pack Méga-Évolution : Héros Transcendants - Dodoala FR'), null);
  assert.equal(ref('Coffret Collection Figurine Mew & Mewtwo - 30e Anniversaire - Français'), null, 'deux produits du calendrier ensemble');
  assert.equal(ref('Collection Ultra-Premium Mentali - 30e Anniversaire - Français'), 229.99, 'sortie du calendrier');
  assert.equal(ref('Blister Nuit Noire FR'), null, 'blister à 1 booster : prix variable');
  assert.equal(ref('Booster Nuit Noire FR x5'), null);
  assert.equal(referencePrice({ ...offer('ETB Nuit Noire ME05 FR'), channel: 'deal' }, ctx), null, 'bons plans exclus');
});

test('surveillance : un seul message par arrêt, puis un message à la reprise', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const fresh = { lastRunAt: new Date(now - 20 * 60000).toISOString() };
  const old = { lastRunAt: new Date(now - STOPPED_AFTER_MS - 60000).toISOString() };
  assert.equal(watchdogDecision({ status: fresh, state: {}, now }).message, null);
  const a = watchdogDecision({ status: old, state: {}, now });
  assert.match(a.message.embeds[0].title, /arrêtées/);
  assert.equal(watchdogDecision({ status: old, state: a.state, now: now + 3600000 }).message, null, 'pas de répétition');
  const b = watchdogDecision({ status: fresh, state: a.state, now });
  assert.match(b.message.embeds[0].title, /ont repris/);
  assert.deepEqual(b.state, {});
  assert.match(watchdogDecision({ status: null, state: {}, now }).message.embeds[0].description, /Aucune vérification/);
});
