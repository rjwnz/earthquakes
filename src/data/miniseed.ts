/**
 * A focused miniSEED reader.
 *
 * miniSEED is the binary format GeoNet (and the wider FDSN world) ships raw
 * seismic waveforms in. A file is a sequence of fixed-length *data records*,
 * each with a 48-byte fixed header, some blockettes, and a compressed data
 * payload. This module decodes the fields we need and the two compression
 * schemes GeoNet actually uses — Steim-1 and Steim-2 — plus the uncompressed
 * integer/float encodings, and nothing else.
 *
 * It is deliberately dependency-free and pure: bytes in, samples out. The Steim
 * codecs carry their own integrity constants (the first and last samples are
 * stored explicitly), which we optionally verify — a strong self-check that the
 * unit tests lean on.
 *
 * References: SEED Manual v2.4 §8 (fixed header, blockette 1000) and Appendix B
 * (Steim-1 / Steim-2 compression).
 */

/** SEED data encoding formats we support (from blockette 1000). */
export const Encoding = {
  INT16: 1,
  INT32: 3,
  FLOAT32: 4,
  FLOAT64: 5,
  STEIM1: 10,
  STEIM2: 11,
} as const;

export interface MiniseedRecord {
  network: string;
  station: string;
  location: string;
  channel: string;
  /** Record start time, epoch milliseconds (UTC). */
  startTimeMs: number;
  sampleRateHz: number;
  numSamples: number;
  encoding: number;
  /** Decoded samples (length === numSamples). */
  samples: Float64Array;
}

export interface ParseOptions {
  /**
   * If true (default), verify each Steim record's built-in first/last-sample
   * integrity constants and throw on mismatch. Set false to be lenient.
   */
  validateSteim?: boolean;
}

/** A contiguous waveform for one channel, built by joining adjacent records. */
export interface Trace {
  network: string;
  station: string;
  location: string;
  channel: string;
  startTimeMs: number;
  sampleRateHz: number;
  samples: Float64Array;
}

function toDataView(input: ArrayBuffer | Uint8Array): DataView {
  if (input instanceof Uint8Array) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  }
  return new DataView(input);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c !== 0) s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Convert a SEED BTIME (10 bytes at `offset`) to epoch milliseconds. */
function btimeToMs(
  view: DataView,
  offset: number,
  littleEndian: boolean
): number {
  const year = view.getUint16(offset, littleEndian);
  const doy = view.getUint16(offset + 2, littleEndian); // day of year, 1-based
  const hour = view.getUint8(offset + 4);
  const min = view.getUint8(offset + 5);
  const sec = view.getUint8(offset + 6);
  // offset + 7 is unused
  const frac = view.getUint16(offset + 8, littleEndian); // units of 0.0001 s
  const base = Date.UTC(year, 0, 1, hour, min, sec);
  return base + (doy - 1) * 86_400_000 + frac * 0.1;
}

/** SEED sample-rate factor/multiplier → samples per second. */
export function seedSampleRate(factor: number, multiplier: number): number {
  if (factor > 0 && multiplier > 0) return factor * multiplier;
  if (factor > 0 && multiplier < 0) return -factor / multiplier;
  if (factor < 0 && multiplier > 0) return -multiplier / factor;
  if (factor < 0 && multiplier < 0) return 1 / (factor * multiplier);
  return 0;
}

/** Sign-extend the low `bits` of `value` to a JS (32-bit) signed integer. */
export function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

interface Blockette1000 {
  encoding: number;
  /** True = big-endian data, false = little-endian. */
  bigEndianData: boolean;
  recordLength: number;
}

function readBlockette1000(
  view: DataView,
  recordStart: number,
  firstBlocketteOffset: number,
  headerLittleEndian: boolean
): Blockette1000 | undefined {
  let off = recordStart + firstBlocketteOffset;
  // Walk the blockette chain looking for type 1000.
  for (let guard = 0; guard < 20 && off > recordStart; guard++) {
    const type = view.getUint16(off, headerLittleEndian);
    const next = view.getUint16(off + 2, headerLittleEndian);
    if (type === 1000) {
      const encoding = view.getUint8(off + 4);
      const wordOrder = view.getUint8(off + 5); // 1 = big-endian
      const lenExp = view.getUint8(off + 6);
      return {
        encoding,
        bigEndianData: wordOrder === 1,
        recordLength: 2 ** lenExp,
      };
    }
    if (next === 0) break;
    off = recordStart + next;
  }
  return undefined;
}

