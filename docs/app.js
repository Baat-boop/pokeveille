// PokéVeille web page: reads the data published by the scheduled checker (GitHub "data" branch)
// and the configuration (main branch). Everything here runs in the browser; nothing is sent anywhere
// except the address you type, which goes to the free IGN geocoder to compute distances.
import { norm } from './shared/text.js';
import { TYPES, LANGS } from './shared/classify.js';
import { matchOffer, STATUS, CHANNELS } from './shared/match.js';
import { haversineM, walkMinutes, formatDistance } from './shared/geo.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const local = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- where the data lives ----------
function repoInfo() {
  const p = new URLSearchParams(location.search);
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m && !p.has('local')) return { owner: m[1], repo: location.pathname.split('/').filter(Boolean)[0] };
  return { local: true };
}
const R = repoInfo();
const bust = `t=${Math.floor(Date.now() / 60000)}`;
const URLS = R.local
  ? { data: '../.data-local/', config: '../config/' }
  : { data: `https://raw.githubusercontent.com/${R.owner}/${R.repo}/data/`, config: `https://raw.githubusercontent.com/${R.owner}/${R.repo}/main/config/` };
const REPO = R.local ? null : `https://github.com/${R.owner}/${R.repo}`;

async function getJson(url, fallback) {
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + bust, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return fallback; }
}

// ---------- formatting ----------
const euro = v => (v == null ? '—' : `${v.toFixed(2).replace('.', ',')} €`);
function ago(iso) {
  if (!iso) return 'jamais';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
const when = iso => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const KIND_LABEL = { restock: '🟢 Retour en stock', new: '🆕 Nouvelle offre', deal: '💡 Bon plan' };

// ---------- state ----------
const S = { offers: [], status: null, alerts: [], sources: [], configSearches: [], searches: [], stores: null, shown: 60 };

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== `tab-${name}`));
  local.set('pv-tab', name);
  if (name === 'magasins') renderStores();
}

