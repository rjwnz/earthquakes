/**
 * Map projection for Aotearoa New Zealand, including the Chatham Islands.
 *
 * The Chathams sit just east of the 180° antimeridian (longitude ≈ -176.6°),
 * so on a naive plate-carrée they would fly off to the far west of the map.
 * We wrap longitudes into a continuous `[0, 360)` band before projecting, which
 * places the Chathams immediately east of the North Island where they belong.
 *
 * The projection itself is an equirectangular (plate-carrée) projection with a
 * cosine(latitude) correction on the horizontal axis so that the country keeps
 * a natural aspect ratio at ~41°S. This is intentionally simple and, crucially,
 * pure and deterministic — which is what makes it straightforward to unit test.
 */

export interface LngLat {
  lat: number;
  lon: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Geographic bounding box. Longitudes are already wrapped (see {@link wrapLongitude}). */
export interface GeoBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface ProjectionOptions {
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** Uniform padding in pixels kept clear around the content. */
  padding: number;
}

export interface Projector {
  project(p: LngLat): Point;
  /** Pixels per corrected-degree; identical on both axes (aspect preserved). */
  readonly scale: number;
  readonly bounds: GeoBounds;
  readonly options: ProjectionOptions;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Wrap a longitude into the continuous band used for New Zealand so that points
 * east of the antimeridian (the Chathams) stay adjacent to the mainland.
 *
 * Concretely: longitudes in `[-180, 0)` are mapped to `[180, 360)`. Mainland NZ
 * (≈166°..179°E) is unchanged; the Chathams (≈-176.6°) become ≈183.4°.
 */
export function wrapLongitude(lon: number): number {
  let wrapped = lon % 360;
  if (wrapped < 0) wrapped += 360;
  // NZ spans ~166°E..184°E once wrapped; anything below ~150 is the negative
  // side of the antimeridian that we lifted into the 180..360 band above.
  return wrapped;
}

/**
 * Compute the bounding box of a set of points, wrapping longitudes first. Throws
 * on an empty input because a projection has no meaning without extent.
 */
export function computeBounds(points: readonly LngLat[]): GeoBounds {
  if (points.length === 0) {
    throw new Error('computeBounds: at least one point is required');
  }
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    const lon = wrapLongitude(p.lon);
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return {minLon, maxLon, minLat, maxLat};
}

/** Expand a bounding box outward by a fractional margin on each side. */
export function padBounds(bounds: GeoBounds, fraction: number): GeoBounds {
  const lonSpan = bounds.maxLon - bounds.minLon || 1;
  const latSpan = bounds.maxLat - bounds.minLat || 1;
  const dLon = lonSpan * fraction;
  const dLat = latSpan * fraction;
  return {
    minLon: bounds.minLon - dLon,
    maxLon: bounds.maxLon + dLon,
    minLat: bounds.minLat - dLat,
    maxLat: bounds.maxLat + dLat,
  };
}

/**
 * Build a projector that fits `bounds` into the given pixel box, preserving
 * aspect ratio and centring the content within the padded area. North is up.
 */
export function createProjector(
  bounds: GeoBounds,
  options: ProjectionOptions
): Projector {
  const {width, height, padding} = options;
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.cos(midLat * DEG_TO_RAD);

  // Extent in "corrected degrees": horizontal degrees are shrunk by cos(lat).
  const geoWidth = (bounds.maxLon - bounds.minLon) * cosLat || 1e-9;
  const geoHeight = bounds.maxLat - bounds.minLat || 1e-9;

  const availW = Math.max(1, width - 2 * padding);
  const availH = Math.max(1, height - 2 * padding);

  const scale = Math.min(availW / geoWidth, availH / geoHeight);

  const contentW = geoWidth * scale;
  const contentH = geoHeight * scale;
  const offsetX = padding + (availW - contentW) / 2;
  const offsetY = padding + (availH - contentH) / 2;

  const project = (p: LngLat): Point => {
    const lon = wrapLongitude(p.lon);
    const x = offsetX + (lon - bounds.minLon) * cosLat * scale;
    // Latitude increases northward, but screen y increases downward, so invert.
    const y = offsetY + (bounds.maxLat - p.lat) * scale;
    return {x, y};
  };

  return {project, scale, bounds, options};
}
