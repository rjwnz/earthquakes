/**
 * Ramer–Douglas–Peucker polyline simplification.
 *
 * Used to shrink the Natural Earth coastline to a light, bundle-friendly outline
 * while preserving its recognisable shape. Distances are computed in the raw
 * lon/lat plane, which is fine at a country scale and for a purely cosmetic
 * outline. Pure and deterministic.
 */

export type Pt = [number, number];

/** Perpendicular distance from point `p` to the segment `a`–`b`. */
export function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate segment: distance to the shared endpoint.
    return Math.hypot(px - ax, py - ay);
  }
  // Area of the parallelogram / base length = height.
  const cross = Math.abs(dx * (ay - py) - dy * (ax - px));
  return cross / Math.sqrt(lenSq);
}

/**
 * Simplify a polyline, keeping its endpoints. Points that stay within
 * `tolerance` of the retained line are dropped. Larger tolerance → fewer points.
 */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  if (tolerance <= 0) return points.slice();

  // Find the point farthest from the chord between the endpoints.
  let maxDist = -1;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist <= tolerance) {
    return [first, last];
  }

  // Recurse on both halves, dropping the duplicated split point.
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}
