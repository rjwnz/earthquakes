import {describe, it, expect} from 'vitest';
import {perpendicularDistance, simplify, type Pt} from './simplify';

describe('perpendicularDistance', () => {
  it('measures height above a horizontal segment', () => {
    expect(perpendicularDistance([1, 2], [0, 0], [2, 0])).toBeCloseTo(2, 9);
  });

  it('is zero for a collinear point', () => {
    expect(perpendicularDistance([1, 1], [0, 0], [2, 2])).toBeCloseTo(0, 9);
  });

  it('falls back to point distance for a degenerate segment', () => {
    expect(perpendicularDistance([3, 4], [0, 0], [0, 0])).toBeCloseTo(5, 9);
  });
});

describe('simplify', () => {
  it('returns short lines unchanged', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 1],
    ];
    expect(simplify(pts, 0.5)).toEqual(pts);
  });

  it('drops nearly-collinear interior points', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 0.01],
      [2, -0.01],
      [3, 0],
    ];
    expect(simplify(pts, 0.1)).toEqual([
      [0, 0],
      [3, 0],
    ]);
  });

  it('keeps a point that deviates beyond the tolerance', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 5],
      [2, 0],
    ];
    const out = simplify(pts, 1);
    expect(out).toContainEqual([1, 5]);
    expect(out).toHaveLength(3);
  });

  it('always retains both endpoints', () => {
    const pts: Pt[] = Array.from({length: 50}, (_, i) => [i, Math.sin(i)] as Pt);
    const out = simplify(pts, 2);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out.length).toBeLessThan(pts.length);
  });

  it('reduces more aggressively with a larger tolerance', () => {
    const pts: Pt[] = Array.from({length: 100}, (_, i) => [i, Math.sin(i / 3)] as Pt);
    const gentle = simplify(pts, 0.1);
    const harsh = simplify(pts, 1);
    expect(harsh.length).toBeLessThanOrEqual(gentle.length);
  });
});
