import {describe, it, expect} from 'vitest';
import {
  classifyInputUnits,
  parseChannelResponse,
  differentiate,
  countsToAcceleration,
  roundSignificant,
} from './response';

// A trimmed sample of GeoNet FDSN station "text" (level=channel) output: KHZ has
// a broadband (velocity, loc 10) and an accelerometer (loc 20) on the same site.
const KHZ_TEXT = `#Network | Station | Location | Channel | Latitude | Longitude | Elevation | Depth | Azimuth | Dip | SensorDescription | Scale | ScaleFreq | ScaleUnits | SampleRate | StartTime | EndTime
NZ|KHZ|10|HHZ|-42.415980|173.538970|64.0|0.0|0.0|-90.0|Broadband Seismometer|2516582400.000000|1.000000|m/s|100.000000|2011-02-23T04:05:00|2021-05-27T02:03:00
NZ|KHZ|20|HNZ|-42.415980|173.538970|64.0|0.0|0.0|-90.0|Accelerometer|427336.117780|1.000000|m/s**2|200.000000|2013-01-17T01:00:01|2021-05-27T02:03:00`;

describe('classifyInputUnits', () => {
  it('recognises velocity spellings', () => {
    expect(classifyInputUnits('m/s')).toBe('velocity');
    expect(classifyInputUnits('M/S')).toBe('velocity');
  });

  it('recognises acceleration spellings', () => {
    expect(classifyInputUnits('m/s**2')).toBe('acceleration');
    expect(classifyInputUnits('M/S**2')).toBe('acceleration');
    expect(classifyInputUnits('m/s^2')).toBe('acceleration');
    expect(classifyInputUnits('m/s/s')).toBe('acceleration');
  });

  it('returns null for other quantities', () => {
    expect(classifyInputUnits('pa')).toBeNull();
    expect(classifyInputUnits('')).toBeNull();
  });
});

describe('parseChannelResponse', () => {
  it('reads the broadband velocity channel', () => {
    const r = parseChannelResponse(KHZ_TEXT, 'HHZ', '10');
    expect(r).toEqual({sensitivity: 2516582400, input: 'velocity'});
  });

  it('reads the accelerometer channel', () => {
    const r = parseChannelResponse(KHZ_TEXT, 'HNZ', '20');
    expect(r).toEqual({sensitivity: 427336.11778, input: 'acceleration'});
  });

  it('respects the location code when disambiguating', () => {
    expect(parseChannelResponse(KHZ_TEXT, 'HHZ', '20')).toBeNull();
  });

  it('returns null for an unknown channel', () => {
    expect(parseChannelResponse(KHZ_TEXT, 'BNZ', '')).toBeNull();
  });

  it('prefers the epoch active at a given time', () => {
    const atMs = Date.parse('2016-11-13T11:02:56Z');
    const r = parseChannelResponse(KHZ_TEXT, 'HHZ', '10', atMs);
    expect(r?.sensitivity).toBe(2516582400);
    // A time before the channel opened has no covering epoch → still falls back.
    const early = parseChannelResponse(
      KHZ_TEXT,
      'HHZ',
      '10',
      Date.parse('1990-01-01T00:00:00Z')
    );
    expect(early?.sensitivity).toBe(2516582400);
  });
});

describe('differentiate', () => {
  it('recovers a constant slope', () => {
    // v = 2t sampled at 10 Hz → dv/dt = 2 everywhere.
    const rate = 10;
    const v = Array.from({length: 6}, (_, i) => 2 * (i / rate));
    const a = differentiate(v, rate);
    for (const x of a) expect(x).toBeCloseTo(2, 9);
  });

  it('handles degenerate lengths', () => {
    expect(differentiate([], 10)).toEqual([]);
    expect(differentiate([5], 10)).toEqual([0]);
  });

  it('throws on a non-positive rate', () => {
    expect(() => differentiate([1, 2, 3], 0)).toThrow();
  });
});

describe('countsToAcceleration', () => {
  it('scales acceleration channels by sensitivity only', () => {
    const resp = {sensitivity: 400000, input: 'acceleration' as const};
    // 400000 counts / (400000 counts per m/s²) = 1 m/s².
    expect(countsToAcceleration([400000, 800000], resp, 20)).toEqual([1, 2]);
  });

  it('differentiates velocity channels into acceleration', () => {
    const rate = 10;
    const sensitivity = 1000; // counts per m/s
    // Ground velocity ramp 0,1,2,3 m/s → constant 1 m/s² acceleration.
    const counts = [0, 1000, 2000, 3000];
    const a = countsToAcceleration(
      counts,
      {sensitivity, input: 'velocity'},
      rate
    );
    for (const x of a) expect(x).toBeCloseTo(10, 6); // dv/dt with dt = 0.1 s
  });
});

describe('roundSignificant', () => {
  it('keeps significant figures across magnitudes', () => {
    expect(roundSignificant(0.00123456, 4)).toBeCloseTo(0.001235, 12);
    expect(roundSignificant(12.34567, 4)).toBeCloseTo(12.35, 12);
    expect(roundSignificant(0, 4)).toBe(0);
  });
});
