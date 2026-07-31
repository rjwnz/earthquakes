/**
 * GeoNet AWS Open Data pipeline — build the FULL dense datasets.
 *
 * This is the "real bundled event" pipeline. It runs on YOUR machine (which can
 * reach the bucket's ap-southeast-2 region), pulls raw miniSEED straight from
 * the public `geonet-open-data` S3 bucket, decodes it with our own reader, and
 * writes a dense `public/data/events/<id>.json` for every event in
 * `scripts/events.ts` (the same catalogue the sample builder uses), plus the
 * shared `catalog.json`. No AWS credentials, no aws-cli: the bucket is public,
 * so plain HTTPS GETs are enough.
 *
 *   npm run fetch-data
 *
 * The events come from scripts/events.ts; tune the download/window behaviour in
 * the CONFIG block below (channels, window, how densely to sample the network).
 * Everything is dependency-free and reuses the unit-tested transforms in src/data.
 *
 * Bucket & registry: https://registry.opendata.aws/geonet/
 * Layout (date-nested):
 *   waveforms/miniseed/{YEAR}/{YEAR}.{DOY}/{STA}.{NET}/{YEAR}.{DOY}.{STA}.{LOC}-{CHA}.{NET}.D
 * (all channels live directly under the {STA}.{NET} directory; the location code
 * is embedded in the filename, so we match on the "-{CHA}.{NET}.D" suffix.)
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  parseMiniseed,
  mergeRecords,
  type Trace,
  type MiniseedRecord,
} from '../src/data/miniseed';
import {robustMaxAbs} from '../src/data/amplitude';
import {estimateBaseline, resampleBoxAverage} from '../src/data/resample';
import {detectShakingWindow} from '../src/data/window';
import {decimateByGrid} from '../src/data/decimate';
import {wrapLongitude} from '../src/geo/projection';
import {nearestTo} from '../src/geo/distance';
import {EVENTS, type EventConfig} from './events';
import type {
  ShakeDataset,
  SensorTrace,
  Catalog,
  CatalogEntry,
} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));

const CONFIG = {
  /** Regional S3 endpoint for the public bucket (no signing required). */
  bucketBase: 'https://geonet-open-data.s3-ap-southeast-2.amazonaws.com',
  network: 'NZ',

  outputRateHz: 20,

  /**
   * The playback window is detected from the shaking of the station nearest the
   * epicentre (significant duration): it starts `preRollS` before major shaking
   * begins there and ends `tailS` after it has died away. `guardPreS`/`maxSpanS`
   * bound how much raw data is pulled while searching for that window.
   */
  window: {
    lowFraction: 0.05,
    highFraction: 0.95,
    preRollS: 5,
    tailS: 5,
    guardPreS: 30,
    maxSpanS: 600,
  },

  /**
   * Vertical channels to try, in order. Strong-motion accelerometers (HNZ/BNZ)
   * don't clip in the near field, so they show propagation far better than the
   * broadband HHZ; broadband is the fallback for sites without strong motion.
   */
  channels: ['HNZ', 'BNZ', 'HHZ'],

  /** Geographic bounds to include (Chatham reached via wrapped longitude). */
  regionBounds: {
    latMin: -48.5,
    latMax: -33.5,
    lonMinWrapped: 164,
    lonMaxWrapped: 186,
  },

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

interface Station {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

/** One UTC day in the archive: its year and zero-padded day-of-year. */
interface ArchiveDay {
  year: number;
  doyStr: string;
}

/** Per-event day/window context, computed from the event origin. */
interface DayContext {
  /** Every UTC day the guard span touches (usually one; two if it crosses midnight). */
  days: ArchiveDay[];
  guardStartMs: number;
  guardEndMs: number;
}

function archiveDay(ms: number): ArchiveDay {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const doy =
    Math.floor(
      (Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)) /
        86_400_000
    ) + 1;
  return {year, doyStr: String(doy).padStart(3, '0')};
}

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayContext(originMs: number): DayContext {
  const guardStartMs = originMs - CONFIG.window.guardPreS * 1000;
  const guardEndMs = originMs + CONFIG.window.maxSpanS * 1000;
  const days: ArchiveDay[] = [];
  const oneDay = 86_400_000;
  for (
    let t = utcMidnight(guardStartMs);
    t <= utcMidnight(guardEndMs);
    t += oneDay
  ) {
    days.push(archiveDay(t));
  }
  return {days, guardStartMs, guardEndMs};
}