// ---------- offers ----------
const DEFAULT_TYPES = ['etb', 'display', 'coffret', 'booster'];
function checks(container, entries, checked, name) {
  $(container).innerHTML = entries.map(([v, l]) => `<label><input type="checkbox" name="${name}" value="${v}" ${checked.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('');
}
const checkedValues = container => [...document.querySelectorAll(`${container} input:checked`)].map(i => i.value);

function initOfferFilters() {
  checks('#f-types', Object.entries(TYPES), DEFAULT_TYPES, 'type');
  checks('#f-langs', [...Object.entries(LANGS), ['?', 'Non précisée']], ['fr', '?'], 'lang');
  $('#f-source').innerHTML = '<option value="">Toutes</option>' + S.sources.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  refreshSearchSelect();
  $('#tab-offres .panel').addEventListener('input', e => { if (e.target.id !== 'f-search') { S.shown = 60; renderOffers(); } });
  $('#f-search').addEventListener('change', () => applySearchToFilters(S.searches.find(s => s.id === $('#f-search').value)));
  $('#more').addEventListener('click', () => { S.shown += 100; renderOffers(); });
}
function refreshSearchSelect() {
  const cur = $('#f-search').value;
  $('#f-search').innerHTML = '<option value="">— Aucune (filtres libres) —</option>' + S.searches.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#f-search').value = S.searches.some(s => s.id === cur) ? cur : '';
}
function applySearchToFilters(s) {
  if (!s) return;
  $('#f-q').value = (s.keywords ?? []).join(', ');
  $('#f-max').value = s.maxPrice ?? '';
  const types = s.types?.length ? s.types : Object.keys(TYPES);
  document.querySelectorAll('#f-types input').forEach(i => (i.checked = types.includes(i.value)));
  const langs = s.languages?.length ? s.languages : Object.keys(LANGS);
  document.querySelectorAll('#f-langs input').forEach(i => (i.checked = i.value === '?' ? s.allowUnknownLanguage !== false : langs.includes(i.value)));
  const ch = s.channels?.length ? s.channels : ['online', 'deal'];
  $('#f-online').checked = ch.includes('online');
  $('#f-deals').checked = ch.includes('deal');
  $('#f-promo').checked = !!s.promoOnly;
  $('#f-source').value = '';
  S.filterSearch = s;
  S.shown = 60;
  renderOffers();
}

function currentFilter() {
  const langs = checkedValues('#f-langs');
  const kw = $('#f-q').value.split(',').map(x => x.trim()).filter(Boolean);
  const chosen = S.filterSearch && $('#f-search').value === S.filterSearch.id ? S.filterSearch : null;
  return {
    keywords: kw,
    excludeKeywords: chosen?.excludeKeywords ?? [],
    types: checkedValues('#f-types'),
    languages: langs.filter(l => l !== '?'),
    allowUnknownLanguage: langs.includes('?'),
    maxPrice: $('#f-max').value === '' ? null : Number($('#f-max').value),
    retailers: $('#f-source').value ? [$('#f-source').value] : chosen?.retailers ?? [],
    channels: [$('#f-online').checked && 'online', $('#f-deals').checked && 'deal'].filter(Boolean),
    promoOnly: $('#f-promo').checked,
    includePreorder: chosen ? chosen.includePreorder !== false : true,
  };
}

function offerCard(o) {
  const statusCls = o.channel === 'deal' ? 's-deal' : `s-${o.status}`;
  const statusTxt = o.channel === 'deal' ? 'Bon plan signalé · stock non vérifié' : STATUS[o.status];
  const shop = o.merchant ? `${esc(o.merchant)} <span class="muted">(via Dealabs)</span>` : esc(o.sourceName);
  const notes = [];
  if (o.stale) notes.push(`<span class="warn">⚠ Boutique injoignable au dernier passage : information du ${when(o.checkedAt)}</span>`);
  if (o.removed) notes.push(`<span class="warn">Retiré du catalogue (dernier statut connu : ${esc(STATUS[o.lastKnownStatus] ?? '—')})</span>`);
  return `<article class="card">
    ${o.image ? `<img loading="lazy" src="${esc(o.image)}" alt="">` : '<div class="noimg"></div>'}
    <div>
      <div class="t"><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a></div>
      <div class="meta">
        <span class="badge ${statusCls}">${esc(statusTxt)}</span>
        <span>${shop}</span>
        <span>${esc(CHANNELS[o.channel])}${o.channel === 'online' ? ' · livraison France' : ''}</span>
        <span>${esc(TYPES[o.type] ?? o.type)}</span>
        <span>${o.lang ? esc(LANGS[o.lang]) + (o.langGuessed ? ' (déduit)' : '') : 'Langue non précisée'}</span>
        ${o.setCode ? `<span>${esc(o.setCode)}</span>` : ''}
        <span title="${esc(when(o.checkedAt))}">${o.channel === 'deal' ? `Posté ${ago(o.postedAt)}` : `Vérifié ${ago(o.checkedAt)}`}</span>
      </div>
      ${notes.length ? `<div class="meta">${notes.join(' ')}</div>` : ''}
    </div>
    <div class="price">${euro(o.price)}${o.compareAtPrice ? `<s>${euro(o.compareAtPrice)}</s>` : ''}</div>
  </article>`;
}

function renderOffers() {
  const f = currentFilter();
  const onlyAvail = $('#f-onlyavail').checked;
  const list = S.offers.filter(o => matchOffer(o, f) && (!onlyAvail || o.channel === 'deal' || ((o.status === 'disponible' || (o.status === 'precommande' && f.includePreorder)) && !o.stale)));
  const rank = { disponible: 0, precommande: 1, inconnu: 2, rupture: 3 };
  list.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.price ?? 1e9) - (b.price ?? 1e9)));
  const count = st => list.filter(o => o.status === st && o.channel !== 'deal').length;
  $('#offers-summary').innerHTML = [
    `<span class="chip">${list.length} résultat(s)</span>`,
    `<span class="chip s-disponible">${count('disponible')} disponible(s)</span>`,
    `<span class="chip s-precommande">${count('precommande')} précommande(s)</span>`,
    onlyAvail ? '' : `<span class="chip s-rupture">${count('rupture')} en rupture</span>`,
    `<span class="chip s-deal">${list.filter(o => o.channel === 'deal').length} bon(s) plan(s)</span>`,
  ].join('');
  $('#offers').innerHTML = list.length ? list.slice(0, S.shown).map(offerCard).join('') : `<div class="panel muted">${S.offers.length ? 'Aucune offre ne correspond à ces filtres pour le moment.' : 'Aucune donnée pour l’instant : la première vérification automatique n’a pas encore publié de résultats.'}</div>`;
  $('#more').classList.toggle('hidden', list.length <= S.shown);
}

// ---------- stores ----------
let map, layer;
function storePoint() {
  return local.get('pv-point', null) ?? { label: S.stores?.zone?.label ?? 'Amiens (centre)', lat: S.stores?.zone?.lat ?? 49.8942, lon: S.stores?.zone?.lon ?? 2.2957 };
}
async function geocode(q) {
  const r = await fetch(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=1&lat=49.8942&lon=2.2957`);
  const f = (await r.json()).features?.[0];
  if (!f) throw new Error('Adresse introuvable');
  return { label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
}
function renderStores() {
  if (!S.stores) { $('#stores').innerHTML = '<div class="panel muted">Liste des magasins indisponible.</div>'; return; }
  const p = storePoint();
  $('#m-from').textContent = `Départ : ${p.label}`;
  const radius = Number($('#m-radius').value) * 1000, walk = Number($('#m-walk').value), like = $('#m-like').value;
  const list = S.stores.stores
    .map(s => ({ ...s, d: haversineM(p, s), stops: s.stopsNearby.filter(x => x.walkM <= walk) }))
    .filter(s => s.d <= radius && s.stops.length && (!like || s.likelihood === like))
    .sort((a, b) => a.d - b.d);
  $('#stores').innerHTML = list.length ? list.map(s => `<article class="card store">
      <div>
        <div class="t">${esc(s.name)} <span class="badge ${s.likelihood === 'probable' ? 's-disponible' : 's-inconnu'}">${s.likelihood === 'probable' ? 'Vente probable' : 'Vente possible'}</span></div>
        <div class="meta"><span>${esc(s.kind)}</span><span>${s.address ? esc(s.address) + (s.addressApprox ? ' (adresse approximative)' : '') : 'Adresse non renseignée'}</span></div>
        <div class="meta">${s.stops.slice(0, 2).map(x => `<span>🚌 ${esc(x.name)} · ${walkMinutes(x.walkM)} min à pied · <span class="lines">${x.lines.map(l => `<span class="line">${esc(l)}</span>`).join('')}</span></span>`).join('')}</div>
        <div class="meta"><span class="badge s-inconnu">Stock : non vérifiable automatiquement</span>
          ${s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener">Site du magasin</a>` : ''}
          ${s.phone ? `<a href="tel:${esc(s.phone.replace(/\s/g, ''))}">${esc(s.phone)}</a>` : ''}
          <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=transit" target="_blank" rel="noopener">Itinéraire en bus</a></div>
      </div>
      <div class="price">${formatDistance(s.d)}<s style="text-decoration:none">à vol d'oiseau</s></div>
    </article>`).join('') : '<div class="panel muted">Aucun magasin dans ce rayon avec un arrêt Ametis assez proche.</div>';
  $('#stores-attrib').textContent = `${S.stores.attribution.join(' · ')} — liste générée ${ago(S.stores.generatedAt)}. Temps de marche estimés (distance à vol d'oiseau × 1,3).`;

  if (window.L) {
    if (!map) {
      map = L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    L.circleMarker([p.lat, p.lon], { radius: 8, color: '#1f5fbf', fillOpacity: 0.9 }).bindPopup('Point de départ').addTo(layer);
    for (const s of list) L.marker([s.lat, s.lon]).bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.kind)}<br>${formatDistance(s.d)}`).addTo(layer);
    const pts = [[p.lat, p.lon], ...list.map(s => [s.lat, s.lon])];
    map.fitBounds(pts, { padding: [24, 24], maxZoom: 15 });
    setTimeout(() => map.invalidateSize(), 50);
  } else $('#map').classList.add('hidden');
}
function initStores() {
  $('#m-addr').value = local.get('pv-point', null)?.label ?? '';
  ['#m-radius', '#m-walk', '#m-like'].forEach(id => $(id).addEventListener('change', renderStores));
  const go = async () => {
    const q = $('#m-addr').value.trim();
    if (!q) { local.del('pv-point'); renderStores(); return; }
    try { local.set('pv-point', await geocode(q)); renderStores(); }
    catch (e) { $('#m-from').textContent = e.message; }
  };
  $('#m-go').addEventListener('click', go);
  $('#m-addr').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#m-geo').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => { local.set('pv-point', { label: 'Ma position', lat: pos.coords.latitude, lon: pos.coords.longitude }); $('#m-addr').value = ''; renderStores(); },
      () => { $('#m-from').textContent = 'Position refusée ou indisponible.'; },
    );
  });
}

// ---------- searches editor ----------
const NEW_SEARCH = () => ({ id: '', name: 'Nouvelle recherche', enabled: true, notify: true, keywords: [], excludeKeywords: [], types: [...DEFAULT_TYPES], languages: ['fr'], allowUnknownLanguage: true, maxPrice: null, retailers: [], channels: ['online', 'deal'], includePreorder: true, includeDeals: true, promoOnly: false });
const slug = s => norm(s).replace(/\s+/g, '-').slice(0, 30) || 'recherche';
const isDirty = () => JSON.stringify(S.searches) !== JSON.stringify(S.configSearches);

function describe(s) {
  const parts = [];
  parts.push(s.types?.length ? s.types.map(t => TYPES[t] ?? t).join(', ') : 'tous types');
  parts.push(s.languages?.length ? s.languages.map(l => LANGS[l] ?? l).join('/') : 'toutes langues');
  if (s.keywords?.length) parts.push(`mots-clés : ${s.keywords.join(' | ')}`);
  if (s.maxPrice != null) parts.push(`≤ ${euro(s.maxPrice)}`);
  if (s.retailers?.length) parts.push(`boutiques : ${s.retailers.join(', ')}`);
  if (s.promoOnly) parts.push('promos');
  return parts.join(' · ');
}
function renderSearches() {
  $('#searches').innerHTML = S.searches.map((s, i) => {
    const n = S.offers.filter(o => matchOffer(o, s) && (o.status === 'disponible' || (o.status === 'precommande' && s.includePreorder !== false)) && !o.stale).length;
    return `<div class="search-item">
      <div><b>${esc(s.name)}</b> ${s.enabled === false ? '<span class="badge s-inconnu">désactivée</span>' : ''} ${s.notify === false ? '<span class="badge s-inconnu">sans alerte</span>' : '<span class="badge s-deal">alertes Discord</span>'}
        <div class="small muted">${esc(describe(s))}</div>
        <div class="small">${n} offre(s) disponible(s) en ce moment</div></div>
      <div class="row"><button class="btn" data-view="${i}">Voir</button><button class="btn" data-edit="${i}">Modifier</button></div>
    </div>`;
  }).join('') || '<p class="muted">Aucune recherche.</p>';
  $('#s-dirty').classList.toggle('hidden', !isDirty());
  refreshSearchSelect();
}
function persistDraft() {
  if (isDirty()) local.set('pv-draft', S.searches); else local.del('pv-draft');
  renderSearches();
}
function openEditor(index) {
  const s = index == null ? NEW_SEARCH() : structuredClone(S.searches[index]);
  const form = $('#edit-form');
  $('#edit-title').textContent = index == null ? 'Nouvelle recherche' : 'Modifier la recherche';
  $('#e-delete').classList.toggle('hidden', index == null);
  form.sname.value = s.name;
  form.maxPrice.value = s.maxPrice ?? '';
  form.keywords.value = (s.keywords ?? []).join('\n');
  form.excludeKeywords.value = (s.excludeKeywords ?? []).join('\n');
  checks('#e-types', Object.entries(TYPES), s.types ?? [], 'etype');
  checks('#e-langs', Object.entries(LANGS), s.languages ?? [], 'elang');
  const sourceIds = S.sources.map(x => x.id);
  checks('#e-sources', S.sources.filter(x => x.type !== 'dealabs').map(x => [x.id, x.name]), s.retailers ?? [], 'esrc');
  form.merchants.value = (s.retailers ?? []).filter(r => !sourceIds.includes(r)).join('\n');
  form.allowUnknownLanguage.checked = s.allowUnknownLanguage !== false;
  form.online.checked = !s.channels?.length || s.channels.includes('online');
  form.deal.checked = !s.channels?.length || s.channels.includes('deal');
  form.includePreorder.checked = s.includePreorder !== false;
  form.promoOnly.checked = !!s.promoOnly;
  form.notify.checked = s.notify !== false;
  form.enabled.checked = s.enabled !== false;
  const dlg = $('#edit-dlg');
  dlg.onclose = () => {
    const action = dlg.returnValue;
    if (action === 'cancel' || !action) return;
    if (action === 'delete') {
      if (confirm(`Supprimer « ${s.name} » ?`)) { S.searches.splice(index, 1); persistDraft(); }
      return;
    }
    const lines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
    const out = {
      ...s,
      name: form.sname.value.trim() || 'Recherche',
      maxPrice: form.maxPrice.value === '' ? null : Number(form.maxPrice.value),
      keywords: lines(form.keywords.value),
      excludeKeywords: lines(form.excludeKeywords.value),
      types: checkedValues('#e-types'),
      languages: checkedValues('#e-langs'),
      allowUnknownLanguage: form.allowUnknownLanguage.checked,
      retailers: [...checkedValues('#e-sources'), ...lines(form.merchants.value)],
      channels: [form.online.checked && 'online', form.deal.checked && 'deal'].filter(Boolean),
      includePreorder: form.includePreorder.checked,
      includeDeals: form.deal.checked,
      promoOnly: form.promoOnly.checked,
      notify: form.notify.checked,
      enabled: form.enabled.checked,
    };
    if (!out.id) {
      let id = slug(out.name), n = 2;
      while (S.searches.some(x => x.id === id)) id = `${slug(out.name)}-${n++}`;
      out.id = id;
    }
    if (index == null) S.searches.push(out); else S.searches[index] = out;
    persistDraft();
    if (action === 'preview') { showTab('offres'); $('#f-search').value = out.id; applySearchToFilters(out); }
  };
  dlg.returnValue = '';
  dlg.showModal();
}
function initSearches() {
  $('#searches').addEventListener('click', e => {
    const edit = e.target.dataset.edit, view = e.target.dataset.view;
    if (edit != null) openEditor(Number(edit));
    if (view != null) { const s = S.searches[Number(view)]; showTab('offres'); $('#f-search').value = s.id; applySearchToFilters(s); }
  });
  $('#s-add').addEventListener('click', () => openEditor(null));
  $('#s-save').addEventListener('click', () => {
    $('#save-json').value = JSON.stringify({ searches: S.searches }, null, 2) + '\n';
    if (REPO) $('#save-open').href = `${REPO}/edit/main/config/searches.json`;
    else $('#save-open').removeAttribute('href');
    $('#save-dlg').showModal();
  });
  $('#save-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#save-json').value); $('#save-copy').textContent = 'Copié ✔'; }
    catch { $('#save-json').select(); document.execCommand('copy'); $('#save-copy').textContent = 'Copié ✔'; }
    setTimeout(() => ($('#save-copy').textContent = 'Copier'), 2000);
  });
  $('#save-close').addEventListener('click', () => $('#save-dlg').close());
}

// ---------- alerts & status ----------
function renderAlerts() {
  const byId = Object.fromEntries(S.searches.map(s => [s.id, s.name]));
  $('#alerts').innerHTML = S.alerts.length ? `<table><thead><tr><th>Quand</th><th>Alerte</th><th>Produit</th><th>Prix</th><th>Recherche</th></tr></thead><tbody>${S.alerts.slice(0, 150).map(a => `<tr>
    <td>${when(a.at)}</td><td>${KIND_LABEL[a.kind] ?? a.kind}${a.sent ? '' : ' <span class="muted small">(non envoyée)</span>'}</td>
    <td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><div class="small muted">${esc(a.sourceName)}</div></td>
    <td>${euro(a.price)}</td><td class="small">${esc(a.searchIds.map(id => byId[id] ?? id).join(', '))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Aucune alerte pour l’instant. Les récapitulatifs de premier passage ne figurent pas ici.</p>';
}
function renderStatus() {
  const st = S.status;
  if (!st) { $('#status').innerHTML = '<p class="muted">Aucune vérification n’a encore été publiée.</p>'; return; }
  $('#status').innerHTML = `
    <p>Dernier passage : <b>${when(st.lastRunAt)}</b> (${ago(st.lastRunAt)}). ${st.alertsSent} alerte(s) envoyée(s) à ce passage.</p>
    ${st.webhookConfigured ? '<p>✅ Discord connecté.</p>' : '<div class="notice">Discord n’est pas encore connecté : les alertes sont enregistrées mais pas envoyées. Voir le guide d’installation (README).</div>'}
    <table><thead><tr><th>Source</th><th>État</th><th>Produits Pokémon</th><th>Disponibles</th></tr></thead><tbody>
    ${st.sources.map(s => `<tr><td>${esc(s.name)}</td><td>${s.ok ? '✅ OK' : `⚠ ${esc(s.error)}${s.lastOkAt ? `<div class="small muted">Dernier succès : ${when(s.lastOkAt)}</div>` : ''}`}</td><td>${s.count ?? '—'}</td><td>${s.available ?? '—'}</td></tr>`).join('')}
    </tbody></table>
    ${REPO ? `<p class="small"><a href="${REPO}/actions/workflows/check.yml" target="_blank" rel="noopener">Lancer une vérification maintenant</a> (bouton « Run workflow » sur GitHub) · <a href="${REPO}" target="_blank" rel="noopener">Projet GitHub</a></p>` : ''}
    <p class="small muted">Liste des magasins générée ${ago(S.stores?.generatedAt)}.</p>`;
}

// ---------- boot ----------
(async () => {
  const [offers, status, alerts, sources, searches, stores] = await Promise.all([
    getJson(URLS.data + 'offers.json', null), getJson(URLS.data + 'status.json', null), getJson(URLS.data + 'alerts.json', { alerts: [] }),
    getJson(URLS.config + 'sources.json', []), getJson(URLS.config + 'searches.json', { searches: [] }), getJson('data/stores.json', null),
  ]);
  if (!offers) {
    const n = $('#load-error');
    n.innerHTML = 'Pas encore de données de vérification publiées. Si vous venez d’installer l’application, attendez le premier passage automatique (≈ 15 min) ou lancez-le depuis l’onglet « État ».';
    n.classList.remove('hidden');
  }
  S.offers = offers?.offers ?? [];
  S.status = status;
  S.alerts = alerts?.alerts ?? [];
  S.sources = sources.filter(s => s.enabled !== false);
  S.configSearches = searches.searches ?? [];
  S.searches = local.get('pv-draft', null) ?? structuredClone(S.configSearches);
  S.stores = stores;

  initOfferFilters();
  initStores();
  initSearches();
  renderOffers();
  renderSearches();
  renderAlerts();
  renderStatus();
  showTab(local.get('pv-tab', 'offres'));
})();
