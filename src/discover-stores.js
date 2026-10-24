// Discover physical shops likely to sell Pokémon TCG around Amiens and how to reach them by Ametis bus.
// Sources: OpenStreetMap (Overpass API, ODbL) and the Ametis GTFS (transport.data.gouv.fr, Licence Ouverte).
// Usage: node src/discover-stores.js --gtfs <dir with stops.txt, stop_times.txt, trips.txt, routes.txt>
// This only DISCOVERS shops: their real stock is not published in any open, authorised form.
import fs from 'node:fs';
import path from 'node:path';
import { haversineM, estimateWalkM } from '../docs/shared/geo.js';
import { USER_AGENT } from './http.js';

const settings = JSON.parse(fs.readFileSync('config/settings.json', 'utf8'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const GTFS = arg('gtfs', '.gtfs');
const OUT = arg('out', 'docs/data/stores.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXCLUDED_ROUTES = new Set(settings.bus.excludedRoutes ?? []);

// ---------- GTFS ----------
function readCsv(file) {
  const txt = fs.readFileSync(path.join(GTFS, file), 'utf8').replace(/^﻿/, '');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const split = l => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map(l => { const v = split(l); return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ''])); });
}

function loadBusStops() {
  const routes = Object.fromEntries(readCsv('routes.txt').map(r => [r.route_id, r.route_short_name || r.route_long_name]));
  const tripRoute = Object.fromEntries(readCsv('trips.txt').map(t => [t.trip_id, t.route_id]));
  const stopLines = new Map();
  const txt = fs.readFileSync(path.join(GTFS, 'stop_times.txt'), 'utf8').split(/\r?\n/);
  const head = txt[0].replace(/^﻿/, '').split(',');
  const iTrip = head.indexOf('trip_id'), iStop = head.indexOf('stop_id');
  for (let i = 1; i < txt.length; i++) {
    if (!txt[i]) continue;
    const c = txt[i].split(',');
    const routeId = tripRoute[c[iTrip]];
    if (!routeId || EXCLUDED_ROUTES.has(routeId)) continue;
    if (!stopLines.has(c[iStop])) stopLines.set(c[iStop], new Set());
    stopLines.get(c[iStop]).add(routes[routeId]);
  }
  return readCsv('stops.txt')
    .filter(s => (s.location_type || '0') === '0' && stopLines.has(s.stop_id))
    .map(s => ({ name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, lines: [...stopLines.get(s.stop_id)] }));
}

// ---------- OpenStreetMap ----------
const CHAINS = [
  [/fnac|cultura|espace culturel/i, 'Culture / multimédia', 'probable'],
  [/king jouet|jou[ée] ?club|smyths|grande r[ée]cr[ée]|maxi toys|picwic/i, 'Magasin de jouets', 'probable'],
  [/micromania|game cash|easy cash|cash converters/i, 'Jeux vidéo / occasion', 'probable'],
  [/^(e\.? ?leclerc|carrefour|auchan|intermarch[ée] hyper|cora|hyper u)$/i, 'Hypermarché', 'probable'],
  [/carrefour market|intermarch[ée] super|super u|auchan supermarch[ée]|carrefour contact/i, 'Supermarché', 'possible'],
  [/^(action|gifi|stokomani|noz|maxi bazar|hema|flying tiger|destock 80)$/i, 'Bazar / déstockage', 'possible'],
  [/relay|maison de la presse|mag presse|presse/i, 'Presse', 'possible'],
];
const EXCLUDE_NAME = /drive|boulanger|darty|electro d[ée]p[ôo]t|bureau vall[ée]e|galeries lafayette|top office|direct bureau/i;

