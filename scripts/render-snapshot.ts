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
import {
  sampleTraceAt,
  amplitudeToCircle,
  robustMaxAbs,
} from '../src/data/amplitude';
import {signedPeakBins} from '../src/data/waveform';
import {nearestTo} from '../src/geo/distance';
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
const style = {minRadius: 1.6, maxRadius: 22, rangeDecades: 3};

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

// ---- Bottom timeline: nearest-station seismogram, centred on zero ----
const recording = dataset.sensors.filter(s => s.hasData);
const nearest = nearestTo(recording, dataset.event);
const cols = W;
const bins = nearest ? signedPeakBins(nearest.samples, cols) : [];
const traceScale = nearest ? Math.max(1, robustMaxAbs(nearest.samples, 1)) : 1;
const stripTop = MAP_H + 12;
const stripH = TRACE_H - 20;
const midY = stripTop + stripH / 2;
const half = stripH / 2;
let wavePath = '';
for (let x = 0; x < bins.length; x++) {
  const v = Math.max(-1, Math.min(1, bins[x] / traceScale));
  wavePath += `${x === 0 ? 'M' : 'L'}${x} ${(midY - v * half).toFixed(1)} `;
}
const posFrac = (currentMs - dataset.startMs) / durationMs;
const originFrac = (dataset.event.originTimeMs - dataset.startMs) / durationMs;
const playX = (posFrac * W).toFixed(1);
const originX = (originFrac * W).toFixed(1);
const label = nearest
  ? `${nearest.code} · nearest station — vertical ground motion`
  : 'no recording station';
const strip =
  `<line x1="0" y1="${midY.toFixed(1)}" x2="${W}" y2="${midY.toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>` +
  `<path d="${wavePath}" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1"/>` +
  `<line x1="${originX}" y1="${stripTop}" x2="${originX}" y2="${(stripTop + stripH).toFixed(1)}" stroke="rgba(255,255,255,0.45)" stroke-width="1" stroke-dasharray="3 3"/>` +
  `<line x1="${playX}" y1="${(stripTop - 6).toFixed(1)}" x2="${playX}" y2="${(stripTop + stripH).toFixed(1)}" stroke="#fff" stroke-width="1.5"/>` +
  `<text x="20" y="${(stripTop - 8).toFixed(0)}" fill="#9a9aa2" font-family="sans-serif" font-size="11">${label} · click/drag to scrub</text>`;

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