// ---- delta station catalogue (from GitHub, or a local copy) ----

function loadStations(eventMs: number): Station[] {
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
    const {regionBounds} = CONFIG;
    if (lat < regionBounds.latMin || lat > regionBounds.latMax) continue;
    if (w < regionBounds.lonMinWrapped || w > regionBounds.lonMaxWrapped)
      continue;

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
    selected = Array.from(
      {length: CONFIG.maxStations},
      (_, i) => selected[Math.floor(i * stride)]
    );
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
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      xml
    );
    token = t ? t[1] : undefined;
  } while (token);
  return keys;
}

/**
 * Resolve and download the preferred vertical channel for a station, returning
 * its merged raw trace (native rate) over the guard span, or null.
 *
 * All of a station's channels live directly under `{STA}.{NET}/`, one file per
 * channel+location named `{YEAR}.{DOY}.{STA}.{LOC}-{CHA}.{NET}.D`, so we list
 * the station directory once per day and match the desired channel by its
 * `-{CHA}.{NET}.D` suffix (any location code).
 */
async function fetchStationRaw(
  sta: Station,
  ctx: DayContext
): Promise<Trace | null> {
  const net = CONFIG.network;
  const listings: Array<{keys: string[]}> = [];
  for (const day of ctx.days) {
    const prefix = `waveforms/miniseed/${day.year}/${day.year}.${day.doyStr}/${sta.code}.${net}/`;
    try {
      listings.push({keys: await s3ListKeys(prefix)});
    } catch {
      // Skip a day we couldn't list; others may still have data.
    }
  }
  if (listings.length === 0) return null;

  // Choose the highest-preference channel present on any day.
  const chosen = CONFIG.channels.find(cha =>
    listings.some(l => l.keys.some(k => k.endsWith(`-${cha}.${net}.D`)))
  );
  if (!chosen) return null;

  const records: MiniseedRecord[] = [];
  for (const {keys} of listings) {
    const key = keys.find(k => k.endsWith(`-${chosen}.${net}.D`));
    if (!key) continue;
    const buf = await s3Get(key);
    if (!buf) continue;
    // Lenient: real archive records can have the odd gap; skip integrity throws.
    for (const r of parseMiniseed(buf, {validateSteim: false})) {
      const recEnd = r.startTimeMs + (r.numSamples / r.sampleRateHz) * 1000;
      if (r.startTimeMs < ctx.guardEndMs && recEnd > ctx.guardStartMs) {
        records.push(r);
      }
    }
  }
  if (records.length === 0) return null;

  const [trace] = mergeRecords(records);
  return trace ?? null;
}

/** Resample a raw trace onto the final window, removing the pre-onset baseline. */
function resampleTrace(
  trace: Trace,
  startMs: number,
  count: number,
  baselineEndMs: number
): number[] {
  const baseline = estimateBaseline(
    trace.samples,
    trace.startTimeMs,
    trace.sampleRateHz,
    startMs,
    baselineEndMs
  );
  const grid = resampleBoxAverage(
    trace.samples,
    trace.startTimeMs,
    trace.sampleRateHz,
    startMs,
    CONFIG.outputRateHz,
    count
  );
  return grid.map(v => Math.round(v - baseline));
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    {length: Math.min(limit, items.length)},
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }
  );
  await Promise.all(runners);
  return out;
}

