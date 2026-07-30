import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  parseMiniseed,
  mergeRecords,
  seedSampleRate,
  signExtend,
  Encoding,
} from './miniseed';

describe('seedSampleRate', () => {
  it('handles the four factor/multiplier sign cases', () => {
    expect(seedSampleRate(100, 1)).toBe(100); // both positive
    expect(seedSampleRate(40, 1)).toBe(40);
    expect(seedSampleRate(-50, 2)).toBe(0.04); // -mult/factor = -2/-50
    expect(seedSampleRate(50, -100)).toBe(0.5); // -factor/mult = -50/-100
    expect(seedSampleRate(-2, -5)).toBeCloseTo(0.1, 12); // 1/(factor*mult)
  });
});

describe('signExtend', () => {
  it('extends narrow signed fields correctly', () => {
    expect(signExtend(0x3f, 6)).toBe(-1); // all ones in 6 bits
    expect(signExtend(0x1f, 6)).toBe(31); // 011111
    expect(signExtend(0x7fff, 15)).toBe(-1);
    expect(signExtend(0x3fffffff, 30)).toBe(-1);
    expect(signExtend(0x0a, 8)).toBe(10);
    expect(signExtend(0xff, 8)).toBe(-1);
  });
});

/**
 * Build a single 512-byte big-endian miniSEED record with the given encoding and
 * sample count. `writeData` fills the payload starting at offset 64. This lets us
 * assert exact decoded values through the whole framing / BTIME / rate /
 * blockette-1000 path for several encodings.
 */
function buildRecord(
  encoding: number,
  numSamples: number,
  writeData: (dv: DataView, dataOffset: number) => void
): Uint8Array {
  const buf = new Uint8Array(512);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();
  const put = (off: number, s: string) => buf.set(enc.encode(s), off);

  put(0, '000001'); // sequence number
  put(6, 'D'); // data quality
  put(7, ' ');
  put(8, 'TEST '); // station (5)
  put(13, '00'); // location (2)
  put(15, 'BHZ'); // channel (3)
  put(18, 'NZ'); // network (2)

  // BTIME at 20: year 2020, doy 1, 00:00:00.0000
  dv.setUint16(20, 2020, false);
  dv.setUint16(22, 1, false);
  dv.setUint16(28, 0, false);

  dv.setUint16(30, numSamples, false); // number of samples
  dv.setInt16(32, 40, false); // sample-rate factor → 40 Hz
  dv.setInt16(34, 1, false); // multiplier
  dv.setUint8(39, 1); // one blockette follows
  dv.setUint16(44, 64, false); // beginning of data
  dv.setUint16(46, 48, false); // first blockette offset

  // Blockette 1000 at offset 48
  dv.setUint16(48, 1000, false); // type
  dv.setUint16(50, 0, false); // next blockette
  dv.setUint8(52, encoding);
  dv.setUint8(53, 1); // word order: big-endian
  dv.setUint8(54, 9); // record length 2^9 = 512

  writeData(dv, 64);
  return buf;
}

const buildInt32Record = (samples: number[]) =>
  buildRecord(Encoding.INT32, samples.length, (dv, off) =>
    samples.forEach((s, i) => dv.setInt32(off + i * 4, s, false))
  );

describe('parseMiniseed — synthetic FLOAT32 record', () => {
  it('decodes IEEE float samples', () => {
    const samples = [1.5, -2.25, 0, 3.75];
    const rec = parseMiniseed(
      buildRecord(Encoding.FLOAT32, samples.length, (dv, off) =>
        samples.forEach((s, i) => dv.setFloat32(off + i * 4, s, false))
      )
    )[0];
    expect(Array.from(rec.samples)).toEqual(samples);
  });
});

describe('parseMiniseed — synthetic Steim-1 record', () => {
  it('reconstructs samples from a hand-built Steim-1 frame', () => {
    // Samples 100, 150, 130 → x0=100, xn=130, diffs (skipping d0): 50, -20.
    // One control word + integration constants + one code-1 data word holding
    // four int8 differences [d0=0, 50, -20, pad].
    const rec = parseMiniseed(
      buildRecord(Encoding.STEIM1, 3, (dv, off) => {
        // word0 control: c3 = code 1 (bits 25:24) → 1 << 24.
        dv.setUint32(off + 0, 0x01000000, false);
        dv.setInt32(off + 4, 100, false); // x0
        dv.setInt32(off + 8, 130, false); // xn
        // word3: four int8 diffs [0, 50, -20, 0] → 0x00 32 EC 00.
        dv.setUint32(off + 12, 0x0032ec00, false);
      })
    )[0];
    expect(rec.encoding).toBe(Encoding.STEIM1);
    expect(Array.from(rec.samples)).toEqual([100, 150, 130]);
  });
});

describe('parseMiniseed — synthetic INT32 record', () => {
  const samples = [100, -200, 300, -400, 2147483647, -2147483648];
  const recs = parseMiniseed(buildInt32Record(samples));

  it('reads exactly one record', () => {
    expect(recs).toHaveLength(1);
  });

  it('decodes header fields', () => {
    const r = recs[0];
    expect(r.network).toBe('NZ');
    expect(r.station).toBe('TEST');
    expect(r.location).toBe('00');
    expect(r.channel).toBe('BHZ');
    expect(r.sampleRateHz).toBe(40);
    expect(r.encoding).toBe(Encoding.INT32);
    expect(r.startTimeMs).toBe(Date.UTC(2020, 0, 1, 0, 0, 0));
  });

  it('decodes exact sample values including int32 extremes', () => {
    expect(Array.from(recs[0].samples)).toEqual(samples);
  });
});

describe('parseMiniseed — real GeoNet Steim-2 record (Kaikoura, BFZ HHZ)', () => {
  const path = fileURLToPath(
    new URL('../../test/fixtures/bfz-hhz-first-record.mseed', import.meta.url)
  );
  const buf = readFileSync(path);

  it('parses one 512-byte Steim-2 record and passes the integrity check', () => {
    // validateSteim (default) throws if the reconstructed last sample does not
    // match the record's stored integration constant.
    const recs = parseMiniseed(buf, {validateSteim: true});
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.station).toBe('BFZ');
    expect(r.channel).toBe('HHZ');
    expect(r.network).toBe('NZ');
    expect(r.encoding).toBe(Encoding.STEIM2);
    expect(r.sampleRateHz).toBe(100);
    expect(r.numSamples).toBe(140);
    // BTIME carries 0.1 ms resolution: true start is 11:02:00.0084 UTC.
    expect(r.startTimeMs).toBeCloseTo(1479034920008.4, 6);
  });

  it('produces the expected first and last samples', () => {
    const r = parseMiniseed(buf)[0];
    expect(r.samples).toHaveLength(140);
    expect(r.samples[0]).toBe(-2018);
    expect(r.samples[139]).toBe(3026);
  });

  it('mergeRecords yields a single contiguous trace', () => {
    const traces = mergeRecords(parseMiniseed(buf));
    expect(traces).toHaveLength(1);
    expect(traces[0].samples).toHaveLength(140);
    expect(traces[0].station).toBe('BFZ');
  });
});
