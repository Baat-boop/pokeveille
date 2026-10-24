// Local preview: node tools/serve.mjs  → http://localhost:8080/docs/?local
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    const idx = path.join(p, 'index.html');
    if (fs.existsSync(idx)) { res.writeHead(200, { 'Content-Type': types['.html'] }); return res.end(fs.readFileSync(idx)); }
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}).listen(8080, () => console.log('http://localhost:8080/docs/?local'));
