/**
 * Density-based decimation of sensors for display.
 *
 * GeoNet's network is very dense in some regions (Wellington, Canterbury) and
 * sparse elsewhere. Plotting every sensor turns dense regions into an unreadable
 * blob, so we collapse each crowded neighbourhood down to a single
 * *representative* sensor while leaving isolated sensors untouched.
 *
 * The algorithm is a uniform grid in screen (projected) space: sensors are
 * binned into square cells of `cellSize` pixels, and each occupied cell yields
 * one representative. Because it operates on already-projected pixel positions,
 * "density" means visual crowding, which is exactly what we want to relieve.
 *
 * It is pure and deterministic: identical input always yields identical output.
 */

export interface Placed {
  /** Projected x position in pixels. */
  x: number;
  /** Projected y position in pixels. */
  y: number;
}

export interface Cluster<T extends Placed> {
  /** The single sensor chosen to stand in for the whole cell. */
  representative: T;
  /** Every sensor that fell in this cell (includes the representative). */
  members: T[];
  /** Number of sensors the representative stands in for (`members.length`). */
  count: number;
}

export interface DecimateOptions<T extends Placed> {
  /** Grid cell edge length in pixels. Larger cells → more aggressive thinning. */
  cellSize: number;
  /**
   * Optional preference score; higher wins when choosing a representative.
   * Ties fall back to proximity to the cell centre, then to input order. Use
   * this to prefer, say, sensors that actually recorded data.
   */
  priority?: (item: T) => number;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

/**
 * Collapse a set of positioned sensors into one representative per grid cell.
 *
 * @returns One {@link Cluster} per occupied cell, in the order cells were first
 *   encountered (stable for a given input ordering).
 */
export function decimateByGrid<T extends Placed>(
  items: readonly T[],
  options: DecimateOptions<T>
): Array<Cluster<T>> {
  const {cellSize, priority} = options;
  if (!(cellSize > 0)) {
    throw new Error('decimateByGrid: cellSize must be a positive number');
  }

  interface Bucket {
    cx: number;
    cy: number;
    members: T[];
  }
  const buckets = new Map<string, Bucket>();

  for (const item of items) {
    const cx = Math.floor(item.x / cellSize);
    const cy = Math.floor(item.y / cellSize);
    const key = cellKey(cx, cy);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.members.push(item);
    } else {
      buckets.set(key, {cx, cy, members: [item]});
    }
  }

  const score = priority ?? (() => 0);
  const clusters: Array<Cluster<T>> = [];

  for (const bucket of buckets.values()) {
    const centreX = (bucket.cx + 0.5) * cellSize;
    const centreY = (bucket.cy + 0.5) * cellSize;

    let best = bucket.members[0];
    let bestPriority = score(best);
    let bestDist = distSq(best, centreX, centreY);

    for (let i = 1; i < bucket.members.length; i++) {
      const candidate = bucket.members[i];
      const p = score(candidate);
      const d = distSq(candidate, centreX, centreY);
      // Higher priority wins; on a tie, the point nearest the cell centre wins;
      // remaining ties keep the earlier (already-selected) member.
      if (p > bestPriority || (p === bestPriority && d < bestDist)) {
        best = candidate;
        bestPriority = p;
        bestDist = d;
      }
    }

    clusters.push({
      representative: best,
      members: bucket.members,
      count: bucket.members.length,
    });
  }

  return clusters;
}

function distSq(p: Placed, cx: number, cy: number): number {
  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy;
}
