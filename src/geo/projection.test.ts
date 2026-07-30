import {describe, it, expect} from 'vitest';
import {
  wrapLongitude,
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
} from './projection';

// A few real GeoNet sites used as fixtures.
const KHZ: LngLat = {lat: -42.41598, lon: 173.53897}; // Kahutara (mainland)
const CTZ: LngLat = {lat: -43.73549, lon: -176.61719}; // Chatham Island
const OUZ: LngLat = {lat: -35.219689, lon: 173.596133}; // Omahuta (far north)
const ODZ: LngLat = {lat: -45.043982, lon: 170.644622}; // Otahua Downs (deep south)

describe('wrapLongitude', () => {
  it('leaves mainland NZ longitudes unchanged', () => {
    expect(wrapLongitude(166.5)).toBeCloseTo(166.5, 9);
    expect(wrapLongitude(178.9)).toBeCloseTo(178.9, 9);
  });

  it('lifts Chatham Islands east of the mainland', () => {
    // -176.61719 should wrap to ~183.38, which is greater than any mainland lon.
    expect(wrapLongitude(CTZ.lon)).toBeCloseTo(183.38281, 4);
    expect(wrapLongitude(CTZ.lon)).toBeGreaterThan(wrapLongitude(178.9));
  });

  it('maps the antimeridian consistently', () => {
    expect(wrapLongitude(-180)).toBeCloseTo(180, 9);
    expect(wrapLongitude(180)).toBeCloseTo(180, 9);
    expect(wrapLongitude(0)).toBeCloseTo(0, 9);
    expect(wrapLongitude(360)).toBeCloseTo(0, 9);
  });
});

describe('computeBounds', () => {
  it('throws on empty input', () => {
    expect(() => computeBounds([])).toThrow();
  });

  it('produces a box that spans mainland through the Chathams', () => {
    const b = computeBounds([OUZ, ODZ, KHZ, CTZ]);
    // North of the far-north site, south of the deep-south site.
    expect(b.maxLat).toBeCloseTo(OUZ.lat, 5);
    expect(b.minLat).toBeCloseTo(ODZ.lat, 5);
    // Chatham defines the eastern edge after wrapping.
    expect(b.maxLon).toBeCloseTo(wrapLongitude(CTZ.lon), 5);
    expect(b.minLon).toBeLessThan(b.maxLon);
  });
});

describe('padBounds', () => {
  it('expands symmetrically by the given fraction', () => {
    const b = {minLon: 100, maxLon: 200, minLat: -50, maxLat: -40};
    const p = padBounds(b, 0.1);
    expect(p.minLon).toBeCloseTo(90, 9);
    expect(p.maxLon).toBeCloseTo(210, 9);
    expect(p.minLat).toBeCloseTo(-51, 9);
    expect(p.maxLat).toBeCloseTo(-39, 9);
  });
});

describe('createProjector', () => {
  const points = [OUZ, ODZ, KHZ, CTZ];
  const bounds = computeBounds(points);
  const opts = {width: 800, height: 1000, padding: 40};
  const proj = createProjector(bounds, opts);

  it('keeps every input point inside the padded canvas', () => {
    for (const p of points) {
      const {x, y} = proj.project(p);
      expect(x).toBeGreaterThanOrEqual(opts.padding - 1e-6);
      expect(x).toBeLessThanOrEqual(opts.width - opts.padding + 1e-6);
      expect(y).toBeGreaterThanOrEqual(opts.padding - 1e-6);
      expect(y).toBeLessThanOrEqual(opts.height - opts.padding + 1e-6);
    }
  });

  it('places Chatham east (greater x) of a same-latitude mainland point', () => {
    const chat = proj.project(CTZ);
    const mainlandSameLat = proj.project({lat: CTZ.lat, lon: 172});
    expect(chat.x).toBeGreaterThan(mainlandSameLat.x);
  });

  it('places northern points above (smaller y) southern points', () => {
    expect(proj.project(OUZ).y).toBeLessThan(proj.project(ODZ).y);
  });

  it('is deterministic', () => {
    expect(proj.project(KHZ)).toEqual(proj.project(KHZ));
  });

  it('preserves aspect: equal geographic deltas scale equally on both axes', () => {
    // One corrected-degree east and one degree north should map to the same
    // pixel distance, because scale is shared across axes.
    const origin = proj.project({lat: -41, lon: 174});
    const north = proj.project({lat: -40, lon: 174});
    const cosLat = Math.cos(((bounds.minLat + bounds.maxLat) / 2) * (Math.PI / 180));
    const east = proj.project({lat: -41, lon: 174 + 1 / cosLat});
    const dyNorth = Math.abs(north.y - origin.y);
    const dxEast = Math.abs(east.x - origin.x);
    expect(dxEast).toBeCloseTo(dyNorth, 6);
  });
});
