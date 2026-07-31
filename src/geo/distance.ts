/**
 * Great-circle distance and nearest-point selection.
 *
 * Used to pick the sensor closest to the epicentre (whose seismogram drives the
 * bottom timeline). Haversine is naturally robust across the antimeridian, so
 * the Chatham Islands need no special handling here.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const R_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lon points, in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The item nearest `target` by great-circle distance, or `null` if `items` is
 * empty. Ties resolve to the earlier item.
 */
export function nearestTo<T extends LatLon>(
  items: readonly T[],
  target: LatLon
): T | null {
  let best: T | null = null;
  let bestKm = Infinity;
  for (const item of items) {
    const km = haversineKm(item, target);
    if (km < bestKm) {
      bestKm = km;
      best = item;
    }
  }
  return best;
}
