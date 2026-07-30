import {describe, it, expect} from 'vitest';
import {decimateByGrid, type Placed} from './decimate';

interface Sensor extends Placed {
  code: string;
  hasData?: boolean;
}

describe('decimateByGrid', () => {
  it('throws on a non-positive cell size', () => {
    expect(() => decimateByGrid([], {cellSize: 0})).toThrow();
    expect(() => decimateByGrid([], {cellSize: -5})).toThrow();
  });

  it('returns nothing for no input', () => {
    expect(decimateByGrid([], {cellSize: 10})).toEqual([]);
  });

  it('keeps isolated sensors in separate cells', () => {
    const items: Sensor[] = [
      {code: 'A', x: 5, y: 5},
      {code: 'B', x: 500, y: 500},
    ];
    const clusters = decimateByGrid(items, {cellSize: 50});
    expect(clusters).toHaveLength(2);
    expect(clusters.every(c => c.count === 1)).toBe(true);
  });

  it('collapses a dense cluster to a single representative', () => {
    const items: Sensor[] = [
      {code: 'A', x: 10, y: 10},
      {code: 'B', x: 12, y: 11},
      {code: 'C', x: 14, y: 9},
      {code: 'D', x: 11, y: 13},
    ];
    const clusters = decimateByGrid(items, {cellSize: 100});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(4);
    expect(clusters[0].members).toHaveLength(4);
  });

  it('chooses the member nearest the cell centre by default', () => {
    // Cell is [0,100)x[0,100); centre is (50,50).
    const items: Sensor[] = [
      {code: 'corner', x: 5, y: 5},
      {code: 'centre', x: 49, y: 51},
    ];
    const clusters = decimateByGrid(items, {cellSize: 100});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].representative.code).toBe('centre');
  });

  it('prefers higher-priority members even when farther from centre', () => {
    const items: Sensor[] = [
      {code: 'near-nodata', x: 49, y: 51, hasData: false},
      {code: 'far-hasdata', x: 5, y: 5, hasData: true},
    ];
    const clusters = decimateByGrid(items, {
      cellSize: 100,
      priority: s => (s.hasData ? 1 : 0),
    });
    expect(clusters[0].representative.code).toBe('far-hasdata');
  });

  it('accounts for every input sensor exactly once', () => {
    const items: Sensor[] = Array.from({length: 200}, (_, i) => ({
      code: `S${i}`,
      x: (i % 20) * 3,
      y: Math.floor(i / 20) * 3,
    }));
    const clusters = decimateByGrid(items, {cellSize: 25});
    const total = clusters.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(items.length);
    // Every representative is one of its own members.
    for (const c of clusters) {
      expect(c.members).toContain(c.representative);
    }
  });

  it('is deterministic for identical input', () => {
    const items: Sensor[] = [
      {code: 'A', x: 10, y: 10},
      {code: 'B', x: 12, y: 11},
      {code: 'C', x: 400, y: 30},
    ];
    const a = decimateByGrid(items, {cellSize: 50});
    const b = decimateByGrid(items, {cellSize: 50});
    expect(a).toEqual(b);
  });

  it('thins more aggressively as cell size grows', () => {
    const items: Sensor[] = Array.from({length: 100}, (_, i) => ({
      code: `S${i}`,
      x: (i % 10) * 10,
      y: Math.floor(i / 10) * 10,
    }));
    const fine = decimateByGrid(items, {cellSize: 10});
    const coarse = decimateByGrid(items, {cellSize: 40});
    expect(coarse.length).toBeLessThan(fine.length);
  });
});
