#!/usr/bin/env node
/*
 * Publie Traque sur Cloudflare : un Worker qui sert les fichiers du jeu (docs/manhunt) et héberge
 * le relais de jeu (worker/relay.js, un Durable Object par partie).
 *
 * Pourquoi un Worker et pas Cloudflare Pages : l'envoi de fichiers vers Pages passe par un jeton temporaire
 * que la clé injectée par le proxy de la session empêche de fonctionner. Un Worker s'envoie en une seule
 * requête authentifiée avec la Global API Key.
 *
 * Publier :
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_EMAIL=… [CLOUDFLARE_API_KEY=…] node tools/deploy-cloudflare.mjs
 *   (dans une session Claude Code, la clé est ajoutée par le proxy : CLOUDFLARE_API_KEY peut rester vide)
 * Tester en local (wrangler dev) :
 *   node tools/deploy-cloudflare.mjs --local <dossier>   puis   npx wrangler dev   dans ce dossier
 */
import { readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../docs/manhunt/', import.meta.url).pathname;
const RELAY = new URL('../worker/relay.js', import.meta.url).pathname;
const NAME = process.env.WORKER_NAME || 'traque';
const LOCAL = process.argv[2] === '--local' ? process.argv[3] : null;
const COMPAT = '2025-06-01';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
// Page, appli et version : toujours revalidées (mise à jour immédiate). Bibliothèques et images : 7 jours.
function cacheFor(path) {
  if (path === '/version.txt') return 'no-store';
  if (path.startsWith('/vendor/') || path.endsWith('.png')) return 'public, max-age=604800';
  return 'public, max-age=0, must-revalidate';
}
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT).filter((p) => TYPES[extname(p)]);

const worker = `import { Room, handleRelay } from './relay.js';
${files.map((_, i) => `import m${i} from './assets/${i}.bin';`).join('\n')}
export { Room };

const FILES = {
${files.map((abs, i) => { const path = '/' + relative(ROOT, abs); return `  ${JSON.stringify(path)}: [m${i}, ${JSON.stringify(TYPES[extname(abs)])}, ${JSON.stringify(cacheFor(path))}],`; }).join('\n')}
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/relay/')) return handleRelay(request, env);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const f = FILES[path] || FILES[path + '/index.html'];
    if (!f) return new Response('Page introuvable', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } });
    return new Response(f[0], { headers: { 'content-type': f[1], 'cache-control': f[2], ...SECURITY } });
  },
};
`;

// ---------- version locale (wrangler dev) ----------
if (LOCAL) {
  mkdirSync(join(LOCAL, 'assets'), { recursive: true });
  files.forEach((abs, i) => copyFileSync(abs, join(LOCAL, 'assets', `${i}.bin`)));
  copyFileSync(RELAY, join(LOCAL, 'relay.js'));
  writeFileSync(join(LOCAL, 'worker.js'), worker);
  writeFileSync(join(LOCAL, 'wrangler.toml'), `name = "${NAME}"
main = "worker.js"
compatibility_date = "${COMPAT}"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]

[[rules]]
type = "Data"
globs = ["**/*.bin"]
fallthrough = false
`);
  console.log(`Version locale prête dans ${LOCAL} (lancer : npx wrangler dev)`);
  process.exit(0);
}

// ---------- publication ----------
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const EMAIL = process.env.CLOUDFLARE_EMAIL;
const KEY = process.env.CLOUDFLARE_API_KEY || 'proxy-injected';
if (!ACCOUNT || !EMAIL) { console.error('CLOUDFLARE_ACCOUNT_ID et CLOUDFLARE_EMAIL sont requis.'); process.exit(1); }
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`;
const auth = ['-H', `X-Auth-Email: ${EMAIL}`, '-H', `X-Auth-Key: ${KEY}`];
function call(args) {
  const out = execFileSync('curl', ['-sS', ...auth, ...args], { maxBuffer: 1 << 26 }).toString();
  const res = JSON.parse(out);
  if (!res.success) { console.error(JSON.stringify(res.errors)); process.exit(1); }
  return res.result;
}

// La salle (Durable Object) n'est déclarée qu'une fois : on regarde si c'est déjà fait.
const declared = (call([`${API}/durable_objects/namespaces`]) || []).some((n) => n.script === NAME && n.class === 'Room');
const metadata = {
  main_module: 'worker.js',
  compatibility_date: COMPAT,
  bindings: [{ type: 'durable_object_namespace', name: 'ROOMS', class_name: 'Room' }],
};
if (!declared) metadata.migrations = { new_tag: 'v1', new_sqlite_classes: ['Room'] };

const tmp = mkdtempSync(join(tmpdir(), 'traque-cf-'));
writeFileSync(join(tmp, 'worker.js'), worker);
writeFileSync(join(tmp, 'metadata.json'), JSON.stringify(metadata));
const parts = files.flatMap((abs, i) => ['-F', `assets/${i}.bin=@${abs};filename=assets/${i}.bin;type=application/octet-stream`]);

console.log(`Envoi de ${files.length} fichiers + le relais dans le Worker « ${NAME} »…`);
call(['-X', 'PUT', `${API}/scripts/${NAME}`,
  '-F', `metadata=@${join(tmp, 'metadata.json')};type=application/json`,
  '-F', `worker.js=@${join(tmp, 'worker.js')};filename=worker.js;type=application/javascript+module`,
  '-F', `relay.js=@${RELAY};filename=relay.js;type=application/javascript+module`,
  ...parts]);
call(['-X', 'POST', `${API}/scripts/${NAME}/subdomain`, '-H', 'Content-Type: application/json', '-d', '{"enabled":true,"previews_enabled":false}']);
const sub = call([`${API}/subdomain`]).subdomain;
console.log(`En ligne : https://${NAME}.${sub}.workers.dev/  (relais : wss://${NAME}.${sub}.workers.dev/relay/)`);