function categorize(t) {
  const name = t.name || t.brand;
  if (!name || EXCLUDE_NAME.test(name)) return null;
  for (const [re, kind, likelihood] of CHAINS) if (re.test(t.brand || '') || re.test(name)) return { kind, likelihood };
  if (['games', 'hobby', 'collector', 'anime', 'comic'].includes(t.shop)) return { kind: 'Boutique spécialisée (jeux, BD, manga)', likelihood: 'probable' };
  if (t.shop === 'video_games') return { kind: 'Jeux vidéo', likelihood: 'probable' };
  if (t.shop === 'toys') return { kind: 'Magasin de jouets', likelihood: 'possible' };
  if (t.shop === 'books' && /bulle|manga|\bbd\b|geek|comic/i.test(name)) return { kind: 'Librairie BD / manga', likelihood: 'possible' };
  if (t.shop === 'newsagent') return { kind: 'Presse', likelihood: 'possible' };
  return null;
}

async function overpass(bbox) {
  const q = `[out:json][timeout:90];
(
  nwr["shop"~"^(toys|games|video_games|hobby|comic|anime|collector|books|newsagent|department_store|variety_store|supermarket|hypermarket|electronics)$"](${bbox});
);
out center tags;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
  return (await r.json()).elements;
}

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://data.geopf.fr/geocodage/reverse?lon=${lon}&lat=${lat}&limit=1`, { headers: { 'User-Agent': USER_AGENT } });
    const f = (await r.json()).features?.[0];
    return f ? { label: f.properties.label, approx: true } : null;
  } catch { return null; }
}

function osmAddress(t) {
  if (!t['addr:street']) return null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const city = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  return { label: [street, city].filter(Boolean).join(', '), approx: false };
}

// ---------- main ----------
const stops = loadBusStops();
console.log(`${stops.length} arrêts Ametis desservis`);
const elements = await overpass(settings.discovery.bbox);
console.log(`${elements.length} commerces OSM dans la zone`);

const stores = [];
const seen = new Set();
for (const e of elements) {
  const t = e.tags ?? {};
  const cat = categorize(t);
  if (!cat) continue;
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (lat == null) continue;
  const name = t.name || t.brand;
  const dedupe = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  if (seen.has(dedupe)) continue;
  seen.add(dedupe);

  const nearby = stops
    .map(s => ({ ...s, walkM: estimateWalkM({ lat, lon }, s) }))
    .filter(s => s.walkM <= settings.bus.maxWalkMeters)
    .sort((a, b) => a.walkM - b.walkM);
  const byName = new Map();
  for (const s of nearby) {
    const cur = byName.get(s.name);
    if (!cur) byName.set(s.name, { name: s.name, walkM: s.walkM, lines: new Set(s.lines) });
    else s.lines.forEach(l => cur.lines.add(l));
  }
  const stopsNearby = [...byName.values()].slice(0, 4).map(s => ({ name: s.name, walkM: s.walkM, lines: [...s.lines].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })) }));

  let address = osmAddress(t);
  if (!address) { address = await reverseGeocode(lat, lon); await sleep(250); }

  stores.push({
    id: `osm-${e.type}-${e.id}`,
    name,
    brand: t.brand ?? null,
    kind: cat.kind,
    likelihood: cat.likelihood,
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    address: address?.label ?? null,
    addressApprox: address?.approx ?? true,
    website: t.website || t['contact:website'] || null,
    phone: t.phone || t['contact:phone'] || null,
    openingHours: t.opening_hours ?? null,
    busAccessible: stopsNearby.length > 0,
    stopsNearby,
    distanceFromCenterM: Math.round(haversineM(settings.zone, { lat, lon })),
    stock: 'non vérifiable automatiquement',
  });
}
stores.sort((a, b) => a.distanceFromCenterM - b.distanceFromCenterM);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  zone: settings.zone,
  maxWalkMeters: settings.bus.maxWalkMeters,
  attribution: [
    'Commerces : © contributeurs OpenStreetMap (ODbL)',
    'Arrêts et lignes : réseau Ametis, transport.data.gouv.fr (Licence Ouverte)',
    'Adresses manquantes : Géoplateforme IGN (adresses approximatives)',
  ],
  stores,
}, null, 1) + '\n');
console.log(`${stores.length} magasins retenus (${stores.filter(s => s.busAccessible).length} à ≤ ${settings.bus.maxWalkMeters} m d'un arrêt) → ${OUT}`);
