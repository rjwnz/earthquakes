/**
 * Network shaking envelope — the aggregate time series drawn in the bottom
 * scrubber strip.
 *
 * For every sample on the common grid we take each recording sensor's absolute
 * amplitude, normalise it by that sensor's own robust scale (so every station
 * contributes on a 0..1 footing, regardless of near/far intensity), and average
 * across the network. The result is a single 0..1 series that rises as the
 * wavefront reaches successive stations and falls as the shaking dies away — a
 * compact overview of the whole event to scrub along.
 *
 * Pure and unit tested.
 */

export interface EnvelopeSensor {
  samples: readonly number[];
  hasData: boolean;
  /** Per-station robust amplitude scale (see {@link robustMaxAbs}). */
  scale: number;
}

/**
 * Compute the network envelope over `sampleCount` grid points.
 *
 * @returns An array of length `sampleCount` with values in `[0, 1]`; all zeros
 *   if no sensor has data.
 */
export function networkEnvelope(
  sensors: readonly EnvelopeSensor[],
  sampleCount: number
): number[] {
  const out = new Array<number>(sampleCount).fill(0);
  const recording = sensors.filter(s => s.hasData && s.samples.length > 0);
  if (recording.length === 0) return out;

  for (let i = 0; i < sampleCount; i++) {
    let sum = 0;
    let n = 0;
    for (const s of recording) {
      if (i >= s.samples.length) continue;
      const scale = s.scale > 0 ? s.scale : 1;
      sum += Math.min(1, Math.abs(s.samples[i]) / scale);
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * Reduce a full-resolution series to `columns` peak values (the max within each
 * column's slice). Used to draw the envelope crisply at the strip's pixel width
 * without plotting thousands of points.
 */
export function peakBins(series: readonly number[], columns: number): number[] {
  if (columns <= 0) return [];
  const out = new Array<number>(columns).fill(0);
  if (series.length === 0) return out;
  for (let c = 0; c < columns; c++) {
    const lo = Math.floor((c / columns) * series.length);
    const hi = Math.max(
      lo + 1,
      Math.floor(((c + 1) / columns) * series.length)
    );
    let peak = 0;
    for (let i = lo; i < hi && i < series.length; i++) {
      if (series[i] > peak) peak = series[i];
    }
    out[c] = peak;
  }
  return out;
}
