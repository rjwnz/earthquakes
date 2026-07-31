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
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

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

/**
 * The point reached by travelling `distanceKm` from `origin` along the given
 * initial `bearingDeg` (0 = north, 90 = east) on a great circle.
 */
export function destinationPoint(
  origin: LatLon,
  distanceKm: number,
  bearingDeg: number
): LatLon {
  const delta = distanceKm / R_KM; // angular distance
  const theta = toRad(bearingDeg);
  const phi1 = toRad(origin.lat);
  const lambda1 = toRad(origin.lon);

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  return {lat: toDeg(phi2), lon: toDeg(lambda2)};
}

/**
 * A ring of points all `distanceKm` from `origin` — a wavefront at that radius.
 * Returns `segments` evenly-spaced points (bearings 0..360), ready to project
 * and stroke as a closed curve.
 */
export function wavefrontRing(
  origin: LatLon,
  distanceKm: number,
  segments = 96
): LatLon[] {
  const ring: LatLon[] = [];
  for (let i = 0; i < segments; i++) {
    ring.push(destinationPoint(origin, distanceKm, (i / segments) * 360));
  }
  return ring;
}
