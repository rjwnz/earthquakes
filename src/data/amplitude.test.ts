import {describe, it, expect} from 'vitest';
import {sampleTraceAt, robustMaxAbs, amplitudeToCircle} from './amplitude';

describe('sampleTraceAt', () => {
  // samples at t = 1000, 1100, 1200 ms  (10 Hz, start 1000)
  const samples = [0, 10, 20];
  const start = 1000;
  const rate = 10;

  it('returns 0 for an empty trace', () => {
    expect(sampleTraceAt([], start, rate, 1050)).toBe(0);
  });

  it('hits exact sample times exactly', () => {
    expect(sampleTraceAt(samples, start, rate, 1000)).toBe(0);
    expect(sampleTraceAt(samples, start, rate, 1100)).toBe(10);
    expect(sampleTraceAt(samples, start, rate, 1200)).toBe(20);
  });

  it('linearly interpolates between samples', () => {
    expect(sampleTraceAt(samples, start, rate, 1050)).toBeCloseTo(5, 9);
    expect(sampleTraceAt(samples, start, rate, 1150)).toBeCloseTo(15, 9);
    expect(sampleTraceAt(samples, start, rate, 1175)).toBeCloseTo(17.5, 9);
  });

  it('treats times outside the window as rest (0)', () => {
    expect(sampleTraceAt(samples, start, rate, 900)).toBe(0);
    expect(sampleTraceAt(samples, start, rate, 1300)).toBe(0);
  });

  it('throws on a non-positive sample rate', () => {
    expect(() => sampleTraceAt(samples, start, 0, 1000)).toThrow();
  });
});

describe('robustMaxAbs', () => {
  it('returns 0 for empty input', () => {
    expect(robustMaxAbs([])).toBe(0);
  });

  it('equals the max for the 100th percentile', () => {
    expect(robustMaxAbs([-3, 1, 2, -5, 4], 1)).toBe(5);
  });

  it('ignores a lone extreme outlier at a lower percentile', () => {
    // 99 values of magnitude 1, one spike of 1000. A ~95th percentile should
    // land on 1, not the spike.
    const data = Array.from({length: 99}, () => 1);
    data.push(1000);
    expect(robustMaxAbs(data, 0.95)).toBe(1);
    expect(robustMaxAbs(data, 1)).toBe(1000);
  });

  it('uses absolute values', () => {
    expect(robustMaxAbs([-7, -7, -7], 1)).toBe(7);
  });

  it('rejects out-of-range percentiles', () => {
    expect(() => robustMaxAbs([1, 2], 0)).toThrow();
    expect(() => robustMaxAbs([1, 2], 1.5)).toThrow();
  });
});

describe('amplitudeToCircle (log scale)', () => {
  // scale 1000, 3 decades → floor at 1 (1000 / 10^3).
  const opts = {scale: 1000, minRadius: 2, maxRadius: 20, rangeDecades: 3};
  const span = opts.maxRadius - opts.minRadius;

  it('fills for positive amplitude and outlines for negative', () => {
    expect(amplitudeToCircle(50, opts).filled).toBe(true);
    expect(amplitudeToCircle(-50, opts).filled).toBe(false);
    expect(amplitudeToCircle(0, opts).filled).toBe(true);
  });

  it('radius depends only on magnitude, not sign', () => {
    expect(amplitudeToCircle(500, opts).radius).toBeCloseTo(
      amplitudeToCircle(-500, opts).radius,
      9
    );
  });

  it('maps `scale` to the maximum radius', () => {
    expect(amplitudeToCircle(1000, opts).radius).toBeCloseTo(20, 9);
  });

  it('collapses amplitudes at/below the floor to the minimum radius', () => {
    expect(amplitudeToCircle(0, opts).radius).toBeCloseTo(2, 9); // zero
    expect(amplitudeToCircle(1, opts).radius).toBeCloseTo(2, 9); // scale/10^3
    expect(amplitudeToCircle(0.1, opts).radius).toBeCloseTo(2, 9); // below floor
  });

  it('places each decade at an equal radius step (log-linear)', () => {
    // scale/10 → 2/3, scale/100 → 1/3 of the radius span above the floor.
    expect(amplitudeToCircle(100, opts).radius).toBeCloseTo(
      2 + (2 / 3) * span,
      9
    );
    expect(amplitudeToCircle(10, opts).radius).toBeCloseTo(
      2 + (1 / 3) * span,
      9
    );
    // Equal steps: r(1000) - r(100) === r(100) - r(10).
    const rTop = amplitudeToCircle(1000, opts).radius;
    const rMid = amplitudeToCircle(100, opts).radius;
    const rLow = amplitudeToCircle(10, opts).radius;
    expect(rTop - rMid).toBeCloseTo(rMid - rLow, 9);
  });

  it('clamps magnitudes beyond the scale', () => {
    expect(amplitudeToCircle(100000, opts).radius).toBeCloseTo(20, 9);
  });

  it('grows monotonically with magnitude', () => {
    const r1 = amplitudeToCircle(10, opts).radius;
    const r2 = amplitudeToCircle(100, opts).radius;
    const r3 = amplitudeToCircle(800, opts).radius;
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
  });

  it('respects a custom dynamic range', () => {
    // With 2 decades, scale/10 is halfway (1/2), not 2/3.
    const narrow = {...opts, rangeDecades: 2};
    expect(amplitudeToCircle(100, narrow).radius).toBeCloseTo(
      2 + 0.5 * span,
      9
    );
  });

  it('never divides by zero when scale is non-positive', () => {
    const c = amplitudeToCircle(5, {...opts, scale: 0});
    expect(Number.isFinite(c.radius)).toBe(true);
  });
});
