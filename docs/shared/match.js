// Does an offer satisfy a saved search? Shared by the checker and the web page.
import { norm, containsPhrase } from './text.js';

export const STATUS = {
  disponible: 'Disponible',
  precommande: 'Précommande',
  rupture: 'Rupture de stock',
  inconnu: 'Disponibilité inconnue',
};

export const CHANNELS = {
  online: 'Boutique en ligne',
  deal: 'Bon plan signalé (Dealabs)',
  store: 'Magasin physique',
};

const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean);

/** Returns true when `offer` matches every criterion of `search` (availability is NOT a criterion here). */
export function matchOffer(offer, search) {
  if (!offer || !search || search.enabled === false) return false;
  const title = offer.normTitle ?? norm(offer.title);

  const types = list(search.types);
  if (types.length && !types.includes(offer.type)) return false;

  const langs = list(search.languages);
  if (langs.length) {
    if (offer.lang == null) { if (search.allowUnknownLanguage === false) return false; }
    else if (!langs.includes(offer.lang)) return false;
  }

  if (search.maxPrice != null && search.maxPrice !== '') {
    if (offer.price == null || offer.price > Number(search.maxPrice)) return false;
  }
  if (search.minPrice != null && search.minPrice !== '') {
    if (offer.price == null || offer.price < Number(search.minPrice)) return false;
  }

  const kws = list(search.keywords);
  if (kws.length && !kws.some(k => containsPhrase(title, k))) return false;

  const excl = list(search.excludeKeywords);
  if (excl.some(k => containsPhrase(title, k))) return false;

  const retailers = list(search.retailers).map(norm);
  if (retailers.length) {
    const names = [offer.sourceId, offer.sourceName, offer.merchant].filter(Boolean).map(norm);
    if (!retailers.some(r => names.some(n => n === r || n.includes(r)))) return false;
  }

  const channels = list(search.channels);
  if (channels.length && !channels.includes(offer.channel)) return false;

  if (search.promoOnly && !offer.promo) return false;
  return true;
}

/** Is this status something the user can act on now (buy / preorder) for this search? */
export function isActionable(offer, search) {
  if (offer.status === 'disponible') return true;
  if (offer.status === 'precommande') return search.includePreorder !== false;
  return false;
}

/** Stable fingerprint of the criteria: when it changes, the search is re-baselined. */
export function searchHash(s) {
  const pick = { k: list(s.keywords).map(norm).sort(), x: list(s.excludeKeywords).map(norm).sort(), t: list(s.types).sort(), l: list(s.languages).sort(), u: s.allowUnknownLanguage !== false, p: s.maxPrice ?? null, q: s.minPrice ?? null, r: list(s.retailers).map(norm).sort(), c: list(s.channels).sort(), o: !!s.promoOnly, pre: s.includePreorder !== false };
  return JSON.stringify(pick);
}
