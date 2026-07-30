/**
 * Amplitude helpers: turning a discrete ground-motion trace into the numbers the
 * renderer needs at an arbitrary playback time, and mapping a signed amplitude
 * to a circle (radius + fill).
 *
 * Rendering convention (from the brief):
 *   - positive amplitude → a *solid* (filled) circle,
 *   - negative amplitude → a *hollow* (outline-only) circle,
 *   - radius grows with the magnitude of the amplitude.
 */

/**
 * Linearly interpolate a trace's amplitude at an arbitrary time.
 *
 * `samples[i]` is the amplitude at `startMs + i * 1000 / sampleRateHz`. Times
 * before the first sample or after the last are treated as rest (0), so a sensor
 * simply doesn't move outside its recorded window.
 */
export function sampleTraceAt(
  samples: readonly number[],
  startMs: number,
  sampleRateHz: number,
  timeMs: number
): number {
  const n = samples.length;
  if (n === 0) return 0;
  if (sampleRateHz <= 0)
    throw new Error('sampleTraceAt: sampleRateHz must be > 0');

  const idx = ((timeMs - startMs) / 1000) * sampleRateHz;
  if (idx <= 0) return idx < 0 ? 0 : samples[0];
  if (idx >= n - 1) return idx > n - 1 ? 0 : samples[n - 1];

  const i0 = Math.floor(idx);
  const frac = idx - i0;
  return samples[i0] * (1 - frac) + samples[i0 + 1] * frac;
}

/**
 * A robust amplitude scale: the given percentile of the absolute sample values.
 *
 * Using (say) the 99.5th percentile rather than the raw maximum stops a single
 * clipped near-field spike from dominating the normalisation and flattening the
 * rest of the network to invisibility. Returns 0 for empty/all-zero input;
 * callers should fall back to a positive default before dividing.
 */
export function robustMaxAbs(
  samples: readonly number[],
  percentile = 0.995
): number {
  if (samples.length === 0) return 0;
  if (percentile <= 0 || percentile > 1) {
    throw new Error('robustMaxAbs: percentile must be in (0, 1]');
  }
  const abs = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) abs[i] = Math.abs(samples[i]);
  abs.sort();
  const rank = Math.min(
    abs.length - 1,
    Math.max(0, Math.round(percentile * (abs.length - 1)))
  );
  return abs[rank];
}

export interface CircleStyle {
  /** Circle radius in pixels. */
  radius: number;
  /** True → solid fill (positive amplitude); false → outline only (negative). */
  filled: boolean;
}

export interface CircleMapOptions {
  /** Amplitude that maps to `maxRadius` (values above are clamped). */
  scale: number;
  /** Radius at zero amplitude, in pixels. */
  minRadius: number;
  /** Radius at (or above) `scale`, in pixels. */
  maxRadius: number;
  /**
   * Perceptual exponent applied to the normalised magnitude. `< 1` lifts small
   * motions so they stay visible; `1` is linear. Default 0.5 (sqrt).
   */
  gamma?: number;
}

/**
 * Map a signed amplitude to a circle radius and fill flag.
 *
 * The radius depends only on the magnitude; the sign only chooses fill. The
 * normalised magnitude is clamped to `[0, 1]` and shaped by `gamma`.
 */
export function amplitudeToCircle(
  amplitude: number,
  options: CircleMapOptions
): CircleStyle {
  const {minRadius, maxRadius} = options;
  const gamma = options.gamma ?? 0.5;
  const scale = options.scale > 0 ? options.scale : 1;

  const normalised = Math.min(1, Math.abs(amplitude) / scale);
  const shaped = Math.pow(normalised, gamma);
  const radius = minRadius + (maxRadius - minRadius) * shaped;

  return {radius, filled: amplitude >= 0};
}