/** Build the full dense dataset for one event and write it + its catalogue entry. */
async function buildEvent(cfg: EventConfig, outDir: string): Promise<void> {
  const originMs = cfg.event.originTimeMs;
  const ctx = dayContext(originMs);

  const all = loadStations(originMs);
  const selected = selectStations(all);
  const dayLabel = ctx.days.map(d => `${d.year}.${d.doyStr}`).join('+');
  console.log(
    `\n${cfg.id}: ${all.length} stations in region → ${selected.length} selected ` +
      `(cell ${CONFIG.selectionCellDeg}°). Downloading ${dayLabel} …`
  );

  let done = 0;
  const raw = await pool(selected, CONFIG.concurrency, async sta => {
    let trace: Trace | null = null;
    try {
      trace = await fetchStationRaw(sta, ctx);
    } catch (err) {
      console.warn(`  ${sta.code}: ${(err as Error).message}`);
    }
    done++;
    if (done % 50 === 0) console.log(`  …${done}/${selected.length}`);
    return {sta, trace};
  });

  // Detect the shaking window from the station nearest the epicentre that has
  // data, then crop every trace to it (matches scripts/build-sample.ts).
  const withData = raw.filter(r => r.trace);
  const nearest = nearestTo(
    withData.map(r => r.sta),
    cfg.event
  );
  const nearestTrace = withData.find(r => r.sta.code === nearest?.code)?.trace;
  const win = nearestTrace
    ? detectShakingWindow(nearestTrace.samples, nearestTrace.startTimeMs, {
        sampleRateHz: nearestTrace.sampleRateHz,
        lowFraction: CONFIG.window.lowFraction,
        highFraction: CONFIG.window.highFraction,
        preRollS: CONFIG.window.preRollS,
        tailS: CONFIG.window.tailS,
      })
    : {
        startMs: ctx.guardStartMs,
        endMs: ctx.guardEndMs,
        onsetMs: ctx.guardStartMs,
      };
  const startMs = win.startMs;
  const endMs = win.endMs;
  const sampleCount = Math.round(
    ((endMs - startMs) / 1000) * CONFIG.outputRateHz
  );

  const sensors: SensorTrace[] = raw.map(({sta, trace}) =>
    trace
      ? {
          ...sta,
          samples: resampleTrace(trace, startMs, sampleCount, win.onsetMs),
          hasData: true,
          scale: 0,
        }
      : {...sta, samples: [], hasData: false, scale: 0}
  );
  for (const s of sensors) {
    if (s.hasData) s.scale = robustMaxAbs(s.samples, 0.995);
  }

  const recording = sensors.filter(s => s.hasData);
  const allSamples: number[] = [];
  for (const s of recording) allSamples.push(...s.samples);
  const amplitudeScale = Math.max(1, robustMaxAbs(allSamples, 0.995));

  const dataset: ShakeDataset = {
    event: cfg.event,
    network: CONFIG.network,
    startMs,
    endMs,
    sampleRateHz: CONFIG.outputRateHz,
    units: 'counts (uncorrected ground motion)',
    amplitudeScale,
    sensors,
  };

  const file = `events/${cfg.id}.json`;
  writeFileSync(`${outDir}/${file}`, JSON.stringify(dataset));
  upsertCatalog(outDir + '/catalog.json', {
    id: cfg.id,
    name: cfg.event.name,
    date: cfg.date,
    magnitude: cfg.event.magnitude,
    region: cfg.region,
    file,
  });

  console.log(
    `  window ${((startMs - originMs) / 1000).toFixed(0)}..` +
      `${((endMs - originMs) / 1000).toFixed(0)}s (ref ${nearest?.code ?? '—'}); ` +
      `${recording.length}/${sensors.length} recording; ` +
      `${(JSON.stringify(dataset).length / 1024 / 1024).toFixed(1)} MB → ${file}`
  );
}

async function main(): Promise<void> {
  const outDir = root + 'public/data';
  mkdirSync(outDir + '/events', {recursive: true});
  for (const cfg of EVENTS) {
    await buildEvent(cfg, outDir);
  }
  console.log(
    `\nDone: ${EVENTS.length} events → public/data/events/, catalog.json updated.`
  );
}

function upsertCatalog(path: string, entry: CatalogEntry): void {
  let catalog: Catalog = {events: []};
  if (existsSync(path)) {
    try {
      catalog = JSON.parse(readFileSync(path, 'utf8')) as Catalog;
    } catch {
      catalog = {events: []};
    }
  }
  const i = catalog.events.findIndex(e => e.id === entry.id);
  if (i >= 0) catalog.events[i] = entry;
  else catalog.events.push(entry);
  writeFileSync(path, JSON.stringify(catalog, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
