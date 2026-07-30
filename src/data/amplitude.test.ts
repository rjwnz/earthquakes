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

describe('amplitudeToCircle', () => {
  const opts = {scale: 100, minRadius: 2, maxRadius: 20, gamma: 1};

  it('fills for positive amplitude and outlines for negative', () => {
    expect(amplitudeToCircle(50, opts).filled).toBe(true);
    expect(amplitudeToCircle(-50, opts).filled).toBe(false);
    expect(amplitudeToCircle(0, opts).filled).toBe(true);
  });

  it('radius depends only on magnitude, not sign', () => {
    expect(amplitudeToCircle(50, opts).radius).toBeCloseTo(
      amplitudeToCircle(-50, opts).radius,
      9
    );
  });

  it('maps zero to the minimum and scale to the maximum radius', () => {
    expect(amplitudeToCircle(0, opts).radius).toBeCloseTo(2, 9);
    expect(amplitudeToCircle(100, opts).radius).toBeCloseTo(20, 9);
  });

  it('clamps magnitudes beyond the scale', () => {
    expect(amplitudeToCircle(1000, opts).radius).toBeCloseTo(20, 9);
  });

  it('grows monotonically with magnitude', () => {
    const r1 = amplitudeToCircle(10, opts).radius;
    const r2 = amplitudeToCircle(40, opts).radius;
    const r3 = amplitudeToCircle(80, opts).radius;
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
  });

  it('gamma < 1 lifts small motions above the linear response', () => {
    const linear = amplitudeToCircle(25, {...opts, gamma: 1}).radius;
    const shaped = amplitudeToCircle(25, {...opts, gamma: 0.5}).radius;
    expect(shaped).toBeGreaterThan(linear);
  });

  it('never divides by zero when scale is non-positive', () => {
    const c = amplitudeToCircle(5, {...opts, scale: 0});
    expect(Number.isFinite(c.radius)).toBe(true);
  });
});
