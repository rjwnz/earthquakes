/**
 * Helpers for drawing a seismogram trace in the timeline strip.
 *
 * A trace has far more samples than the strip has pixels, so we reduce it to one
 * value per pixel column. To keep the waveform looking like a waveform we keep,
 * for each column, the sample with the largest *absolute* value (sign retained)
 * — peak-preserving decimation, so spikes don't disappear between columns.
 *
 * Pure and unit tested.
 */

/**
 * Reduce a signed series to `columns` values, each the signed extremum (largest
 * magnitude, sign kept) within that column's slice. Empty columns → 0.
 */
export function signedPeakBins(
  series: readonly number[],
  columns: number
): number[] {
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
    let peakMag = -1;
    for (let i = lo; i < hi && i < series.length; i++) {
      const mag = Math.abs(series[i]);
      if (mag > peakMag) {
        peakMag = mag;
        peak = series[i];
      }
    }
    out[c] = peak;
  }
  return out;
}
