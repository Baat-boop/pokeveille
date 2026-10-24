// Distances. Walking distance is estimated (straight line x 1.3) since no free routing is called per store.
export function haversineM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const WALK_FACTOR = 1.3;
export const estimateWalkM = (a, b) => Math.round(haversineM(a, b) * WALK_FACTOR);
export const walkMinutes = m => Math.max(1, Math.round(m / 80)); // ~4.8 km/h

export function formatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
