// Text helpers shared by the checker (Node) and the web page (browser).

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ocirc: 'ô', icirc: 'î', ucirc: 'û', euro: '€' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

// Lowercase, strip accents and punctuation: "Coffret Dresseur d'Élite" -> "coffret dresseur d elite"
export function norm(s) {
  return decodeEntities(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Shops spell the same thing differently: "30e Anniversaire", "30 Ans", "30th Celebration", "30ème anniversaire".
// Both the title and the searched phrase are rewritten to one form before comparing.
export function canonical(normText) {
  return ` ${normText} `
    .replace(/ (\d{1,2}) ?(e|eme|ieme|th|th edition)? (anniversaire|anniversary|ans|anniv|celebrations?)\b/g, ' $1ans anniversaire')
    .replace(/ (anniversaire|anniversary|celebrations?) (\d{1,2}) ?(e|eme|th)?\b/g, ' $2ans anniversaire')
    .replace(/ (elite trainer box|coffret dresseur d ?elite|dresseur d ?elite)\b/g, ' etb')
    .replace(/ (poke ?box)\b/g, ' pokebox')
    .replace(/ (tri pack)\b/g, ' tripack')
    .replace(/ (duo pack)\b/g, ' duopack')
    .trim();
}

// True when every word of `phrase` appears (as a word start) in the normalized text.
export function containsPhrase(normText, phrase) {
  const hay = ` ${canonical(normText)} `;
  const words = canonical(norm(phrase)).split(' ').filter(Boolean);
  return words.length > 0 && words.every(w => hay.includes(` ${w}`));
}

export function parsePrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace('€', '').replace(',', '.'));
  // Shops show 0 when a price is hidden: treat it as unknown, not free.
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
