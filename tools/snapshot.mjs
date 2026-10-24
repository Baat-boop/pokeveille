// Dev helper: save raw catalogues once (politely) so classification can be tuned offline.
// Usage: node test/snapshot.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { politeJson, politeGet } from '../src/http.js';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const sources = JSON.parse(fs.readFileSync('config/sources.json', 'utf8')).filter(s => s.enabled !== false);
for (const s of sources) {
  if (s.type === 'shopify') {
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const { data } = await politeJson(`${s.baseUrl}/products.json?limit=250&page=${page}`);
      all.push(...data.products);
      if (data.products.length < 250) break;
    }
    fs.writeFileSync(path.join(out, `${s.id}.json`), JSON.stringify({ products: all }));
    console.log(s.id, all.length);
  } else if (s.type === 'dealabs') {
    fs.writeFileSync(path.join(out, `${s.id}.xml`), await (await politeGet(s.url)).text());
    console.log(s.id, 'rss');
  }
}
