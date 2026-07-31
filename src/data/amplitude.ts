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

/**
 * The scale to normalise a station against, with a floor tied to the network.
 *
 * Pure per-station normalisation divides each sensor by its own peak — but a
 * station the waves haven't reached has a "peak" that is only instrument noise,
 * which then blows up to full size. Flooring the scale at `floorFraction` of the
 * network-wide `globalScale` means a station only approaches full amplitude once
 * it actually reaches a meaningful fraction of the strongest shaking; quiet,
 * not-yet-reached stations stay small.
 */
export function perStationScale(
  ownScale: number,
  globalScale: number,
  floorFraction: number
): number {
  return Math.max(ownScale, globalScale * floorFraction);
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
  /** Radius at (and below) the quiet floor, in pixels. */
  minRadius: number;
  /** Radius at (or above) `scale`, in pixels. */
  maxRadius: number;
  /**
   * How many orders of magnitude of amplitude below `scale` still register.
   * The radius is a *logarithmic* function of magnitude, so each 10× change in
   * shaking is an equal step in radius — matching how shaking is perceived
   * (felt intensity scales with the log of ground motion). Amplitudes weaker
   * than `scale / 10^rangeDecades` collapse to `minRadius`. Default 3 (a
   * 1000× dynamic range).
   */
  rangeDecades?: number;
}

/**
 * Map a signed amplitude to a circle radius and fill flag, on a log scale.
 *
 * The radius depends only on the magnitude; the sign only chooses fill. The
 * magnitude is normalised by `scale`, then mapped through `log10` across
 * `rangeDecades` decades so that equal ratios of shaking give equal radius
 * steps — a perceptual (intensity-like) response rather than a raw-amplitude one.
 */
export function amplitudeToCircle(
  amplitude: number,
  options: CircleMapOptions
): CircleStyle {
  const {minRadius, maxRadius} = options;
  const decades =
    options.rangeDecades && options.rangeDecades > 0 ? options.rangeDecades : 3;
  const scale = options.scale > 0 ? options.scale : 1;

  const normalised = Math.min(1, Math.abs(amplitude) / scale);
  // t = 1 at `scale`, 0 at `scale / 10^decades`, log-linear in between.
  let t = 0;
  if (normalised > 0) {
    t = Math.max(0, Math.min(1, (Math.log10(normalised) + decades) / decades));
  }
  const radius = minRadius + (maxRadius - minRadius) * t;

  return {radius, filled: amplitude >= 0};
}
