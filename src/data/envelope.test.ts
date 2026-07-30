import {describe, it, expect} from 'vitest';
import {networkEnvelope, peakBins, type EnvelopeSensor} from './envelope';

describe('networkEnvelope', () => {
  it('returns all zeros when nothing is recording', () => {
    const sensors: EnvelopeSensor[] = [{samples: [], hasData: false, scale: 0}];
    expect(networkEnvelope(sensors, 4)).toEqual([0, 0, 0, 0]);
  });

  it('normalises each sensor by its own scale and averages', () => {
    const sensors: EnvelopeSensor[] = [
      {samples: [0, 5, 10], hasData: true, scale: 10}, // → 0, 0.5, 1
      {samples: [0, 20, 10], hasData: true, scale: 20}, // → 0, 1, 0.5
    ];
    // Mean of the two normalised series.
    expect(networkEnvelope(sensors, 3)).toEqual([0, 0.75, 0.75]);
  });

  it('clamps per-sensor contributions to 1', () => {
    const sensors: EnvelopeSensor[] = [
      {samples: [50], hasData: true, scale: 10}, // 5 → clamped to 1
    ];
    expect(networkEnvelope(sensors, 1)).toEqual([1]);
  });

  it('ignores non-recording sensors in the average', () => {
    const sensors: EnvelopeSensor[] = [
      {samples: [10], hasData: true, scale: 10}, // → 1
      {samples: [], hasData: false, scale: 0}, // ignored
    ];
    expect(networkEnvelope(sensors, 1)).toEqual([1]);
  });

  it('keeps every value within [0, 1]', () => {
    const sensors: EnvelopeSensor[] = [
      {samples: [-30, 15, -7], hasData: true, scale: 10},
    ];
    for (const v of networkEnvelope(sensors, 3)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('peakBins', () => {
  it('returns empty for non-positive columns', () => {
    expect(peakBins([1, 2, 3], 0)).toEqual([]);
  });

  it('takes the peak within each column slice', () => {
    // 8 samples into 4 columns → pairs; peak of each pair.
    expect(peakBins([0, 1, 3, 2, 0.5, 0.1, 9, 4], 4)).toEqual([1, 3, 0.5, 9]);
  });

  it('upsamples by repeating peaks when columns exceed samples', () => {
    const out = peakBins([2, 8], 4);
    expect(out).toHaveLength(4);
    expect(Math.max(...out)).toBe(8);
  });
});