/**
 * Decode a Steim-1 or Steim-2 compressed payload into `numSamples` samples.
 *
 * Both schemes store 64-byte frames; frame word 0 packs sixteen 2-bit control
 * codes, and the first frame's words 1 and 2 hold the first sample (x0) and last
 * sample (xn) as integration constants. Samples are the running sum of the
 * decoded differences, seeded by x0.
 */
export function decodeSteim(
  view: DataView,
  dataStart: number,
  dataLength: number,
  numSamples: number,
  steimVersion: 1 | 2,
  bigEndianData: boolean,
  validate: boolean
): Float64Array {
  const out = new Float64Array(numSamples);
  if (numSamples === 0) return out;

  const le = !bigEndianData;
  const diffs: number[] = [];
  const frameCount = Math.floor(dataLength / 64);
  let x0 = 0;
  let xn = 0;

  for (let f = 0; f < frameCount && diffs.length < numSamples; f++) {
    const frame = dataStart + f * 64;
    const w0 = view.getUint32(frame, le);

    let word = 1;
    if (f === 0) {
      x0 = view.getInt32(frame + 4, le);
      xn = view.getInt32(frame + 8, le);
      word = 3;
    }

    for (; word < 16 && diffs.length < numSamples; word++) {
      const code = (w0 >>> (30 - 2 * word)) & 0x3;
      if (code === 0) continue;
      const w = view.getUint32(frame + word * 4, le);

      if (code === 1) {
        // Four 8-bit differences (identical in Steim-1 and Steim-2).
        diffs.push(signExtend((w >>> 24) & 0xff, 8));
        diffs.push(signExtend((w >>> 16) & 0xff, 8));
        diffs.push(signExtend((w >>> 8) & 0xff, 8));
        diffs.push(signExtend(w & 0xff, 8));
      } else if (steimVersion === 1) {
        if (code === 2) {
          diffs.push(signExtend((w >>> 16) & 0xffff, 16));
          diffs.push(signExtend(w & 0xffff, 16));
        } else {
          diffs.push(w | 0); // one 32-bit difference
        }
      } else {
        // Steim-2: the sub-encoding lives in the top two bits (dnib).
        const dnib = w >>> 30;
        if (code === 2) {
          if (dnib === 1) {
            diffs.push(signExtend(w & 0x3fffffff, 30));
          } else if (dnib === 2) {
            diffs.push(signExtend((w >>> 15) & 0x7fff, 15));
            diffs.push(signExtend(w & 0x7fff, 15));
          } else {
            diffs.push(signExtend((w >>> 20) & 0x3ff, 10));
            diffs.push(signExtend((w >>> 10) & 0x3ff, 10));
            diffs.push(signExtend(w & 0x3ff, 10));
          }
        } else {
          // code === 3
          if (dnib === 0) {
            for (let s = 24; s >= 0; s -= 6)
              diffs.push(signExtend((w >>> s) & 0x3f, 6));
          } else if (dnib === 1) {
            for (let s = 25; s >= 0; s -= 5)
              diffs.push(signExtend((w >>> s) & 0x1f, 5));
          } else {
            for (let s = 24; s >= 0; s -= 4)
              diffs.push(signExtend((w >>> s) & 0xf, 4));
          }
        }
      }
    }
  }

  // Reconstruct: the first stored difference reaches x0 from the previous
  // record and is discarded here; x0 is the first sample outright.
  out[0] = x0;
  let acc = x0;
  for (let i = 1; i < numSamples; i++) {
    acc += diffs[i];
    out[i] = acc;
  }

  if (validate && numSamples > 1 && acc !== xn) {
    throw new Error(
      `Steim integrity check failed: reconstructed last sample ${acc} !== stored ${xn}`
    );
  }
  return out;
}

