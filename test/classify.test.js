import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProduct, detectType, detectLanguage } from '../docs/shared/classify.js';

const c = (title, source = {}, secondary = '') => classifyProduct({ title, secondary, source });

test('types de produits', () => {
  assert.equal(detectType("Coffret Dresseur d'Élite - Nuit Noire - ME05"), 'etb');
  assert.equal(detectType('ETB Pokémon Mascarade Crespuculaire EV06 Fr'), 'etb');
  assert.equal(detectType('Pokémon - Display - Equilibre Parfait - ME03 - Boite de 36 boosters en français'), 'display');
  assert.equal(detectType('Demi Display – Faille Paradoxe – Pokémon EV04 – Français'), 'display');
  assert.equal(detectType('Coffret Collection premium - Méga-ZYGARDE ex - ME03'), 'coffret');
  assert.equal(detectType('Mini Tin – Noctali – EV8.5'), 'coffret');
  assert.equal(detectType('Pokébox Amphinobi-ex – 30 Ans Pokémon'), 'coffret');
  assert.equal(detectType('Tripack Pokémon - Chaos Ascendant - ME04'), 'booster');
  assert.equal(detectType('Blister Pokémon Rivalités destinées EV10 Fr'), 'booster');
  assert.equal(detectType('Bundle ME05 Nuit Noire – 6 Boosters'), 'booster');
  assert.equal(detectType('Dracaufeu ex SR 185/165 - SV2A'), 'carte');
  assert.equal(detectType('Rayquaza SL10 – PCA 9'), 'carte');
});

test('les accessoires ne sont pas confondus avec des produits scellés', () => {
  assert.equal(detectType('Protection Acrylique Magnétique ETB Pokémon – Sneyzen Corp'), 'accessoire');
  assert.equal(detectType('Protection Acrylique Display Bundle Pokémon'), 'accessoire');
  assert.equal(detectType('Boite de Rangement Premium Méga Rayquaza'), 'accessoire');
  assert.equal(detectType('Peluche Pokémon Captain Pikachu - 20 cm'), 'accessoire');
  // a coffret that contains a figurine is still a coffret
  assert.equal(detectType('Coffret Collection avec figurine Dracaufeu'), 'coffret');
});

test('langues', () => {
  assert.equal(detectLanguage('Display Pokémon Chaos Ascendant ME04 (FR)'), 'fr');
  assert.equal(detectLanguage('Display Storm Emeralda M6 : Japonais – Shrink'), 'jp');
  assert.equal(detectLanguage('Tripack Chasing Glory Together CSV10C : Chinois'), 'autre');
  assert.equal(detectLanguage('Display Riftbound Vendetta - SET 4 US'), 'en');
  assert.equal(detectLanguage('Elite Trainer Box Prismatic Evolutions - EN'), 'en');
  // the French word "en" must not be read as English
  assert.equal(detectLanguage('Display Pokémon en précommande'), null);
});

test('langue déduite quand le titre ne la précise pas', () => {
  assert.deepEqual([c('ETB ME04 Chaos Ascendant – Scellage propre').lang, c('ETB ME04 Chaos Ascendant – Scellage propre').langGuessed], ['fr', true]);
  assert.equal(c('Display SV8 Super Electric Breaker', { pokemonOnly: true }).lang, 'jp');
  assert.equal(c('Display M2 Mega Inferno X', { pokemonOnly: true }).lang, 'jp');
  assert.equal(c('Coffret ETB Pokémon Officiel Scellé - Chaos Ascendant', { pokemonOnly: true, defaultLanguage: 'fr' }).lang, 'fr');
});

test('produits non Pokémon exclus', () => {
  assert.equal(c('Topps Motif NBA Basketball 2025/26 – Hobby Box'), null);
  assert.equal(c('Display One Piece OP-12 Japonais'), null);
  assert.equal(c('Display Riftbound Vendetta - SET 4 US', { pokemonOnly: true }), null);
  assert.notEqual(c('Display Pokémon Chaos Ascendant ME04 (FR)'), null);
});

test('précommande détectée', () => {
  assert.equal(c('Précommande - ETB Règne Delta ME06 FR').preorderHint, true);
  assert.equal(c('ETB Pokémon Nuit Noire ME05 FR').preorderHint, false);
});
