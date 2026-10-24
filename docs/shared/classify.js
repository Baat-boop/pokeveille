// Product classification from free-text titles: Pokémon or not, product type, language, preorder.
import { norm } from './text.js';

export const TYPES = {
  etb: 'ETB (Coffret Dresseur d\'Élite)',
  display: 'Display',
  coffret: 'Coffret / Tin / Pokébox',
  booster: 'Booster / Blister / Tripack',
  carte: 'Carte à l\'unité / gradée',
  accessoire: 'Accessoire',
  autre: 'Autre',
};

export const LANGS = { fr: 'Français', en: 'Anglais', jp: 'Japonais', autre: 'Autre langue' };

const OTHER_TCG = /\b(one piece|lorcana|magic the gathering|mtg|yu gi oh|yugioh|dragon ball|digimon|topps|panini|riftbound|star wars unlimited|union arena|flesh and blood|naruto|weiss schwarz|altered|sorcery|gundam|nba|football|basketball|hunter x hunter|kayou|attack on titan|demon slayer|jujutsu|grand archive|gloryfinder)\b/;
// Accessories that are never a sealed card product
const HARD_ACCESSORY = /\b(protection|protections|protege|acrylique|acrylic|sleeves?|pochettes?|classeur|portfolio|toploaders?|top loader|deck box|deckbox|tapis|playmat|assurance|presentoir|vitrine|magnetic|magnetique|plexi|rangement|laniere|magnets?|jukebox)\b/;
// Merch that is only an accessory when no sealed-product word is present (coffrets often include a figurine)
const SOFT_ACCESSORY = /\b(peluche|figurine|lego|sac a dos|mug|puzzle|goodies|t shirt|casquette|porte cles|jeu video|nintendo switch|pins)\b/;
const GRADED = /\b(psa|bgs|cgc|pca|collect aura|collectaura|gradee?s?|graded)\b/;
// Card numbers like "199/165", "224/SV-P", "N°094" (checked on the raw title: normalization drops "/")
const RAW_SINGLE = /(\b\d{1,4}\s?\/\s?[A-Z0-9][A-Z0-9-]*\b|\bN°\s?\d{1,4}\b|\bNo\.? \d{3}\b)/i;
// French-only set code prefixes (EN/JP use SV, SWSH, SM, S12A...) and French product vocabulary
const FR_SET_CODE = /^(EV|EB|SL)\d/;
const JP_SET_CODE = /^(SV|S|M|SM)\d/;
const FR_RAW = /(Méga[- ]Évolution|Écarlate|Épée (et|&) Bouclier|Célébrations|Pok[ée]box|Mini[- ]Tins?|Tripack|Duo ?pack|Valisette|Artset|Nécessaire du Dresseur|Pack Découverte|30e Anniversaire)/i;
const FR_VOCAB = /\b(coffret|dresseur d ?elite|demi display|boite de \d+|cartes officielles|valisette|30 ans|equilibre parfait|chaos ascendant|nuit noire|heros transcendants|flammes fantasmagoriques|regne delta|evolutions prismatiques|rivalites destinees|aventures ensemble|etincelles deferlantes|mascarade crepusculaire|forces temporelles|faille paradoxe|flammes obsidiennes|evolutions a paldea|couronne stellaire|flamme blanche|foudre noire)\b/;
const ETB = /\b(etb|elite trainer|dresseur d ?elite)\b/;
const DISPLAY = /\b(display|displays|booster box|boite de (18|20|24|30|36) boosters|(18|20|24|30|36) boosters)\b/;
const COFFRET = /\b(coffrets?|collection|tins?|mini tins?|pokebox|poke box|valisette|calendrier de l avent|upc|super premium|trainer box|gift box|starter deck|decks?|battle set|kit)\b/;
const BOOSTER = /\b(boosters?|blisters?|tripack|tri pack|duopack|duo pack|bundle|artset|art set|sleeved)\b/;
const SINGLE = /\b(\d{1,3} ?\/ ?\d{1,3}|carte a l unite|cartes a l unite|single)\b/;
const POKEMON = /\b(pokemon|pokebox|ecarlate et violet|mega evolution|epee et bouclier|soleil et lune|dresseur d ?elite)\b/;
const PREORDER = /\b(precommandes?|pre commandes?|preorders?|pre orders?|precos?|precom|en reservation|reservation)\b/;