function decodeUncompressed(
  view: DataView,
  dataStart: number,
  numSamples: number,
  encoding: number,
  le: boolean
): Float64Array {
  const out = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    switch (encoding) {
      case Encoding.INT16:
        out[i] = view.getInt16(dataStart + i * 2, le);
        break;
      case Encoding.INT32:
        out[i] = view.getInt32(dataStart + i * 4, le);
        break;
      case Encoding.FLOAT32:
        out[i] = view.getFloat32(dataStart + i * 4, le);
        break;
      case Encoding.FLOAT64:
        out[i] = view.getFloat64(dataStart + i * 8, le);
        break;
      default:
        throw new Error(`Unsupported uncompressed encoding ${encoding}`);
    }
  }
  return out;
}

/** Parse every data record in a miniSEED buffer. */
export function parseMiniseed(
  input: ArrayBuffer | Uint8Array,
  options: ParseOptions = {}
): MiniseedRecord[] {
  const validate = options.validateSteim ?? true;
  const view = toDataView(input);
  const total = view.byteLength;
  const records: MiniseedRecord[] = [];

  let pos = 0;
  while (pos + 48 <= total) {
    // Detect fixed-header byte order via the plausibility of the start year.
    const yearBE = view.getUint16(pos + 20, false);
    const headerLE = !(yearBE >= 1900 && yearBE <= 2100);

    const station = readAscii(view, pos + 8, 5);
    const location = readAscii(view, pos + 13, 2);
    const channel = readAscii(view, pos + 15, 3);
    const network = readAscii(view, pos + 18, 2);
    const startTimeMs = btimeToMs(view, pos + 20, headerLE);
    const numSamples = view.getUint16(pos + 30, headerLE);
    const factor = view.getInt16(pos + 32, headerLE);
    const multiplier = view.getInt16(pos + 34, headerLE);
    const dataOffset = view.getUint16(pos + 44, headerLE);
    const firstBlockette = view.getUint16(pos + 46, headerLE);

    const b1000 = readBlockette1000(view, pos, firstBlockette, headerLE);
    const recordLength = b1000?.recordLength ?? 512;
    const encoding = b1000?.encoding ?? Encoding.STEIM2;
    const bigEndianData = b1000?.bigEndianData ?? !headerLE;

    const dataStart = pos + dataOffset;
    const dataLength = recordLength - dataOffset;

    let samples: Float64Array;
    if (encoding === Encoding.STEIM1 || encoding === Encoding.STEIM2) {
      samples = decodeSteim(
        view,
        dataStart,
        dataLength,
        numSamples,
        encoding === Encoding.STEIM1 ? 1 : 2,
        bigEndianData,
        validate
      );
    } else {
      samples = decodeUncompressed(
        view,
        dataStart,
        numSamples,
        encoding,
        !bigEndianData
      );
    }

    records.push({
      network,
      station,
      location,
      channel,
      startTimeMs,
      sampleRateHz: seedSampleRate(factor, multiplier),
      numSamples,
      encoding,
      samples,
    });

    pos += recordLength;
  }

  return records;
}

const NSLC = (r: {
  network: string;
  station: string;
  location: string;
  channel: string;
}) => `${r.network}.${r.station}.${r.location}.${r.channel}`;

/**
 * Join records of the same channel (network.station.location.channel) into one
 * contiguous {@link Trace} each, ordered by time. Records are simply
 * concatenated in time order; gap handling is left to the caller.
 */
export function mergeRecords(records: readonly MiniseedRecord[]): Trace[] {
  const groups = new Map<string, MiniseedRecord[]>();
  for (const r of records) {
    const key = NSLC(r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const traces: Trace[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.startTimeMs - b.startTimeMs);
    const totalSamples = list.reduce((n, r) => n + r.numSamples, 0);
    const samples = new Float64Array(totalSamples);
    let offset = 0;
    for (const r of list) {
      samples.set(r.samples, offset);
      offset += r.numSamples;
    }
    const first = list[0];
    traces.push({
      network: first.network,
      station: first.station,
      location: first.location,
      channel: first.channel,
      startTimeMs: first.startTimeMs,
      sampleRateHz: first.sampleRateHz,
      samples,
    });
  }
  return traces;
}
