import {describe, it, expect} from 'vitest';
import {
  haversineKm,
  nearestTo,
  destinationPoint,
  wavefrontRing,
  type LatLon,
} from './distance';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm({lat: -41, lon: 174}, {lat: -41, lon: 174})).toBe(0);
  });

  it('measures ~111 km per degree of latitude', () => {
    expect(haversineKm({lat: 0, lon: 0}, {lat: 1, lon: 0})).toBeCloseTo(
      111.19,
      1
    );
  });

  it('is symmetric', () => {
    const a = {lat: -36.85, lon: 174.76}; // Auckland
    const b = {lat: -41.29, lon: 174.78}; // Wellington
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
    expect(haversineKm(a, b)).toBeCloseTo(494, 0);
  });

  it('handles the antimeridian without inflating distance', () => {
    // 179°E and 179°W are 2° apart, not 358°.
    const near = haversineKm({lat: 0, lon: 179}, {lat: 0, lon: -179});
    expect(near).toBeCloseTo(222.4, 0);
  });
});

describe('nearestTo', () => {
  const stations: Array<LatLon & {code: string}> = [
    {code: 'KHZ', lat: -42.41598, lon: 173.53897},
    {code: 'OUZ', lat: -35.219689, lon: 173.596133},
    {code: 'CTZ', lat: -43.73549, lon: -176.61719},
  ];
  const kaikoura = {lat: -42.737, lon: 173.054};

  it('returns null for an empty list', () => {
    expect(nearestTo([], kaikoura)).toBeNull();
  });

  it('finds the closest station to the epicentre', () => {
    expect(nearestTo(stations, kaikoura)?.code).toBe('KHZ');
  });

  it('does not pick the far Chatham station for a mainland target', () => {
    expect(nearestTo(stations, kaikoura)?.code).not.toBe('CTZ');
  });
});

describe('destinationPoint', () => {
  it('returns the origin for zero distance', () => {
    const p = destinationPoint({lat: -41, lon: 174}, 0, 57);
    expect(p.lat).toBeCloseTo(-41, 6);
    expect(p.lon).toBeCloseTo(174, 6);
  });

  it('moves ~1° north per 111 km on a due-north bearing', () => {
    const p = destinationPoint({lat: 0, lon: 0}, 111.19, 0);
    expect(p.lat).toBeCloseTo(1, 2);
    expect(p.lon).toBeCloseTo(0, 6);
  });

  it('lands exactly `distanceKm` away (round-trips through haversine)', () => {
    const origin = {lat: -42.737, lon: 173.054};
    for (const bearing of [0, 45, 90, 200, 315]) {
      const p = destinationPoint(origin, 250, bearing);
      expect(haversineKm(origin, p)).toBeCloseTo(250, 3);
    }
  });
});

describe('wavefrontRing', () => {
  const origin = {lat: -42.737, lon: 173.054};

  it('returns the requested number of points', () => {
    expect(wavefrontRing(origin, 100, 64)).toHaveLength(64);
  });

  it('places every point at the given radius', () => {
    for (const p of wavefrontRing(origin, 300, 48)) {
      expect(haversineKm(origin, p)).toBeCloseTo(300, 2);
    }
  });
});
