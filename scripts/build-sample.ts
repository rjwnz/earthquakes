/**
 * Build the checked-in sample dataset from the real EarthScope miniSEED grabbed
 * for the 2016 Kaikōura earthquake.
 *
 * Input:  data-raw/kaikoura_hhz.mseed   (NZ backbone HHZ, 11:02–11:10 UTC)
 * Output: public/data/event.json        (a {@link ShakeDataset})
 *
 * This is the small, offline-friendly dataset the app ships with so it runs
 * immediately. The full dense dataset comes from `scripts/fetch-data.ts`
 * (the GeoNet AWS Open Data pipeline), which emits the same JSON shape.
 *
 *   npm run build-sample
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseMiniseed, mergeRecords, type Trace} from '../src/data/miniseed';
import {robustMaxAbs} from '../src/data/amplitude';
import {estimateBaseline, resampleBoxAverage} from '../src/data/resample';
import type {ShakeDataset, SensorTrace, EventMeta} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const INPUT = root + 'data-raw/kaikoura_hhz.mseed';
const OUTPUT_DIR = root + 'public/data';
const OUTPUT = OUTPUT_DIR + '/event.json';

/** The 11 GeoNet backbone broadband sites, with reference coordinates. */
const STATIONS: Array<{code: string; name: string; lat: number; lon: number}> = [
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

const EVENT: EventMeta = {
  id: '2016p858000',
  name: 'Kaikōura M7.8 — 14 Nov 2016',
  originTimeMs: Date.parse('2016-11-13T11:02:56Z'),
  lat: -42.737,
  lon: 173.054,
  depthKm: 15,
  magnitude: 7.8,
};

// Common playback grid.
const START_MS = Date.parse('2016-11-13T11:02:00Z');
const DURATION_S = 480;
const OUTPUT_RATE_HZ = 20;
const STEP_MS = 1000 / OUTPUT_RATE_HZ;
const SAMPLE_COUNT = DURATION_S * OUTPUT_RATE_HZ;
const END_MS = START_MS + DURATION_S * 1000;
// Pre-origin quiet window used to estimate and remove each trace's DC baseline.
const BASELINE_END_MS = EVENT.originTimeMs - 5000;

/**
 * Resample a trace onto the common grid (anti-aliased box average) and remove
 * the pre-origin DC baseline, rounding to integer counts.
 */
function resample(trace: Trace): number[] {
  const {samples, startTimeMs, sampleRateHz} = trace;
  const baseline = estimateBaseline(
    samples,
    startTimeMs,
    sampleRateHz,
    START_MS,
    BASELINE_END_MS
  );
  const grid = resampleBoxAverage(
    samples,
    startTimeMs,
    sampleRateHz,
    START_MS,
    OUTPUT_RATE_HZ,
    SAMPLE_COUNT
  );
  return grid.map(v => Math.round(v - baseline));
}

function main(): void {
  const buf = readFileSync(INPUT);
  const traces = mergeRecords(parseMiniseed(buf, {validateSteim: true}));
  const byStation = new Map(traces.map(t => [t.station, t]));

  const sensors: SensorTrace[] = STATIONS.map(s => {
    const trace = byStation.get(s.code);
    if (!trace) {
      return {...s, samples: [], hasData: false, scale: 0};
    }
    const samples = resample(trace);
    return {...s, samples, hasData: true, scale: robustMaxAbs(samples, 0.995)};
  });

  // Global robust amplitude scale across every recorded trace.
  const all: number[] = [];
  for (const s of sensors) if (s.hasData) all.push(...s.samples);
  const amplitudeScale = Math.max(1, robustMaxAbs(all, 0.995));

  const dataset: ShakeDataset = {
    event: EVENT,
    network: 'NZ',
    startMs: START_MS,
    endMs: END_MS,
    sampleRateHz: OUTPUT_RATE_HZ,
    units: 'counts (uncorrected broadband velocity)',
    amplitudeScale,
    sensors,
  };

  mkdirSync(OUTPUT_DIR, {recursive: true});
  writeFileSync(OUTPUT, JSON.stringify(dataset));
  const withData = sensors.filter(s => s.hasData).length;
  console.log(
    `Sample: ${sensors.length} sensors (${withData} with data), ` +
      `${SAMPLE_COUNT} samples each @ ${OUTPUT_RATE_HZ} Hz, ` +
      `scale=${amplitudeScale}, ${(JSON.stringify(dataset).length / 1024).toFixed(0)} KB`
  );
}

main();
