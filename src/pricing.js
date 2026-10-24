// Reference price of an offer, to flag resale far above the usual price. Only for French products we can identify with confidence.
import { norm, canonical, containsPhrase } from '../docs/shared/text.js';

// Current block (Méga-Évolution, ME01–ME06): older sets are out of print and legitimately cost more.
const CURRENT_BLOCK = /\b(mega evolution|equilibre parfait|heros transcendants|flammes fantasmagoriques|chaos ascendant|nuit noire|regne delta)\b/;
// Special editions (30th anniversary, ".5" special sets, Pokémon Center): no known reference price.
const SPECIAL_EDITION = /\b(\d+ ?ans anniversaire|pokemon center)\b/;
// Lots and combinations of several products. (norm() already drops "+", and canonical() turns "Coffret Dresseur d'Élite" into "etb".)
const MULTI = /\b(lot|lots|x ?\d|\d ?x|pack|packs|duopack|case|carton|kit|coffrets?|collection|poster|classeur|tins?|blisters?|sleeved|art ?set|demi)\b/;

/**
 * @returns {null | {price, label}} the reference price, or null when unknown.
 */
export function referencePrice(offer, { prices, releases }) {
  if (offer.lang !== 'fr' || offer.channel === 'deal') return null;
  const t = canonical(norm(offer.title));

  const combined = /&|\+|\b(lot|x ?\d|\d ?x)\b/i.test(offer.title);
  for (const r of combined ? [] : releases?.releases ?? []) {
    if (r.price && r.type !== 'extension' && (r.keywords ?? []).some(k => containsPhrase(t, k))) return { price: r.price, label: r.name };
  }

  const refs = prices?.references ?? {};
  const inBlock = /^ME\d/.test(offer.setCode ?? '') || CURRENT_BLOCK.test(t);
  if (!inBlock || SPECIAL_EDITION.test(t) || /\.5$/.test(offer.setCode ?? '')) return null;
  const pick = id => (refs[id] ? { price: refs[id].price, label: refs[id].label } : null);
  if (offer.type === 'etb') return MULTI.test(t) ? null : pick('etb');
  if (/\b(tripack|blister 3 boosters)\b/.test(t)) return /\b(lot|x ?\d|\d ?x|coffrets?|collection|poster)\b/.test(t) ? null : pick('tripack');
  if (/\b(bundle|6 boosters)\b/.test(t)) return /\b(lot|x ?\d|\d ?x|coffrets?|collection|poster)\b/.test(t) ? null : pick('bundle');
  if (MULTI.test(t)) return null;
  if (offer.type === 'display') return /\b(18|20|24|30) boosters|promo\b/.test(t) ? null : pick('display36');
  if (offer.type === 'booster' && !/\b\d+ boosters\b/.test(t)) return pick('booster');
  return null;
}

/** Share above the reference, e.g. 0.43 for +43 %; null when unknown. */
export function overprice(offer) {
  return offer.ref && offer.price != null ? offer.price / offer.ref.price - 1 : null;
}
