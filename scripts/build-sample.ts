/**
 * Build the checked-in sample datasets from the real EarthScope miniSEED grabbed
 * for several historical NZ earthquakes.
 *
 * Input:  data-raw/<id>_hhz.mseed      (NZ backbone HHZ, ~8 min around origin)
 * Output: public/data/events/<id>.json (one {@link ShakeDataset} per event)
 *         public/data/catalog.json     (the event picker's index)
 *
 * These small, offline-friendly datasets ship with the app. The full dense
 * datasets come from `scripts/fetch-data.ts` (the GeoNet AWS Open Data pipeline),
 * which emits the same JSON shape and updates the same catalogue.
 *
 *   npm run build-sample
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseMiniseed, mergeRecords, type Trace} from '../src/data/miniseed';
import {robustMaxAbs} from '../src/data/amplitude';
import {estimateBaseline, resampleBoxAverage} from '../src/data/resample';
import {detectShakingWindow} from '../src/data/window';
import {nearestTo} from '../src/geo/distance';
import {EVENTS, type EventConfig} from './events';
import type {
  ShakeDataset,
  SensorTrace,
  Catalog,
  CatalogEntry,
} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const RAW_DIR = root + 'data-raw';
const OUT_DIR = root + 'public/data';
const EVENTS_DIR = OUT_DIR + '/events';

const OUTPUT_RATE_HZ = 20;

/** The 11 GeoNet backbone broadband sites, with reference coordinates. */
const STATIONS: Array<{code: string; name: string; lat: number; lon: number}> =
  [
    {code: 'OUZ', name: 'Omahuta', lat: -35.219689, lon: 173.596133},
    {code: 'HIZ', name: 'Hauiti', lat: -38.512929, lon: 174.855686},
    {code: 'URZ', name: 'Urewera', lat: -38.259249, lon: 177.110894},
    {code: 'BKZ', name: 'Black Stump Farm', lat: -39.165666, lon: 176.492544},
    {code: 'WPVZ', name: 'Whakapapa', lat: -39.204004, lon: 175.545922},
    {code: 'BFZ', name: 'Birch Farm', lat: -40.679647, lon: 176.246245},
    {code: 'QRZ', name: 'Quartz Range', lat: -40.825522, lon: 172.529148},
    {code: 'KHZ', name: 'Kahutara', lat: -42.41598, lon: 173.53897},
    {code: 'RPZ', name: 'Rata Peaks', lat: -43.714608, lon: 171.053865},
    {code: 'CTZ', name: 'Chatham Island', lat: -43.73549, lon: -176.61719},
    {code: 'ODZ', name: 'Otahua Downs', lat: -45.043982, lon: 170.644622},
  ];

function resample(
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
    OUTPUT_RATE_HZ,
    count
  );
  return grid.map(v => Math.round(v - baseline));
}

function buildEvent(cfg: EventConfig): {
  dataset: ShakeDataset;
  recording: number;
  window: {startS: number; endS: number; ref: string};
} {
  const buf = readFileSync(`${RAW_DIR}/${cfg.sampleMseed}`);
  const traces = mergeRecords(parseMiniseed(buf, {validateSteim: true}));
  const byStation = new Map(traces.map(t => [t.station, t]));

  // Crop to the shaking window of the station nearest the epicentre: it starts
  // just before major shaking begins there and ends once it has died away.
  const located = STATIONS.filter(s => byStation.has(s.code));
  const nearest = nearestTo(located, cfg.event);
  if (!nearest) throw new Error(`${cfg.id}: no station data`);
  const refTrace = byStation.get(nearest.code)!;
  const win = detectShakingWindow(refTrace.samples, refTrace.startTimeMs, {
    sampleRateHz: refTrace.sampleRateHz,
    lowFraction: 0.05,
    highFraction: 0.95,
    preRollS: 5,
    tailS: 5,
  });
  const startMs = win.startMs;
  const endMs = win.endMs;
  const sampleCount = Math.round(((endMs - startMs) / 1000) * OUTPUT_RATE_HZ);
  // DC baseline from the quiet lead-in (before onset).
  const baselineEndMs = win.onsetMs;

  const sensors: SensorTrace[] = STATIONS.map(s => {
    const trace = byStation.get(s.code);
    if (!trace) return {...s, samples: [], hasData: false, scale: 0};
    const samples = resample(trace, startMs, sampleCount, baselineEndMs);
    return {...s, samples, hasData: true, scale: robustMaxAbs(samples, 0.995)};
  });

  const all: number[] = [];
  for (const s of sensors) if (s.hasData) all.push(...s.samples);
  const amplitudeScale = Math.max(1, robustMaxAbs(all, 0.995));

  const dataset: ShakeDataset = {
    event: cfg.event,
    network: 'NZ',
    startMs,
    endMs,
    sampleRateHz: OUTPUT_RATE_HZ,
    units: 'counts (uncorrected broadband velocity)',
    amplitudeScale,
    sensors,
  };
  return {
    dataset,
    recording: sensors.filter(s => s.hasData).length,
    window: {
      startS: (startMs - cfg.event.originTimeMs) / 1000,
      endS: (endMs - cfg.event.originTimeMs) / 1000,
      ref: nearest.code,
    },
  };
}

function main(): void {
  mkdirSync(EVENTS_DIR, {recursive: true});
  const catalog: Catalog = {events: []};

  for (const cfg of EVENTS) {
    if (!existsSync(`${RAW_DIR}/${cfg.sampleMseed}`)) {
      console.warn(`skip ${cfg.id}: missing data-raw/${cfg.sampleMseed}`);
      continue;
    }
    const {dataset, recording, window} = buildEvent(cfg);
    const file = `events/${cfg.id}.json`;
    writeFileSync(`${OUT_DIR}/${file}`, JSON.stringify(dataset));

    const entry: CatalogEntry = {
      id: cfg.id,
      name: cfg.event.name,
      date: cfg.date,
      magnitude: cfg.event.magnitude,
      region: cfg.region,
      file,
    };
    catalog.events.push(entry);
    console.log(
      `${cfg.id}: ${recording}/${dataset.sensors.length} recording, ` +
        `window ${window.startS.toFixed(0)}..${window.endS.toFixed(0)}s ` +
        `(from origin, ref ${window.ref}), ` +
        `${(JSON.stringify(dataset).length / 1024).toFixed(0)} KB`
    );
  }

  writeFileSync(`${OUT_DIR}/catalog.json`, JSON.stringify(catalog, null, 2));
  console.log(`catalog.json: ${catalog.events.length} events`);
}

main();
