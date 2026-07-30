/**
 * Render a static SVG snapshot of the map + bottom trace strip at a chosen time,
 * using the same projection / amplitude / envelope code the live app uses.
 * Handy for a visual sanity check without a browser, and as a preview image.
 *
 *   npx tsx scripts/render-snapshot.ts [eventId] [secondsAfterOrigin] [out.svg]
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
import {networkEnvelope, peakBins} from '../src/data/envelope';
import type {Coastline, ShakeDataset} from '../src/data/types';

const root = fileURLToPath(new URL('..', import.meta.url));
const coastline = JSON.parse(
  readFileSync(root + 'src/geo/nz-coastline.json', 'utf8')
) as Coastline;

const eventId = process.argv[2] ?? 'kaikoura-2016';
const secondsAfterOrigin = Number(process.argv[3] ?? 120);
const outPath = process.argv[4] ?? root + 'docs/snapshot.svg';
const dataset = JSON.parse(
  readFileSync(`${root}public/data/events/${eventId}.json`, 'utf8')
) as ShakeDataset;

const W = 760;
const MAP_H = 900;
const TRACE_H = 96;
const H = MAP_H + TRACE_H;
const PAD = 28;

const extent: LngLat[] = [
  ...coastline.rings.flatMap(r => r.map(([lon, lat]) => ({lat, lon}))),
  ...dataset.sensors.map(s => ({lat: s.lat, lon: s.lon})),
];
const projector = createProjector(padBounds(computeBounds(extent), 0.04), {
  width: W,
  height: MAP_H,
  padding: PAD,
});

const currentMs = dataset.event.originTimeMs + secondsAfterOrigin * 1000;
const durationMs = dataset.endMs - dataset.startMs;
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
    const amp = sampleTraceAt(
      s.samples,
      dataset.startMs,
      dataset.sampleRateHz,
      currentMs
    );
    const {radius, filled} = amplitudeToCircle(amp, {...style, scale: s.scale});
    const attrs = filled
      ? 'fill="#fff"'
      : 'fill="none" stroke="#fff" stroke-width="1.6"';
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius.toFixed(1)}" ${attrs}/>`;
  })
  .join('\n');

const epi = projector.project({lat: dataset.event.lat, lon: dataset.event.lon});
const epicentre =
  '<g stroke="rgba(255,255,255,0.85)" stroke-width="1.4" fill="none">' +
  `<circle cx="${epi.x.toFixed(1)}" cy="${epi.y.toFixed(1)}" r="7"/>` +
  `<line x1="${(epi.x - 11).toFixed(1)}" y1="${epi.y.toFixed(1)}" x2="${(epi.x + 11).toFixed(1)}" y2="${epi.y.toFixed(1)}"/>` +
  `<line x1="${epi.x.toFixed(1)}" y1="${(epi.y - 11).toFixed(1)}" x2="${epi.x.toFixed(1)}" y2="${(epi.y + 11).toFixed(1)}"/></g>`;

// ---- Bottom trace strip: network shaking envelope + playhead ----
const sampleCount = Math.round((durationMs / 1000) * dataset.sampleRateHz);
const envelope = networkEnvelope(dataset.sensors, sampleCount);
const cols = W;
const bins = peakBins(envelope, cols);
const stripTop = MAP_H + 8;
const stripH = TRACE_H - 16;
const baseY = stripTop + stripH;
let envPath = `M0 ${baseY.toFixed(1)}`;
for (let x = 0; x < cols; x++)
  envPath += ` L${x} ${(baseY - bins[x] * stripH).toFixed(1)}`;
envPath += ` L${cols - 1} ${baseY.toFixed(1)} Z`;
const posFrac = (currentMs - dataset.startMs) / durationMs;
const originFrac = (dataset.event.originTimeMs - dataset.startMs) / durationMs;
const playX = (posFrac * W).toFixed(1);
const originX = (originFrac * W).toFixed(1);
const strip =
  `<path d="${envPath}" fill="rgba(255,255,255,0.42)"/>` +
  `<line x1="${originX}" y1="${stripTop}" x2="${originX}" y2="${baseY}" stroke="rgba(255,255,255,0.45)" stroke-width="1" stroke-dasharray="3 3"/>` +
  `<line x1="${playX}" y1="${(stripTop - 6).toFixed(1)}" x2="${playX}" y2="${baseY}" stroke="#fff" stroke-width="1.5"/>` +
  `<text x="20" y="${(stripTop - 10).toFixed(0)}" fill="#9a9aa2" font-family="sans-serif" font-size="11">network shaking over time · click/drag to scrub</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#000"/>
<text x="20" y="34" fill="#fff" font-family="sans-serif" font-size="20" font-weight="600">+${secondsAfterOrigin.toFixed(0)} s</text>
<text x="20" y="54" fill="#9a9aa2" font-family="sans-serif" font-size="12">${dataset.event.name}</text>
${paths}
${circles}
${epicentre}
${strip}
</svg>`;

writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (${eventId}, t = +${secondsAfterOrigin}s)`);
