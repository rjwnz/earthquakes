/**
 * Build a light, bundle-ready set of New Zealand's major active faults.
 *
 * Input:  data-raw/gem_active_faults.geojson
 *         (the GEM Global Active Faults Database, harmonized GeoJSON — GNS-derived
 *          for NZ, licensed CC BY-SA 4.0. Fetch with:
 *            curl -sSL -o data-raw/gem_active_faults.geojson \
 *              https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults_harmonized.geojson)
 * Output: src/geo/nz-faults.json   ({lines: [[ [lon,lat], ... ], ...]})
 *
 * We keep named faults that lie in the New Zealand region and whose mean net
 * slip rate is at least SLIP_RATE_MIN mm/yr — i.e. the major, fast-moving,
 * upper-crustal faults (Alpine, Hope, Wellington, Wairarapa, Wairau, Awatere,
 * Clarence, Kekerengu, …) — then thin each trace with Douglas–Peucker. Run with:
 *
 *   npm run build-faults
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {simplify, type Pt} from '../src/geo/simplify';
import {wrapLongitude} from '../src/geo/projection';
import type {Fault, FaultNetwork, Ring} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const INPUT = root + 'data-raw/gem_active_faults.geojson';
const OUTPUT = root + 'src/geo/nz-faults.json';

// NZ region in wrapped-longitude space (matches build-coastline).
const LON_MIN = 164;
const LON_MAX = 186;
const LAT_MIN = -48.5;
const LAT_MAX = -33.5;
// Keep only faster-slipping faults so the overlay reads as "major faults".
const SLIP_RATE_MIN = 4; // mm/yr
const SIMPLIFY_TOLERANCE_DEG = 0.01; // ~1 km

function inNzRegion(lon: number, lat: number): boolean {
  const w = wrapLongitude(lon);
  return w >= LON_MIN && w <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX;
}

/** The GEM net_slip_rate is a "(mean,min,max)" string; take the mean. */
function meanSlipRate(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const first = raw.replace(/[()]/g, '').split(',')[0];
  const n = Number.parseFloat(first);
  return Number.isFinite(n) ? n : 0;
}

interface GeoJson {
  features: Array<{
    properties: Record<string, unknown>;
    geometry: {type: string; coordinates: unknown} | null;
  }>;
}

interface RawSegment {
  name: string;
  slipType: string;
  slipRate: number;
  coords: Ring;
}

function collectSegments(geojson: GeoJson): RawSegment[] {
  const out: RawSegment[] = [];
  for (const feature of geojson.features) {
    const g = feature.geometry;
    if (!g) continue;
    const rate = meanSlipRate(feature.properties.net_slip_rate);
    if (rate < SLIP_RATE_MIN) continue;

    const p = feature.properties;
    // Require a published name — this drops the anonymous, finely-segmented
    // subduction interface and spreading ridges, leaving the named upper-crustal
    // faults that a "major faults" overlay is about.
    if (typeof p.name !== 'string' || !p.name) continue;
    const name = p.name;
    const slipType = typeof p.slip_type === 'string' ? p.slip_type : '';

    const segments: number[][][] =
      g.type === 'LineString'
        ? [g.coordinates as number[][]]
        : g.type === 'MultiLineString'
          ? (g.coordinates as number[][][])
          : [];

    for (const seg of segments) {
      // Feature-level NZ test: keep the whole segment if any vertex is in region.
      if (!seg.some(([lon, lat]) => inNzRegion(lon, lat))) continue;
      out.push({
        name,
        slipType,
        slipRate: Math.round(rate * 10) / 10,
        coords: seg.map(([lon, lat]) => [lon, lat] as [number, number]),
      });
    }
  }
  return out;
}

function main(): void {
  const geojson = JSON.parse(readFileSync(INPUT, 'utf8')) as GeoJson;
  const raw = collectSegments(geojson);

  let rawVerts = 0;
  let outVerts = 0;
  const faults: Fault[] = [];
  for (const seg of raw) {
    rawVerts += seg.coords.length;
    const simplified = simplify(seg.coords as Pt[], SIMPLIFY_TOLERANCE_DEG);
    if (simplified.length >= 2) {
      faults.push({
        name: seg.name,
        slipType: seg.slipType,
        slipRate: seg.slipRate,
        coords: simplified as Ring,
      });
      outVerts += simplified.length;
    }
  }

  const network: FaultNetwork = {faults};
  writeFileSync(OUTPUT, JSON.stringify(network));
  console.log(
    `Faults: ${faults.length} segments, ${rawVerts} → ${outVerts} vertices, ` +
      `${(JSON.stringify(network).length / 1024).toFixed(1)} KB`
  );
}

main();
