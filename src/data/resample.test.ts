import {describe, it, expect} from 'vitest';
import {estimateBaseline, resampleBoxAverage} from './resample';

describe('estimateBaseline', () => {
  // 100 Hz, start 0 → sample i at i*10 ms.
  const samples = Array.from({length: 100}, (_, i) => (i < 50 ? 5 : 100));

  it('averages the samples inside the window', () => {
    // Window [0, 500) ms covers indices 0..49, all value 5.
    expect(estimateBaseline(samples, 0, 100, 0, 500)).toBe(5);
  });

  it('returns 0 for an empty window', () => {
    expect(estimateBaseline(samples, 0, 100, 5000, 6000)).toBe(0);
  });

  it('throws on a bad rate', () => {
    expect(() => estimateBaseline(samples, 0, 0, 0, 100)).toThrow();
  });
});

describe('resampleBoxAverage', () => {
  it('leaves a constant signal unchanged', () => {
    const src = Array.from({length: 100}, () => 7);
    const out = resampleBoxAverage(src, 0, 100, 0, 20, 10);
    expect(out.every(v => Math.abs(v - 7) < 1e-9)).toBe(true);
  });

  it('box-averages when downsampling 100 Hz → 20 Hz', () => {
    // Ramp 0,1,2,...; output step 50 ms spans 5 input samples.
    const src = Array.from({length: 100}, (_, i) => i);
    const out = resampleBoxAverage(src, 0, 100, 0, 20, 5);
    // Output 1 at t=50ms averages indices ~[3,8) = (3+4+5+6+7)/5 = 5.
    expect(out[1]).toBeCloseTo(5, 6);
    // Monotonic increasing for a ramp.
    for (let i = 1; i < out.length; i++)
      expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it('fills steps with no input as zero', () => {
    const src = [1, 1, 1];
    // Grid extends well past the 3-sample source.
    const out = resampleBoxAverage(src, 0, 100, 0, 20, 10);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(out[out.length - 1]).toBe(0);
  });

  it('produces the requested number of samples', () => {
    const src = Array.from({length: 200}, (_, i) => Math.sin(i));
    expect(resampleBoxAverage(src, 0, 100, 0, 25, 40)).toHaveLength(40);
  });

  it('throws on bad rates', () => {
    expect(() => resampleBoxAverage([1], 0, 0, 0, 20, 5)).toThrow();
    expect(() => resampleBoxAverage([1], 0, 100, 0, 0, 5)).toThrow();
  });
});
