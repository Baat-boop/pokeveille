import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOffer, isActionable, searchHash } from '../docs/shared/match.js';

const offer = (o = {}) => ({ key: 'x:1', sourceId: 'pokemanias', sourceName: 'Pokémania', channel: 'online', title: 'Display Pokémon Chaos Ascendant ME04 (FR)', price: 219.9, promo: false, status: 'disponible', type: 'display', lang: 'fr', ...o });

test('filtre par type', () => {
  assert.ok(matchOffer(offer(), { types: ['display'] }));
  assert.ok(!matchOffer(offer(), { types: ['etb', 'coffret'] }));
  assert.ok(matchOffer(offer(), { types: [] }), 'liste vide = tous les types');
});

test('filtre par langue, avec ou sans langue inconnue', () => {
  assert.ok(matchOffer(offer(), { languages: ['fr'] }));
  assert.ok(!matchOffer(offer({ lang: 'jp' }), { languages: ['fr'] }));
  assert.ok(matchOffer(offer({ lang: null }), { languages: ['fr'] }));
  assert.ok(!matchOffer(offer({ lang: null }), { languages: ['fr'], allowUnknownLanguage: false }));
});

test('prix maximum (et prix inconnu exclu quand un maximum est fixé)', () => {
  assert.ok(matchOffer(offer(), { maxPrice: 220 }));
  assert.ok(!matchOffer(offer(), { maxPrice: 200 }));
  assert.ok(!matchOffer(offer({ price: null }), { maxPrice: 200 }));
  assert.ok(matchOffer(offer({ price: null }), { maxPrice: null }));
});

test('mots-clés : au moins une expression, tous ses mots, accents ignorés', () => {
  assert.ok(matchOffer(offer(), { keywords: ['chaos ascendant'] }));
  assert.ok(matchOffer(offer(), { keywords: ['nuit noire', 'Chaos'] }));
  assert.ok(!matchOffer(offer(), { keywords: ['nuit noire'] }));
  assert.ok(matchOffer(offer({ title: "Coffret Dresseur d'Élite Équilibre Parfait" }), { keywords: ['equilibre parfait'] }));
  assert.ok(!matchOffer(offer(), { keywords: ['ascendant'], excludeKeywords: ['display'] }));
});

test('synonymes : 30e anniversaire = 30 ans = 30th celebration, ETB = coffret dresseur d’élite', () => {
  for (const title of ['Mini Tin – 30 Ans Pokémon', 'Bundle - 30e Anniversaire - Français', 'Bundle Pokémon - 30ème Anniversaire', 'Set Complet 9 Coffrets First Partners – Pokémon 30th Celebration']) {
    assert.ok(matchOffer(offer({ title }), { keywords: ['30 anniversaire'] }), title);
    assert.ok(matchOffer(offer({ title }), { keywords: ['30 ans'] }), title);
  }
  assert.ok(!matchOffer(offer({ title: 'Valisette Pokémon 25 Ans Anniversaire' }), { keywords: ['30 ans'] }));
  assert.ok(matchOffer(offer({ title: "Coffret Dresseur d'Élite - Nuit Noire" }), { keywords: ['etb nuit noire'] }));
  assert.ok(matchOffer(offer({ title: 'ETB Nuit Noire ME05' }), { keywords: ["coffret dresseur d'élite nuit noire"] }));
});

test('enseignes, canal et promotions', () => {
  assert.ok(matchOffer(offer(), { retailers: ['pokemanias'] }));
  assert.ok(!matchOffer(offer(), { retailers: ['hikaru'] }));
  assert.ok(matchOffer(offer({ channel: 'deal', merchant: 'E.Leclerc', sourceId: 'dealabs' }), { retailers: ['leclerc'] }));
  assert.ok(!matchOffer(offer(), { channels: ['deal'] }));
  assert.ok(!matchOffer(offer(), { promoOnly: true }));
  assert.ok(matchOffer(offer({ promo: true }), { promoOnly: true }));
});

test('recherche désactivée ne correspond à rien', () => {
  assert.ok(!matchOffer(offer(), { enabled: false }));
});

test('précommande actionnable selon la recherche', () => {
  assert.ok(isActionable(offer({ status: 'precommande' }), {}));
  assert.ok(!isActionable(offer({ status: 'precommande' }), { includePreorder: false }));
  assert.ok(!isActionable(offer({ status: 'rupture' }), {}));
  assert.ok(!isActionable(offer({ status: 'inconnu' }), {}));
});

test("l'empreinte de recherche ignore le nom mais suit les critères", () => {
  assert.equal(searchHash({ name: 'A', types: ['etb'] }), searchHash({ name: 'B', types: ['etb'] }));
  assert.notEqual(searchHash({ types: ['etb'] }), searchHash({ types: ['etb'], maxPrice: 60 }));
});
