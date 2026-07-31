import {describe, it, expect} from 'vitest';
import {haversineKm, nearestTo, type LatLon} from './distance';

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
