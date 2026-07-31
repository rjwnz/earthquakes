/**
 * Detect the "interesting" time window of an event from a reference seismogram
 * (the station nearest the epicentre).
 *
 * We use the *significant duration* of the shaking — the standard seismological
 * measure based on Arias intensity (cumulative squared ground motion). The
 * window runs from a short lead-in before the moment a small fraction of the
 * total energy has arrived (major shaking begins) to the moment most of it has
 * (major shaking is over), plus a short tail. This is far more stable across
 * events than a fraction-of-peak threshold, which the long surface-wave coda
 * defeats.
 *
 * Pure and unit tested. The build pipelines use it to crop each event.
 */

export interface ShakingWindow {
  /** Window start (lead-in before onset), epoch ms. */
  startMs: number;
  /** Window end (tail after offset), epoch ms. */
  endMs: number;
  /** Detected onset of major shaking (low energy fraction reached), epoch ms. */
  onsetMs: number;
  /** Detected end of major shaking (high energy fraction reached), epoch ms. */
  offsetMs: number;
}

export interface DetectOptions {
  sampleRateHz: number;
  /** Energy fraction marking the onset of major shaking. Default 0.05. */
  lowFraction?: number;
  /** Energy fraction marking the end of major shaking. Default 0.95. */
  highFraction?: number;
  /** Lead-in kept before onset, seconds. Default 5. */
  preRollS?: number;
  /** Tail kept after offset, seconds. Default 5. */
  tailS?: number;
  /** Minimum window duration, seconds (guards against tiny bursts). Default 20. */
  minDurationS?: number;
}

/**
 * Find the significant-shaking window of a reference trace.
 *
 * @param samples Reference station samples (signed; DC offset need not be removed).
 * @param startMs Epoch time of `samples[0]`.
 */
export function detectShakingWindow(
  samples: ArrayLike<number>,
  startMs: number,
  options: DetectOptions
): ShakingWindow {
  const {sampleRateHz} = options;
  if (sampleRateHz <= 0) {
    throw new Error('detectShakingWindow: sampleRateHz must be > 0');
  }
  const lowFraction = options.lowFraction ?? 0.05;
  const highFraction = options.highFraction ?? 0.95;
  const preRollS = options.preRollS ?? 5;
  const tailS = options.tailS ?? 5;
  const minDurationS = options.minDurationS ?? 20;

  const n = samples.length;
  const idxToMs = (i: number) => startMs + (i / sampleRateHz) * 1000;
  const traceEndMs = idxToMs(Math.max(0, n - 1));
  if (n === 0) {
    return {startMs, endMs: startMs, onsetMs: startMs, offsetMs: startMs};
  }

  // Cumulative Arias-like energy, after removing the DC mean so a baseline
  // offset doesn't dominate the energy of a quiet section.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = samples[i] - mean;
    cum[i + 1] = cum[i] + v * v;
  }
  const total = cum[n];
  if (total <= 0) {
    return {startMs, endMs: traceEndMs, onsetMs: startMs, offsetMs: traceEndMs};
  }

  const lowE = lowFraction * total;
  const highE = highFraction * total;
  let onsetIdx = 0;
  while (onsetIdx < n && cum[onsetIdx + 1] < lowE) onsetIdx++;
  let offsetIdx = onsetIdx;
  while (offsetIdx < n && cum[offsetIdx + 1] < highE) offsetIdx++;

  const onsetMs = idxToMs(onsetIdx);
  const offsetMs = idxToMs(offsetIdx);

  let windowStart = Math.max(startMs, onsetMs - preRollS * 1000);
  let windowEnd = Math.min(traceEndMs, offsetMs + tailS * 1000);

  // Enforce a minimum duration, extending toward the tail first, then the head.
  const minMs = minDurationS * 1000;
  if (windowEnd - windowStart < minMs) {
    windowEnd = Math.min(traceEndMs, windowStart + minMs);
    if (windowEnd - windowStart < minMs) {
      windowStart = Math.max(startMs, windowEnd - minMs);
    }
  }

  return {startMs: windowStart, endMs: windowEnd, onsetMs, offsetMs};
}
