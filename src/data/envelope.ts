/**
 * Shaking envelope — a smoothed "how hard is it shaking right now" magnitude.
 *
 * The raw signed trace oscillates through zero many times a second; driving a
 * circle's radius from it makes the circle strobe. Instead we follow the trace's
 * amplitude with a fast-attack / slow-decay peak follower (like an audio VU
 * meter): it jumps up to each peak and eases back down over ~1 s. The result is
 * a smooth, non-negative envelope that swells as the wavefront arrives and fades
 * afterwards — far calmer across a dense network, while the instantaneous sign
 * can still drive the fill.
 *
 * Pure and unit tested.
 */

export interface EnvelopeOptions {
  sampleRateHz: number;
  /** Attack time constant, seconds (small = snaps to peaks). Default 0.04. */
  attackS?: number;
  /** Decay time constant, seconds (large = lingers). Default 1.0. */
  decayS?: number;
}

/**
 * Compute the fast-attack / slow-decay amplitude envelope of a signed trace.
 * Output is non-negative and the same length as `samples`.
 */
export function shakingEnvelope(
  samples: ArrayLike<number>,
  options: EnvelopeOptions
): number[] {
  const {sampleRateHz} = options;
  if (sampleRateHz <= 0) {
    throw new Error('shakingEnvelope: sampleRateHz must be > 0');
  }
  const attackS = options.attackS ?? 0.04;
  const decayS = options.decayS ?? 1.0;
  const attackCoef = Math.exp(-1 / (Math.max(1e-6, attackS) * sampleRateHz));
  const decayCoef = Math.exp(-1 / (Math.max(1e-6, decayS) * sampleRateHz));

  const n = samples.length;
  const out = new Array<number>(n).fill(0);
  let env = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    // One-pole follower toward `a`; a smaller coefficient closes the gap faster.
    const coef = a > env ? attackCoef : decayCoef;
    env = a + (env - a) * coef;
    out[i] = env;
  }
  return out;
}
