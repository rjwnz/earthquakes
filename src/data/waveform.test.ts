import {describe, it, expect} from 'vitest';
import {signedPeakBins} from './waveform';

describe('signedPeakBins', () => {
  it('returns empty for non-positive columns', () => {
    expect(signedPeakBins([1, -2, 3], 0)).toEqual([]);
  });

  it('returns zeros for an empty series', () => {
    expect(signedPeakBins([], 3)).toEqual([0, 0, 0]);
  });

  it('keeps the signed extremum of each column', () => {
    // 4 samples into 2 columns → [1,-3] then [2,-1]. Extrema: -3, 2.
    expect(signedPeakBins([1, -3, 2, -1], 2)).toEqual([-3, 2]);
  });

  it('preserves a negative peak over a smaller positive one', () => {
    expect(signedPeakBins([2, -5, 1], 1)).toEqual([-5]);
  });

  it('produces the requested number of columns', () => {
    const series = Array.from({length: 1000}, (_, i) => Math.sin(i / 10));
    expect(signedPeakBins(series, 120)).toHaveLength(120);
  });

  it('retains both polarities of an oscillation', () => {
    const series = [0, 4, 0, -4, 0, 5, 0, -6];
    const bins = signedPeakBins(series, 4);
    expect(bins.some(v => v > 0)).toBe(true);
    expect(bins.some(v => v < 0)).toBe(true);
  });
});
