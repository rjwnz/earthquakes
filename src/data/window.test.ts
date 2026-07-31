import {describe, it, expect} from 'vitest';
import {detectShakingWindow} from './window';

/** Build a trace: `quietS`s of small motion, `burstS`s of strong motion, then quiet. */
function burst(
  rate: number,
  quietS: number,
  burstS: number,
  tailS: number
): number[] {
  const s: number[] = [];
  const push = (secs: number, amp: number) => {
    const count = Math.round(secs * rate);
    for (let i = 0; i < count; i++) s.push(amp * (i % 2 === 0 ? 1 : -1));
  };
  push(quietS, 1);
  push(burstS, 100);
  push(tailS, 1);
  return s;
}

describe('detectShakingWindow', () => {
  const rate = 20;

  it('throws on a bad rate', () => {
    expect(() => detectShakingWindow([1, 2], 0, {sampleRateHz: 0})).toThrow();
  });

  it('returns a degenerate window for empty input', () => {
    const w = detectShakingWindow([], 1000, {sampleRateHz: rate});
    expect(w.startMs).toBe(1000);
    expect(w.endMs).toBe(1000);
  });

  it('returns the whole trace when there is no shaking (flat/DC input)', () => {
    const flat = new Array(200).fill(7); // constant → zero energy after de-mean
    const w = detectShakingWindow(flat, 0, {sampleRateHz: rate});
    expect(w.startMs).toBe(0);
    expect(w.endMs).toBeCloseTo(((flat.length - 1) / rate) * 1000, 6);
  });

  it('brackets the strong-motion burst and applies preRoll/tail', () => {
    // 30 s quiet, 40 s burst, 30 s quiet.
    const samples = burst(rate, 30, 40, 30);
    const w = detectShakingWindow(samples, 0, {
      sampleRateHz: rate,
      lowFraction: 0.05,
      highFraction: 0.95,
      preRollS: 5,
      tailS: 5,
      minDurationS: 10,
    });
    // Energy is concentrated in [30, 70] s, so onset/offset land inside it.
    expect(w.onsetMs / 1000).toBeGreaterThan(30);
    expect(w.onsetMs / 1000).toBeLessThan(40);
    expect(w.offsetMs / 1000).toBeGreaterThan(60);
    expect(w.offsetMs / 1000).toBeLessThan(70);
    // Lead-in and tail are applied exactly (well inside the trace bounds).
    expect(w.startMs).toBeCloseTo(w.onsetMs - 5000, 6);
    expect(w.endMs).toBeCloseTo(w.offsetMs + 5000, 6);
  });

  it('keeps the window inside the trace bounds', () => {
    const samples = burst(rate, 2, 40, 2);
    const w = detectShakingWindow(samples, 5000, {
      sampleRateHz: rate,
      preRollS: 30,
      tailS: 30,
    });
    const traceEnd = 5000 + ((samples.length - 1) / rate) * 1000;
    expect(w.startMs).toBeGreaterThanOrEqual(5000);
    expect(w.endMs).toBeLessThanOrEqual(traceEnd);
  });

  it('enforces a minimum duration for a short burst', () => {
    const samples = burst(rate, 20, 2, 20);
    const w = detectShakingWindow(samples, 0, {
      sampleRateHz: rate,
      preRollS: 1,
      tailS: 1,
      minDurationS: 25,
    });
    expect((w.endMs - w.startMs) / 1000).toBeGreaterThanOrEqual(25 - 1e-6);
  });

  it('ends well before the trace end when a long quiet coda follows', () => {
    const samples = burst(rate, 10, 20, 60); // 60 s of quiet after the burst
    const w = detectShakingWindow(samples, 0, {sampleRateHz: rate});
    const traceEnd = ((samples.length - 1) / rate) * 1000;
    expect(w.offsetMs).toBeLessThan(40_000);
    expect(w.endMs).toBeLessThan(traceEnd - 20_000);
  });
});
