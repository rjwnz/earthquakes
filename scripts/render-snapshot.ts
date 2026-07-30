/**
 * Render a static SVG snapshot of the map at a chosen time, using the very same
 * projection / amplitude code the live app uses. Handy for a visual sanity check
 * without a browser, and as a preview image.
 *
 *   npx tsx scripts/render-snapshot.ts [secondsAfterOrigin] [out.svg]
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
} from '../src/geo/projection';
import {sampleTraceAt, amplitudeToCircle} from '../src/data/amplitude';
import type {Coastline, ShakeDataset} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const coastline = JSON.parse(
  readFileSync(root + 'src/geo/nz-coastline.json', 'utf8')
) as Coastline;
const dataset = JSON.parse(
  readFileSync(root + 'public/data/event.json', 'utf8')
) as ShakeDataset;

const secondsAfterOrigin = Number(process.argv[2] ?? 90);
const outPath = process.argv[3] ?? root + 'docs/snapshot.svg';
const W = 760;
const H = 1000;
const PAD = 28;

const extent: LngLat[] = [
  ...coastline.rings.flatMap(r => r.map(([lon, lat]) => ({lat, lon}))),
  ...dataset.sensors.map(s => ({lat: s.lat, lon: s.lon})),
];
const projector = createProjector(padBounds(computeBounds(extent), 0.04), {
  width: W,
  height: H,
  padding: PAD,
});

const currentMs = dataset.event.originTimeMs + secondsAfterOrigin * 1000;
const style = {minRadius: 1.6, maxRadius: 24, gamma: 0.6};

const paths = coastline.rings
  .map(ring => {
    const d = ring
      .map(([lon, lat], i) => {
        const p = projector.project({lat, lon});
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      })
      .join(' ');
    return `<path d="${d}Z" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>`;
  })
  .join('\n');

const circles = dataset.sensors
  .map(s => {
    const p = projector.project({lat: s.lat, lon: s.lon});
    if (!s.hasData) {
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.6" fill="rgba(255,255,255,0.28)"/>`;
    }
    const amp = sampleTraceAt(s.samples, dataset.startMs, dataset.sampleRateHz, currentMs);
    const {radius, filled} = amplitudeToCircle(amp, {...style, scale: s.scale});
    const attrs = filled
      ? 'fill="#fff"'
      : 'fill="none" stroke="#fff" stroke-width="1.6"';
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius.toFixed(1)}" ${attrs}/>`;
  })
  .join('\n');

const epi = projector.project({lat: dataset.event.lat, lon: dataset.event.lon});
const epicentre =
  `<g stroke="rgba(255,255,255,0.85)" stroke-width="1.4" fill="none">` +
  `<circle cx="${epi.x.toFixed(1)}" cy="${epi.y.toFixed(1)}" r="7"/>` +
  `<line x1="${(epi.x - 11).toFixed(1)}" y1="${epi.y.toFixed(1)}" x2="${(epi.x + 11).toFixed(1)}" y2="${epi.y.toFixed(1)}"/>` +
  `<line x1="${epi.x.toFixed(1)}" y1="${(epi.y - 11).toFixed(1)}" x2="${epi.x.toFixed(1)}" y2="${(epi.y + 11).toFixed(1)}"/></g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#000"/>
<text x="20" y="34" fill="#fff" font-family="sans-serif" font-size="20" font-weight="600">+${secondsAfterOrigin.toFixed(0)} s</text>
<text x="20" y="54" fill="#9a9aa2" font-family="sans-serif" font-size="12">${dataset.event.name}</text>
${paths}
${circles}
${epicentre}
</svg>`;

writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (t = +${secondsAfterOrigin}s)`);
