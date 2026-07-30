import {describe, it, expect} from 'vitest';
import {
  advancePlayhead,
  clampSpeed,
  PlaybackClock,
  MIN_SPEED,
  MAX_SPEED,
} from './clock';

describe('advancePlayhead', () => {
  it('moves forward scaled by speed', () => {
    // 100 ms of wall time at 0.05× → 5 ms of event time.
    const u = advancePlayhead(0, 100, 0.05, 1000, true);
    expect(u.positionMs).toBeCloseTo(5, 9);
    expect(u.playing).toBe(true);
  });

  it('advances at real time when speed is 1', () => {
    expect(advancePlayhead(200, 300, 1, 1000, false).positionMs).toBe(500);
  });

  it('clamps and stops at the end when not looping', () => {
    const u = advancePlayhead(950, 100, 1, 1000, false);
    expect(u.positionMs).toBe(1000);
    expect(u.playing).toBe(false);
  });

  it('wraps around when looping', () => {
    const u = advancePlayhead(950, 100, 1, 1000, true);
    expect(u.positionMs).toBeCloseTo(50, 9); // 1050 mod 1000
    expect(u.playing).toBe(true);
  });

  it('wraps multiple times for a large step', () => {
    const u = advancePlayhead(0, 2500, 1, 1000, true);
    expect(u.positionMs).toBeCloseTo(500, 9);
    expect(u.playing).toBe(true);
  });

  it('handles a zero-length window safely', () => {
    const u = advancePlayhead(0, 100, 1, 0, true);
    expect(u.positionMs).toBe(0);
    expect(u.playing).toBe(false);
  });
});

describe('clampSpeed', () => {
  it('keeps values inside the supported range', () => {
    expect(clampSpeed(0.5)).toBe(0.5);
    expect(clampSpeed(0.01)).toBe(MIN_SPEED);
    expect(clampSpeed(10)).toBe(MAX_SPEED);
  });
});

describe('PlaybackClock', () => {
  /** A manually driven scheduler + clock so we can step frames deterministically. */
  function makeHarness(durationMs: number) {
    let nowMs = 0;
    let pending: (() => void) | null = null;
    const clock = new PlaybackClock(
      durationMs,
      () => nowMs,
      cb => {
        pending = cb;
        return 1;
      },
      () => {
        pending = null;
      }
    );
    const frame = (advanceMs: number) => {
      nowMs += advanceMs;
      const cb = pending;
      pending = null;
      cb?.();
    };
    return {clock, frame};
  }

  it('accumulates event time across frames at the set speed', () => {
    const {clock, frame} = makeHarness(1000);
    clock.setSpeed(0.05);
    clock.setLoop(true);
    clock.play();
    frame(0); // first frame only establishes the timestamp baseline
    frame(1000); // 1000 ms wall → 50 ms event at 0.05×
    expect(clock.positionMs).toBeCloseTo(50, 6);
    expect(clock.isPlaying).toBe(true);
  });

  it('stops at the end when looping is off', () => {
    const {clock, frame} = makeHarness(100);
    clock.setSpeed(1);
    clock.setLoop(false);
    clock.play();
    frame(0);
    frame(1000);
    expect(clock.positionMs).toBe(100);
    expect(clock.isPlaying).toBe(false);
  });

  it('seek clamps within the window and notifies listeners', () => {
    const {clock} = makeHarness(100);
    const seen: number[] = [];
    clock.onTick(pos => seen.push(pos));
    clock.seek(250);
    expect(clock.positionMs).toBe(100);
    clock.seek(-10);
    expect(clock.positionMs).toBe(0);
    expect(seen).toEqual([100, 0]);
  });

  it('restarts from the beginning when played after a non-looping finish', () => {
    const {clock, frame} = makeHarness(100);
    clock.setSpeed(1);
    clock.setLoop(false);
    clock.play();
    frame(0);
    frame(1000);
    expect(clock.positionMs).toBe(100);
    clock.play(); // parked at the end → should rewind
    expect(clock.positionMs).toBe(0);
  });
});
