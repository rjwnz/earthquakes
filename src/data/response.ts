/**
 * Instrument-response correction: turn raw digitiser counts into ground
 * acceleration in SI units (m/s²), so amplitudes are comparable *between*
 * stations rather than reflecting each sensor's private gain.
 *
 * Raw miniSEED is always counts, and GeoNet's network mixes two sensor types
 * that measure different physical quantities:
 *   - broadband seismometers (HHZ) record ground *velocity*     (counts per m/s),
 *   - strong-motion accelerometers (HNZ, BNZ) record *acceleration* (counts per m/s²).
 * A "count" therefore means something different at every site. Dividing by the
 * channel's overall sensitivity (the single gain published in the station
 * metadata) recovers physical units; differentiating a velocity trace then
 * brings everything onto a common acceleration scale.
 *
 * This is a *sensitivity* (flat-response) correction, not a full pole–zero
 * deconvolution. Across each instrument's passband — which is where the shaking
 * energy lives — the sensitivity is flat, so this removes essentially all of the
 * cross-station gain/units bias while staying simple, dependency-free, and
 * unit-testable. It is not a substitute for full response removal near an
 * instrument's corner frequencies.
 */

/** The physical quantity a channel records before correction. */
export type GroundMotionInput = 'velocity' | 'acceleration';

/** The bits of a channel's response needed for a sensitivity correction. */
export interface ChannelResponse {
  /** Overall sensitivity: counts per SI input unit (per m/s or per m/s²). */
  sensitivity: number;
  /** What the sensor measures (decides whether we differentiate). */
  input: GroundMotionInput;
}

/**
 * Classify an FDSN `ScaleUnits` / `InputUnits` string as velocity or
 * acceleration. Accepts the common spellings (`m/s`, `M/S**2`, `m/s^2`, …);
 * returns null for anything unrecognised (e.g. pressure, strain).
 */
export function classifyInputUnits(units: string): GroundMotionInput | null {
  const u = units.trim().toLowerCase();
  if (/m\/s\s*(\*\*2|\^2|2|\/s)\b/.test(u) || /m\/s\/s/.test(u)) {
    return 'acceleration';
  }
  if (/\bm\/s\b/.test(u) || u === 'm/s') return 'velocity';
  return null;
}

/**
 * Parse GeoNet/FDSN station "text" output (level=channel) and return the
 * response for one channel. The columns are pipe-delimited:
 *
 *   Net|Sta|Loc|Cha|Lat|Lon|Elev|Depth|Az|Dip|SensorDesc|Scale|ScaleFreq|ScaleUnits|SampleRate|Start|End
 *
 * `Scale` is the overall sensitivity and `ScaleUnits` its input units. When
 * `atMs` is given, the epoch whose [Start, End] contains it is preferred (a site
 * can re-instrument mid-life); otherwise the first matching row wins.
 */
export function parseChannelResponse(
  text: string,
  channel: string,
  location: string,
  atMs?: number
): ChannelResponse | null {
  let fallback: ChannelResponse | null = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length < 14) continue;
    if (f[3] !== channel) continue;
    // Match the location code when we know it (empty = accept any).
    if (location && f[2] !== location) continue;

    const sensitivity = Number(f[11]);
    if (!Number.isFinite(sensitivity) || sensitivity === 0) continue;
    const input = classifyInputUnits(f[13]);
    if (!input) continue;
    const resp: ChannelResponse = {sensitivity, input};

    if (atMs === undefined) return resp;
    // Prefer the epoch covering `atMs`; keep the first row as a fallback.
    const start = Date.parse(f[15]);
    const end = f[16] ? Date.parse(f[16]) : Number.POSITIVE_INFINITY;
    if (
      (!Number.isFinite(start) || start <= atMs) &&
      (!Number.isFinite(end) || atMs <= end)
    ) {
      return resp;
    }
    fallback ??= resp;
  }
  return fallback;
}

/**
 * Discrete time-derivative of a uniformly-sampled series (central differences
 * inside, one-sided at the ends). Used to turn velocity into acceleration.
 */
export function differentiate(
  series: readonly number[],
  sampleRateHz: number
): number[] {
  if (sampleRateHz <= 0) {
    throw new Error('differentiate: sampleRateHz must be > 0');
  }
  const n = series.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const dt = 1 / sampleRateHz;
  const out = new Array<number>(n);
  out[0] = (series[1] - series[0]) / dt;
  out[n - 1] = (series[n - 1] - series[n - 2]) / dt;
  for (let i = 1; i < n - 1; i++) {
    out[i] = (series[i + 1] - series[i - 1]) / (2 * dt);
  }
  return out;
}

/**
 * Convert raw counts to ground acceleration in m/s² using a channel's overall
 * sensitivity. Velocity channels are differentiated; acceleration channels are
 * already in the right quantity once scaled.
 */
export function countsToAcceleration(
  counts: readonly number[],
  response: ChannelResponse,
  sampleRateHz: number
): number[] {
  const physical = counts.map(c => c / response.sensitivity);
  return response.input === 'velocity'
    ? differentiate(physical, sampleRateHz)
    : physical;
}

/**
 * Round to a fixed number of significant figures. Keeps the corrected SI floats
 * compact in the bundled JSON without discarding the small far-field values a
 * fixed number of decimal places would flatten to zero.
 */
export function roundSignificant(x: number, sigFigs = 4): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  const digits = Math.ceil(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, sigFigs - digits);
  return Math.round(x * factor) / factor;
}
