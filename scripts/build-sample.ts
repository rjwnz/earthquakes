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
import type {
  ShakeDataset,
  SensorTrace,
  EventMeta,
  Catalog,
  CatalogEntry,
} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const RAW_DIR = root + 'data-raw';
const OUT_DIR = root + 'public/data';
const EVENTS_DIR = OUT_DIR + '/events';

const OUTPUT_RATE_HZ = 20;
const DURATION_S = 480;

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

interface EventConfig {
  id: string;
  mseed: string;
  date: string;
  region: string;
  /** Seconds of quiet lead-in before origin (matches the fetched window). */
  preRollS: number;
  event: EventMeta;
}

const EVENTS: EventConfig[] = [
  {
    id: 'kaikoura-2016',
    mseed: 'kaikoura_hhz.mseed',
    date: '14 Nov 2016',
    region: 'Kaikōura, Marlborough',
    preRollS: 56,
    event: {
      id: '2016p858000',
      name: 'Kaikōura M7.8 — 14 Nov 2016',
      originTimeMs: Date.parse('2016-11-13T11:02:56Z'),
      lat: -42.737,
      lon: 173.054,
      depthKm: 15,
      magnitude: 7.8,
    },
  },
  {
    id: 'christchurch-2011',
    mseed: 'christchurch-2011_hhz.mseed',
    date: '22 Feb 2011',
    region: 'Christchurch, Canterbury',
    preRollS: 42,
    event: {
      id: '2011p079088',
      name: 'Christchurch M6.2 — 22 Feb 2011',
      originTimeMs: Date.parse('2011-02-21T23:51:42Z'),
      lat: -43.58,
      lon: 172.68,
      depthKm: 5,
      magnitude: 6.2,
    },
  },
  {
    id: 'darfield-2010',
    mseed: 'darfield-2010_hhz.mseed',
    date: '4 Sep 2010',
    region: 'Darfield, Canterbury',
    preRollS: 46,
    event: {
      id: '3366146',
      name: 'Darfield M7.1 — 4 Sep 2010',
      originTimeMs: Date.parse('2010-09-03T16:35:46Z'),
      lat: -43.53,
      lon: 172.12,
      depthKm: 11,
      magnitude: 7.1,
    },
  },
  {
    id: 'dusky-sound-2009',
    mseed: 'dusky-sound-2009_hhz.mseed',
    date: '15 Jul 2009',
    region: 'Dusky Sound, Fiordland',
    preRollS: 29,
    event: {
      id: '3124785',
      name: 'Dusky Sound M7.8 — 15 Jul 2009',
      originTimeMs: Date.parse('2009-07-15T09:22:29Z'),
      lat: -45.76,
      lon: 166.56,
      depthKm: 12,
      magnitude: 7.8,
    },
  },
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
} {
  const startMs = cfg.event.originTimeMs - cfg.preRollS * 1000;
  const endMs = startMs + DURATION_S * 1000;
  const sampleCount = DURATION_S * OUTPUT_RATE_HZ;
  const baselineEndMs = cfg.event.originTimeMs - 5000;

  const buf = readFileSync(`${RAW_DIR}/${cfg.mseed}`);
  const traces = mergeRecords(parseMiniseed(buf, {validateSteim: true}));
  const byStation = new Map(traces.map(t => [t.station, t]));

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
  return {dataset, recording: sensors.filter(s => s.hasData).length};
}

function main(): void {
  mkdirSync(EVENTS_DIR, {recursive: true});
  const catalog: Catalog = {events: []};

  for (const cfg of EVENTS) {
    if (!existsSync(`${RAW_DIR}/${cfg.mseed}`)) {
      console.warn(`skip ${cfg.id}: missing data-raw/${cfg.mseed}`);
      continue;
    }
    const {dataset, recording} = buildEvent(cfg);
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
        `${(JSON.stringify(dataset).length / 1024).toFixed(0)} KB`
    );
  }

  writeFileSync(`${OUT_DIR}/catalog.json`, JSON.stringify(catalog, null, 2));
  console.log(`catalog.json: ${catalog.events.length} events`);
}

main();
