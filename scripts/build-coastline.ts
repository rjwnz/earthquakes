/**
 * Build a light, bundle-ready NZ coastline from Natural Earth's 1:50m land
 * polygons.
 *
 * Input:  data-raw/ne_50m_land.geojson  (fetched from the Natural Earth mirror)
 * Output: src/geo/nz-coastline.json     ({rings: [[ [lon,lat], ... ], ...]})
 *
 * We keep only rings that lie mostly within the New Zealand region (mainland
 * plus the Chatham Islands, the latter reached by wrapping longitudes across the
 * antimeridian) and simplify each with Douglas–Peucker. Run with:
 *
 *   npm run build-coastline
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {simplify, type Pt} from '../src/geo/simplify';
import {wrapLongitude} from '../src/geo/projection';
import type {Coastline, Ring} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const INPUT = root + 'data-raw/ne_50m_land.geojson';
const OUTPUT = root + 'src/geo/nz-coastline.json';

// NZ region in wrapped-longitude space: mainland ~166..179E, Chathams ~183.4E.
const LON_MIN = 164;
const LON_MAX = 186;
const LAT_MIN = -48.5;
const LAT_MAX = -33.5;
const SIMPLIFY_TOLERANCE_DEG = 0.015; // ~1.5 km

function inNzRegion(lon: number, lat: number): boolean {
  const w = wrapLongitude(lon);
  return w >= LON_MIN && w <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX;
}

interface GeoJson {
  features: Array<{
    geometry: {
      type: string;
      coordinates: unknown;
    } | null;
  }>;
}

function collectRings(geojson: GeoJson): Ring[] {
  const rings: Ring[] = [];
  for (const feature of geojson.features) {
    const g = feature.geometry;
    if (!g) continue;
    const polygons: number[][][][] =
      g.type === 'Polygon'
        ? [g.coordinates as number[][][]]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as number[][][][])
          : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const inside = ring.filter(([lon, lat]) => inNzRegion(lon, lat)).length;
        if (inside / ring.length > 0.5) {
          rings.push(ring.map(([lon, lat]) => [lon, lat] as [number, number]));
        }
      }
    }
  }
  return rings;
}

function main(): void {
  const geojson = JSON.parse(readFileSync(INPUT, 'utf8')) as GeoJson;
  const raw = collectRings(geojson);

  let rawVerts = 0;
  let outVerts = 0;
  const rings: Ring[] = [];
  for (const ring of raw) {
    rawVerts += ring.length;
    const simplified = simplify(ring as Pt[], SIMPLIFY_TOLERANCE_DEG);
    if (simplified.length >= 3) {
      rings.push(simplified as Ring);
      outVerts += simplified.length;
    }
  }

  const coastline: Coastline = {rings};
  writeFileSync(OUTPUT, JSON.stringify(coastline));
  console.log(
    `Coastline: ${rings.length} rings, ${rawVerts} → ${outVerts} vertices, ` +
      `${(JSON.stringify(coastline).length / 1024).toFixed(1)} KB`
  );
}

main();
