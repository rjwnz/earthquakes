/**
 * Resampling a raw waveform onto the dataset's common playback grid.
 *
 * Seismometers here run at 100–200 Hz; the app animates at ~20 Hz. Naive point
 * sampling would alias high-frequency energy into visible jitter, so we average
 * each output step's worth of input samples — a cheap box-filter anti-alias —
 * and separately remove the pre-event DC baseline so a resting sensor sits at
 * zero. Both helpers are pure and unit tested; both builders (the checked-in
 * sample and the AWS pipeline) share them.
 */

/** Mean of the samples whose times fall in `[winStartMs, winEndMs)`; 0 if none. */
export function estimateBaseline(
  samples: ArrayLike<number>,
  srcStartMs: number,
  srcRateHz: number,
  winStartMs: number,
  winEndMs: number
): number {
  if (srcRateHz <= 0)
    throw new Error('estimateBaseline: srcRateHz must be > 0');
  const srcStepMs = 1000 / srcRateHz;
  const lo = Math.max(0, Math.ceil((winStartMs - srcStartMs) / srcStepMs));
  const hi = Math.min(
    samples.length,
    Math.floor((winEndMs - srcStartMs) / srcStepMs)
  );
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += samples[i];
  return sum / (hi - lo);
}

/**
 * Box-average resample onto a regular grid of `count` samples starting at
 * `gridStartMs`, spaced at `1000 / gridRateHz`. Each output value is the mean of
 * the input samples within ±½ step of the output time; steps with no overlapping
 * input become 0 (the sensor is at rest / has no data there).
 */
export function resampleBoxAverage(
  samples: ArrayLike<number>,
  srcStartMs: number,
  srcRateHz: number,
  gridStartMs: number,
  gridRateHz: number,
  count: number
): number[] {
  if (srcRateHz <= 0)
    throw new Error('resampleBoxAverage: srcRateHz must be > 0');
  if (gridRateHz <= 0)
    throw new Error('resampleBoxAverage: gridRateHz must be > 0');

  const srcStepMs = 1000 / srcRateHz;
  const gridStepMs = 1000 / gridRateHz;
  const half = gridStepMs / 2;
  const timeToIndex = (ms: number) => (ms - srcStartMs) / srcStepMs;

  const out = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const t = gridStartMs + i * gridStepMs;
    const lo = Math.round(timeToIndex(t - half));
    const hi = Math.round(timeToIndex(t + half));
    let sum = 0;
    let n = 0;
    for (let j = lo; j < hi; j++) {
      if (j >= 0 && j < samples.length) {
        sum += samples[j];
        n++;
      }
    }
    if (n > 0) out[i] = sum / n;
  }
  return out;
}
