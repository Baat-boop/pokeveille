// Polite HTTP client: identifies itself, respects robots.txt, spaces requests per host,
// and stops on 403/429 instead of retrying (no attempt to get around protections).

const MIN_INTERVAL_MS = 2000;
const lastHit = new Map();
const robotsCache = new Map();

export const USER_AGENT = `PokeVeille/1.0 (veille de stock personnelle, ~1 passage / 15 min; +${process.env.SITE_URL || 'https://github.com'})`;

export class BlockedError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitTurn(host) {
  const wait = (lastHit.get(host) ?? 0) + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

/** Parse robots.txt into rules applying to us ("*" group, or a group naming PokeVeille). */
export function parseRobots(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
      if (key === 'crawl-delay') cur.crawlDelay = parseFloat(val);
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && 'pokeveille'.includes(a)));
  const chosen = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  return { rules: chosen.flatMap(g => g.rules), crawlDelay: Math.max(0, ...chosen.map(g => g.crawlDelay || 0)) };
}

function ruleRegex(path) {
  let re = '';
  for (const ch of path) re += ch === '*' ? '.*' : ch === '$' ? '$' : ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + re);
}

/** Longest matching rule wins; ties go to Allow (RFC 9309). */
export function robotsAllows(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!r.path) continue;
    if (ruleRegex(r.path).test(pathAndQuery)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return !best || best.allow;
}

async function getRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let robots = { rules: [], crawlDelay: 0 };
  try {
    const host = new URL(origin).host;
    await waitTurn(host);
    const r = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401 || r.status === 403) robots = { rules: [{ allow: false, path: '/' }], crawlDelay: 0 };
    else if (r.ok) robots = parseRobots(await r.text());
  } catch { /* unreachable robots.txt: treated as no restriction, like search engines do */ }
  robotsCache.set(origin, robots);
  return robots;
}

/** GET a URL politely. Throws BlockedError when robots.txt forbids it or the site refuses us. */
export async function politeGet(url, { accept = 'application/json' } = {}) {
  const u = new URL(url);
  const robots = await getRobots(u.origin);
  if (!robotsAllows(robots, u.pathname + u.search)) throw new BlockedError(`robots.txt de ${u.host} interdit ${u.pathname}`);
  if (robots.crawlDelay) lastHit.set(u.host, (lastHit.get(u.host) ?? 0) + robots.crawlDelay * 1000);

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitTurn(u.host);
    let r;
    try {
      r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      if (attempt === 0) { await sleep(5000); continue; }
      throw new Error(`réseau: ${e.message}`);
    }
    if (r.status === 403 || r.status === 401) throw new BlockedError(`${u.host} refuse l'accès (HTTP ${r.status})`);
    if (r.status === 429) throw new BlockedError(`${u.host} demande de ralentir (HTTP 429) — on réessaiera au prochain passage`);
    if (r.status >= 500 && attempt === 0) { await sleep(5000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${u.host}`);
    return r;
  }
}

export async function politeJson(url) {
  const r = await politeGet(url);
  const txt = await r.text();
  try { return { data: JSON.parse(txt), headers: r.headers }; }
  catch { throw new Error(`réponse non JSON de ${new URL(url).host} (protection anti-robot ?)`); }
}
