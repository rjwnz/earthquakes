/**
 * GeoNet AWS Open Data pipeline — build the FULL dense dataset.
 *
 * This is the "real bundled event" pipeline. It runs on YOUR machine (which can
 * reach the bucket's ap-southeast-2 region), pulls raw miniSEED straight from
 * the public `geonet-open-data` S3 bucket, decodes it with our own reader, and
 * writes `public/data/event.json` — the exact same shape the app already loads
 * from the checked-in sample. No AWS credentials, no aws-cli: the bucket is
 * public, so plain HTTPS GETs are enough.
 *
 *   npm run fetch-data
 *
 * Configure via the CONFIG block below (event, time window, channels, how
 * densely to sample the network). Everything is dependency-free and reuses the
 * unit-tested transforms in src/data.
 *
 * Bucket & registry: https://registry.opendata.aws/geonet/
 * Layout (SeisComP SDS): waveforms/miniseed/{YEAR}/{NET}/{STA}/{CHA}.D/{NET}.{STA}.{LOC}.{CHA}.D.{YEAR}.{DOY}
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseMiniseed, mergeRecords} from '../src/data/miniseed';
import {robustMaxAbs} from '../src/data/amplitude';
import {estimateBaseline, resampleBoxAverage} from '../src/data/resample';
import {decimateByGrid} from '../src/data/decimate';
import {wrapLongitude} from '../src/geo/projection';
import type {ShakeDataset, SensorTrace, EventMeta} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));

const CONFIG = {
  /** Regional S3 endpoint for the public bucket (no signing required). */
  bucketBase: 'https://geonet-open-data.s3-ap-southeast-2.amazonaws.com',
  network: 'NZ',

  event: {
    id: '2016p858000',
    name: 'Kaikōura M7.8 — 14 Nov 2016',
    originTimeMs: Date.parse('2016-11-13T11:02:56Z'),
    lat: -42.737,
    lon: 173.054,
    depthKm: 15,
    magnitude: 7.8,
  } as EventMeta,

  /** Playback window: starts `preRollS` before origin, lasts `durationS`. */
  preRollS: 56,
  durationS: 480,
  outputRateHz: 20,

  /**
   * Vertical channels to try, in order. Strong-motion accelerometers (HNZ/BNZ)
   * don't clip in the near field, so they show propagation far better than the
   * broadband HHZ; broadband is the fallback for sites without strong motion.
   */
  channels: ['HNZ', 'BNZ', 'HHZ'],

  /** Geographic region (Chatham reached via wrapped longitude). */
  region: {latMin: -48.5, latMax: -33.5, lonMinWrapped: 164, lonMaxWrapped: 186},

  /**
   * Spatial thinning of the station list before download: keep one station per
   * grid cell of this size (degrees). This is the data-layer twin of the map's
   * on-screen decimation — it keeps coverage even while bounding how many
   * full-day files we pull. Raise to download fewer stations.
   */
  selectionCellDeg: 0.25,
  maxStations: 300,
  concurrency: 6,
};

const START_MS = CONFIG.event.originTimeMs - CONFIG.preRollS * 1000;
const END_MS = START_MS + CONFIG.durationS * 1000;
const SAMPLE_COUNT = CONFIG.durationS * CONFIG.outputRateHz;
const BASELINE_END_MS = CONFIG.event.originTimeMs - 5000;

interface Station {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

// ---- delta station catalogue (from GitHub, or a local copy) ----

function loadStations(): Station[] {
  const local = root + 'data-raw/delta_stations.csv';
  let csv: string;
  if (existsSync(local)) {
    csv = readFileSync(local, 'utf8');
  } else {
    throw new Error(
      'Missing data-raw/delta_stations.csv. Download it first:\n' +
        '  curl -sSL https://raw.githubusercontent.com/GeoNet/delta/main/network/stations.csv -o data-raw/delta_stations.csv'
    );
  }

  const lines = csv.split('\n').filter(l => l.trim().length > 0);
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);
  const iCode = col('Station');
  const iName = col('Name');
  const iLat = col('Latitude');
  const iLon = col('Longitude');
  const iStart = col('Start Date');
  const iEnd = col('End Date');
  const eventMs = CONFIG.event.originTimeMs;

  const byCode = new Map<string, Station>();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // Active on the event date?
    const start = Date.parse(f[iStart]);
    const end = f[iEnd] ? Date.parse(f[iEnd]) : Number.POSITIVE_INFINITY;
    if (!(start <= eventMs && eventMs <= end)) continue;

    // In region (wrapped longitude so the Chathams are included)?
    const w = wrapLongitude(lon);
    const {region} = CONFIG;
    if (lat < region.latMin || lat > region.latMax) continue;
    if (w < region.lonMinWrapped || w > region.lonMaxWrapped) continue;

