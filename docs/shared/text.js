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

// True when every word of `phrase` appears (as a word start) in the normalized text.
export function containsPhrase(normText, phrase) {
  const hay = ` ${normText} `;
  const words = norm(phrase).split(' ').filter(Boolean);
  return words.length > 0 && words.every(w => hay.includes(` ${w}`));
}

export function parsePrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace('€', '').replace(',', '.'));
  // Shops show 0 when a price is hidden: treat it as unknown, not free.
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
