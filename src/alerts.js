// Pure logic: merge fresh catalogue data with the previous run, then decide which alerts to send.
import { matchOffer, isActionable, searchHash } from '../docs/shared/match.js';

export const RESTOCK_COOLDOWN_MS = 60 * 60 * 1000;          // at most one restock alert per hour per offer and search
export const REMOVED_RETENTION_MS = 30 * 24 * 3600 * 1000;  // forget products gone from a catalogue for 30 days
export const PRICE_DROP_RATIO = 0.9;                        // price alert when at least 10 % below the last notified price

/**
 * @param prevOffers  {key: offer} from the previous run
 * @param runs        {sourceId: {ok: boolean, offers?: offer[]}} results of this run
 * @param now         epoch ms
 * @returns {key: offer}
 */
export function mergeOffers(prevOffers, runs, now) {
  const iso = new Date(now).toISOString();
  const out = {};
  for (const [sourceId, run] of Object.entries(runs)) {
    const prevOfSource = Object.values(prevOffers).filter(o => o.sourceId === sourceId);
    if (!run.ok) {
      // Source unreachable: keep what we knew, flagged as stale. Never invent a new status.
      for (const o of prevOfSource) out[o.key] = { ...o, stale: true };
      continue;
    }
    const seen = new Set();
    for (const o of run.offers) {
      const prev = prevOffers[o.key];
      seen.add(o.key);
      const statusChanged = !prev || prev.status !== o.status;
      out[o.key] = {
        ...o,
        checkedAt: iso,
        firstSeenAt: prev?.firstSeenAt ?? iso,
        statusChangedAt: statusChanged ? iso : prev.statusChangedAt ?? iso,
        stale: false,
        removed: false,
      };
      delete out[o.key].lastKnownStatus;
    }
    for (const o of prevOfSource) {
      if (seen.has(o.key)) continue;
      const removedAt = o.removed ? o.removedAt : iso;
      if (now - Date.parse(removedAt) > REMOVED_RETENTION_MS) continue;
      out[o.key] = {
        ...o,
        status: 'inconnu',
        lastKnownStatus: o.removed ? o.lastKnownStatus : o.status,
        removed: true,
        removedAt,
        stale: false,
        checkedAt: iso,
      };
    }
  }
  return out;
}

const KIND_RANK = { restock: 4, new: 3, price: 2, deal: 1, listed: 0 };

/**
 * Decide alerts. Rules:
 *  - "restock": the offer was out of stock (or gone) and is now available / preorderable.
 *  - "new": an available offer matches the search for the first time.
 *  - "price": an already-notified available offer is now at least 10 % cheaper than when last notified.
 *  - "deal": a new community deal (Dealabs) matches the search.
 *  - A (search, offer) pair is notified once; it is re-armed only when the offer goes out of stock again.
 *  - New searches, changed criteria and newly added sources are baselined silently (one digest instead of a flood).
 * @returns {alerts: [{kind, offer, searchIds}], digests: {searchId: offer[]}, state}
 */
export function computeAlerts({ prevOffers, offers, runs, searches, state, now }) {
  const next = {
    notified: { ...(state?.notified ?? {}) },
    searches: { ...(state?.searches ?? {}) },
    sources: { ...(state?.sources ?? {}) },
  };
  for (const k of Object.keys(next.notified)) next.notified[k] = { ...next.notified[k] };

  const active = searches.filter(s => s && s.id && s.enabled !== false);
  const baseline = new Set();
  for (const s of active) {
    const h = searchHash(s);
    if (next.searches[s.id]?.hash !== h) {
      baseline.add(s.id);
      next.searches[s.id] = { hash: h, since: new Date(now).toISOString() };
    }
  }
  const activeIds = new Set(active.map(s => s.id));
  for (const id of Object.keys(next.searches)) if (!activeIds.has(id)) delete next.searches[id];

  const firstRun = new Set();
  for (const [id, run] of Object.entries(runs)) {
    if (!run.ok) continue;
    if (!next.sources[id]?.firstOkAt) firstRun.add(id);
    next.sources[id] = { ...(next.sources[id] ?? {}), firstOkAt: next.sources[id]?.firstOkAt ?? new Date(now).toISOString() };
  }

  const byOffer = new Map();
  const digests = {};
  const add = (kind, offer, searchId, extra = {}) => {
    const cur = byOffer.get(offer.key);
    if (!cur) byOffer.set(offer.key, { kind, offer, searchIds: [searchId], ...extra });
    else {
      cur.searchIds.push(searchId);
      if (KIND_RANK[kind] > KIND_RANK[cur.kind]) Object.assign(cur, { kind, ...extra });
    }
  };
  const silentMark = (k, o, s) => {
    next.notified[k] = { at: now, status: o.status, price: o.price, armed: false, silent: true };
    (digests[s.id] ??= []).push(o);
  };

  for (const s of active) {
    for (const o of Object.values(offers)) {
      if (!runs[o.sourceId]?.ok || o.stale) continue;
      if (!matchOffer(o, s)) continue;
      const k = `${s.id}|${o.key}`;
      const entry = next.notified[k];
      const silent = baseline.has(s.id) || firstRun.has(o.sourceId);

      if (o.removed || o.status === 'rupture') {
        if (entry) entry.armed = true;
        // A product that appears in a catalogue before it can be bought: announce it (upcoming release).
        else if (!silent && !o.removed && !prevOffers[o.key] && s.notifyListed !== false && o.channel === 'online') add('listed', o, s.id);
        continue;
      }
      if (o.channel === 'deal') {
        if (s.includeDeals === false || entry) continue;
        if (silent) silentMark(k, o, s); else add('deal', o, s.id);
        continue;
      }
      if (!isActionable(o, s)) continue;

      if (silent) {
        // Baseline: list everything that already matches, without individual alerts.
        if (!entry || entry.armed) silentMark(k, o, s); else (digests[s.id] ??= []).push(o);
        continue;
      }
      if (!entry) {
        const prev = prevOffers[o.key];
        const wasOut = prev && (prev.status === 'rupture' || (prev.removed && prev.lastKnownStatus === 'rupture'));
        add(wasOut ? 'restock' : 'new', o, s.id);
      } else if (entry.armed) {
        if (now - entry.at < RESTOCK_COOLDOWN_MS) continue;
        add(entry.listedAt ? 'new' : 'restock', o, s.id);
      } else if (s.notifyPriceDrop !== false && entry.price != null && o.price != null && o.price <= entry.price * PRICE_DROP_RATIO) {
        add('price', o, s.id, { prevPrice: entry.price });
      }
    }
  }

  // Forget pairs whose offer or search no longer exists.
  for (const k of Object.keys(next.notified)) {
    const [sid, ...rest] = k.split('|');
    if (!activeIds.has(sid) || !offers[rest.join('|')]) delete next.notified[k];
  }

  const order = { restock: 0, new: 1, price: 2, deal: 3, listed: 4 };
  const alerts = [...byOffer.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.offer.price ?? 1e9) - (b.offer.price ?? 1e9));
  return { alerts, digests, state: next };
}

/** Call once an alert has been delivered, so it is never repeated for an unchanged offer. */
export function markSent(state, alert, now) {
  for (const sid of alert.searchIds) {
    state.notified[`${sid}|${alert.offer.key}`] = alert.kind === 'listed'
      // announced but not buyable yet: stay armed so the first availability triggers a "restock" alert right away
      ? { at: 0, status: alert.offer.status, price: alert.offer.price, armed: true, listedAt: now }
      : { at: now, status: alert.offer.status, price: alert.offer.price, armed: false };
  }
}