    byCode.set(f[iCode], {code: f[iCode], name: f[iName], lat, lon});
  }
  return [...byCode.values()];
}

/** Thin the station list to one representative per grid cell. */
function selectStations(stations: Station[]): Station[] {
  const placed = stations.map((s, index) => ({x: s.lon, y: s.lat, index}));
  const clusters = decimateByGrid(placed, {cellSize: CONFIG.selectionCellDeg});
  let selected = clusters.map(c => stations[c.representative.index]);
  if (selected.length > CONFIG.maxStations) {
    // Deterministic thin-out to the cap: keep an even stride.
    const stride = selected.length / CONFIG.maxStations;
    selected = Array.from({length: CONFIG.maxStations}, (_, i) => selected[Math.floor(i * stride)]);
  }
  return selected;
}

// ---- S3 (anonymous, public bucket) ----

async function s3Get(key: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${CONFIG.bucketBase}/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key} → ${res.status}`);
  return res.arrayBuffer();
}

async function s3ListKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const url = new URL(CONFIG.bucketBase + '/');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (token) url.searchParams.set('continuation-token', token);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`LIST ${prefix} → ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    token = t ? t[1] : undefined;
  } while (token);
  return keys;
}

const doy = (() => {
  const d = new Date(START_MS);
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - startOfYear) / 86_400_000) + 1;
})();
const year = new Date(START_MS).getUTCFullYear();
const doyStr = String(doy).padStart(3, '0');

/** Resolve and download the first available vertical channel for a station. */
async function fetchStationTrace(sta: Station): Promise<number[] | null> {
  for (const cha of CONFIG.channels) {
    const prefix = `waveforms/miniseed/${year}/${CONFIG.network}/${sta.code}/${cha}.D/`;
    let keys: string[];
    try {
      keys = await s3ListKeys(prefix);
    } catch {
      continue;
    }
    const key = keys.find(k => k.endsWith(`.${year}.${doyStr}`));
    if (!key) continue;

    const buf = await s3Get(key);
    if (!buf) continue;

    // Lenient: real archive records can have the odd gap; skip integrity throws.
    const records = parseMiniseed(buf, {validateSteim: false}).filter(r => {
      const recEnd = r.startTimeMs + (r.numSamples / r.sampleRateHz) * 1000;
      return r.startTimeMs < END_MS && recEnd > START_MS;
    });
    if (records.length === 0) continue;

    const [trace] = mergeRecords(records);
    if (!trace) continue;

    const baseline = estimateBaseline(
      trace.samples,
      trace.startTimeMs,
      trace.sampleRateHz,
      START_MS,
      BASELINE_END_MS
    );
    const grid = resampleBoxAverage(
      trace.samples,
      trace.startTimeMs,
      trace.sampleRateHz,
      START_MS,
      CONFIG.outputRateHz,
      SAMPLE_COUNT
    );
    return grid.map(v => Math.round(v - baseline));
  }
  return null;
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main(): Promise<void> {
  const all = loadStations();
  const selected = selectStations(all);
  console.log(
    `delta: ${all.length} stations in region, thinned to ${selected.length} ` +
      `(cell ${CONFIG.selectionCellDeg}°). Downloading ${year}.${doyStr} …`
  );

  let done = 0;
  const results = await pool(selected, CONFIG.concurrency, async sta => {
    let samples: number[] | null = null;
    try {
      samples = await fetchStationTrace(sta);
    } catch (err) {
      console.warn(`  ${sta.code}: ${(err as Error).message}`);
    }
    done++;
    if (done % 20 === 0) console.log(`  …${done}/${selected.length}`);
    return {sta, samples};
  });

  const sensors: SensorTrace[] = results.map(({sta, samples}) =>
    samples
      ? {...sta, samples, hasData: true, scale: robustMaxAbs(samples, 0.995)}
      : {...sta, samples: [], hasData: false, scale: 0}
  );

  const recording = sensors.filter(s => s.hasData);
  const allSamples: number[] = [];
  for (const s of recording) allSamples.push(...s.samples);
  const amplitudeScale = Math.max(1, robustMaxAbs(allSamples, 0.995));

  const dataset: ShakeDataset = {
    event: CONFIG.event,
    network: CONFIG.network,
    startMs: START_MS,
    endMs: END_MS,
    sampleRateHz: CONFIG.outputRateHz,
    units: 'counts (uncorrected ground motion)',
    amplitudeScale,
    sensors,
  };

  const outDir = root + 'public/data';
  mkdirSync(outDir, {recursive: true});
  writeFileSync(outDir + '/event.json', JSON.stringify(dataset));
  console.log(
    `\nWrote public/data/event.json — ${sensors.length} sensors, ` +
      `${recording.length} with data, ${(JSON.stringify(dataset).length / 1024 / 1024).toFixed(1)} MB`
  );
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