// Language markers. FR/EN in capitals are checked on the raw title because "en" is a French word.
const LANG_RULES = [
  ['jp', /\b(jp|jap|jpn|japonais|japonaise|japanese|japon|version japonaise)\b/],
  ['autre', /\b(chinois|chinoise|chinese|cn|coreen|coreenne|korean|kr|thai|thailandais|indonesien|indonesian|allemand|german|italien|italian|espagnol|spanish|portugais)\b/],
  ['en', /\b(eng|anglais|anglaise|english|version anglaise|us|uk)\b/],
  ['fr', /\b(fr|francais|francaise|vf|version francaise)\b/],
];
const RAW_EN = /(^|[\s\-[(|/:])EN([\s\-\])|/:,]|$)/;
const RAW_FR = /(^|[\s\-[(|/:])FR([\s\-\])|/:,]|$)/;

export function detectType(text) {
  const t = norm(text);
  if (HARD_ACCESSORY.test(t)) return 'accessoire';
  if (GRADED.test(t)) return 'carte';
  const sealed = ETB.test(t) || DISPLAY.test(t) || COFFRET.test(t) || BOOSTER.test(t);
  if (!sealed && RAW_SINGLE.test(String(text))) return 'carte';
  if (!sealed && SOFT_ACCESSORY.test(t)) return 'accessoire';
  if (ETB.test(t)) return 'etb';
  if (DISPLAY.test(t)) return 'display';
  if (COFFRET.test(t)) return 'coffret';
  if (BOOSTER.test(t)) return 'booster';
  if (SINGLE.test(t) || /\bcartes?\b/.test(t)) return 'carte';
  return 'autre';
}

export function detectLanguage(rawText) {
  const t = norm(rawText);
  for (const [lang, re] of LANG_RULES) if (re.test(t)) return lang;
  if (RAW_EN.test(rawText)) return 'en';
  if (RAW_FR.test(rawText)) return 'fr';
  return null;
}

export function isPokemon(text, { pokemonOnlySource = false } = {}) {
  const t = norm(text);
  if (OTHER_TCG.test(t)) return false;
  if (pokemonOnlySource || POKEMON.test(t)) return true;
  // "ETB" and French/Méga-Évolution set codes (EV09, EB12, SL10, ME04) are Pokémon-specific
  const code = detectSetCode(text);
  return /\betb\b/.test(t) || !!(code && /^(EV|EB|SL|ME)\d/.test(code));
}

export function isPreorder(text) {
  return PREORDER.test(norm(text));
}

// Extension / set code such as ME04, EV09, SV2a, S8b, EB02
export function detectSetCode(text) {
  const m = String(text).match(/\b(ME|EV|SV|EB|SL|XY|SWSH|S|M|SM)\s?-?(\d{1,2}(?:\.5)?[a-z]?)\b/i);
  return m ? (m[1] + m[2]).toUpperCase() : null;
}

/**
 * Fallback when the title states no language.
 * Japanese set codes (SV8, M2, S12A...) imply a Japanese product; French codes (EV, EB, SL),
 * French set names or French-only product names (Pokébox, Tripack...) imply a French one.
 */
export function guessLanguage(title, setCode) {
  if ((setCode && JP_SET_CODE.test(setCode)) || /\bpokemon card game\b/.test(norm(title))) return 'jp';
  if (setCode && FR_SET_CODE.test(setCode)) return 'fr';
  if (FR_VOCAB.test(norm(title)) || FR_RAW.test(String(title))) return 'fr';
  return null;
}

/**
 * Classify a catalogue entry.
 * @param {object} p { title, secondary (product type/tags/handle/vendor), source }
 * @returns {null | {type, lang, langGuessed, preorderHint, setCode}} null when not a Pokémon TCG product
 */
export function classifyProduct({ title, secondary = '', source = {} }) {
  const all = `${title} ${secondary}`;
  if (!isPokemon(all, { pokemonOnlySource: !!source.pokemonOnly })) return null;
  let type = detectType(title);
  if (type === 'autre') type = detectType(all);
  const setCode = detectSetCode(title);
  let lang = detectLanguage(title) ?? detectLanguage(secondary) ?? source.defaultLanguage ?? null;
  let langGuessed = false;
  if (!lang) { lang = guessLanguage(title, setCode); langGuessed = !!lang; }
  return { type, lang, langGuessed, preorderHint: isPreorder(all), setCode };
}
