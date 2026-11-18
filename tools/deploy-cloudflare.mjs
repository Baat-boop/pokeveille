#!/usr/bin/env node
/*
 * Publie Traque (docs/manhunt) sur Cloudflare, sous forme d'un Worker qui contient tous les fichiers du jeu.
 *
 * Pourquoi un Worker et pas Cloudflare Pages : l'envoi de fichiers vers Pages passe par un jeton temporaire
 * que la clé injectée par le proxy de la session empêche de fonctionner. Un Worker s'envoie en une seule
 * requête authentifiée avec la Global API Key.
 *
 * Utilisation :
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_EMAIL=… [CLOUDFLARE_API_KEY=…] node tools/deploy-cloudflare.mjs
 * Dans une session Claude Code, la clé est ajoutée par le proxy : CLOUDFLARE_API_KEY peut rester vide.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../docs/manhunt/', import.meta.url).pathname;
const NAME = process.env.WORKER_NAME || 'traque';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const EMAIL = process.env.CLOUDFLARE_EMAIL;
const KEY = process.env.CLOUDFLARE_API_KEY || 'proxy-injected';
if (!ACCOUNT || !EMAIL) { console.error('CLOUDFLARE_ACCOUNT_ID et CLOUDFLARE_EMAIL sont requis.'); process.exit(1); }

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
const files = walk(ROOT).filter((p) => !p.endsWith('/_headers') && TYPES[extname(p)]);

const tmp = mkdtempSync(join(tmpdir(), 'traque-cf-'));
const parts = [];
const table = [];
files.forEach((abs, i) => {
  const path = '/' + relative(ROOT, abs);
  const mod = `assets/${i}.bin`;
  parts.push(['-F', `${mod}=@${abs};filename=${mod};type=application/octet-stream`]);
  table.push(`  ${JSON.stringify(path)}: [m${i}, ${JSON.stringify(TYPES[extname(abs)])}, ${JSON.stringify(cacheFor(path))}],`);
});

const worker = `${files.map((_, i) => `import m${i} from './assets/${i}.bin';`).join('\n')}

const FILES = {
${table.join('\n')}
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

export default {
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const f = FILES[path] || FILES[path + '/index.html'];
    if (!f) return new Response('Page introuvable', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } });
    return new Response(f[0], { headers: { 'content-type': f[1], 'cache-control': f[2], ...SECURITY } });
  },
};
`;
writeFileSync(join(tmp, 'worker.js'), worker);
writeFileSync(join(tmp, 'metadata.json'), JSON.stringify({ main_module: 'worker.js', compatibility_date: '2025-06-01' }));

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`;
const auth = ['-H', `X-Auth-Email: ${EMAIL}`, '-H', `X-Auth-Key: ${KEY}`];
function call(args) {
  const out = execFileSync('curl', ['-sS', ...auth, ...args], { maxBuffer: 1 << 26 }).toString();
  const res = JSON.parse(out);
  if (!res.success) { console.error(JSON.stringify(res.errors)); process.exit(1); }
  return res.result;
}

console.log(`Envoi de ${files.length} fichiers dans le Worker « ${NAME} »…`);
call(['-X', 'PUT', `${API}/scripts/${NAME}`,
  '-F', `metadata=@${join(tmp, 'metadata.json')};type=application/json`,
  '-F', `worker.js=@${join(tmp, 'worker.js')};filename=worker.js;type=application/javascript+module`,
  ...parts.flat()]);
call(['-X', 'POST', `${API}/scripts/${NAME}/subdomain`, '-H', 'Content-Type: application/json', '-d', '{"enabled":true,"previews_enabled":false}']);
const sub = call([`${API}/subdomain`]).subdomain;
console.log(`En ligne : https://${NAME}.${sub}.workers.dev/`);
