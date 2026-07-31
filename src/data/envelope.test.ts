import {describe, it, expect} from 'vitest';
import {shakingEnvelope} from './envelope';

describe('shakingEnvelope', () => {
  const rate = 20;

  it('throws on a bad rate', () => {
    expect(() => shakingEnvelope([1, 2], {sampleRateHz: 0})).toThrow();
  });

  it('matches the input length and stays non-negative', () => {
    const out = shakingEnvelope([1, -5, 3, -2], {sampleRateHz: rate});
    expect(out).toHaveLength(4);
    expect(out.every(v => v >= 0)).toBe(true);
  });

  it('holds near the peak during a constant-amplitude oscillation', () => {
    // ±100 every sample → |x| = 100 throughout, so the envelope sits at 100.
    const samples = Array.from({length: 100}, (_, i) => (i % 2 ? -100 : 100));
    const out = shakingEnvelope(samples, {sampleRateHz: rate});
    expect(out[out.length - 1]).toBeCloseTo(100, 3);
    // It does not oscillate: late samples are all essentially equal.
    expect(
      Math.max(...out.slice(50)) - Math.min(...out.slice(50))
    ).toBeLessThan(1);
  });

  it('attacks quickly and decays slowly', () => {
    // One big sample, then silence.
    const samples = [0, 0, 500, 0, 0, 0, 0, 0, 0, 0];
    const out = shakingEnvelope(samples, {
      sampleRateHz: rate,
      attackS: 0.02,
      decayS: 1.0,
    });
    // Snaps up on the spike…
    expect(out[2]).toBeGreaterThan(400);
    // …then decays, but is still well above zero a few samples later.
    expect(out[6]).toBeLessThan(out[2]);
    expect(out[6]).toBeGreaterThan(out[2] * 0.5);
  });

  it('decays toward zero once shaking stops', () => {
    const shaking = Array.from({length: 40}, (_, i) => (i % 2 ? -80 : 80));
    const quiet = new Array(200).fill(0);
    const out = shakingEnvelope([...shaking, ...quiet], {sampleRateHz: rate});
    expect(out[39]).toBeCloseTo(80, 2);
    expect(out[out.length - 1]).toBeLessThan(1);
  });
});
