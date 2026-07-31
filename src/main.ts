/**
 * Application entry point: load the catalogue, let the user pick an earthquake,
 * lay out the map + bottom trace scrubber, and drive the animation and controls.
 *
 * All the interesting maths lives in the unit-tested modules
 * (`geo/projection`, `geo/distance`, `data/decimate`, `data/amplitude`,
 * `data/waveform`, `playback/clock`, `render/*`); this file is the glue.
 */
import './style.css';
import coastlineJson from './geo/nz-coastline.json';
import type {Catalog, Coastline, SensorTrace, ShakeDataset} from './data/types';
import {
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
  type Projector,
} from './geo/projection';
import {haversineKm, nearestTo, wavefrontRing} from './geo/distance';
import {decimateByGrid, type Placed} from './data/decimate';
import {robustMaxAbs} from './data/amplitude';
import {shakingEnvelope} from './data/envelope';
import {
  renderFrame,
  DEFAULT_STYLE,
  type RenderSensor,
  type Scene,
  type Normalisation,
  type AmplitudeMode,
  type Wavefronts,
} from './render/renderer';
import {renderTraceStrip} from './render/traceStrip';
import {PlaybackClock, SPEED_PRESETS} from './playback/clock';

const coastline = coastlineJson as unknown as Coastline;
const INITIAL_SPEED = 1;
const DECIMATION_CELL_PX = 26;
const MAP_PADDING_PX = 30;
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

// Seismic-wave velocities for the schematic P/S wavefronts (km/s). Representative
// crustal values; the fronts stop expanding once past the farthest detector.
const VP_KMS = 6.0;
const VS_KMS = 3.5;
const WAVE_MARGIN_KM = 60;

// Wall-clock readout in New Zealand time (DST is resolved per event date, so
// summer events read NZDT and winter events NZST).
const NZ_TIME = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

function formatNzClock(epochMs: number): string {
  const parts = NZ_TIME.formatToParts(new Date(epochMs));
  const pick = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const ms = String(Math.floor(((epochMs % 1000) + 1000) % 1000)).padStart(
    3,
    '0'
  );
  return `${pick('hour')}:${pick('minute')}:${pick('second')}.${ms} ${pick('timeZoneName')}`;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

function setupContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

interface PlacedSensor extends Placed {
  index: number;
}

async function bootstrap(): Promise<void> {
  const catalog = (await (
    await fetch(`${DATA_BASE}catalog.json`)
  ).json()) as Catalog;
  if (catalog.events.length === 0) throw new Error('Catalogue is empty');

  const mapCanvas = el<HTMLCanvasElement>('map');
  const traceCanvas = el<HTMLCanvasElement>('trace');
  const mapCtx = setupContext(mapCanvas);
  const traceCtx = setupContext(traceCanvas);

  const timeOrigin = el('time-origin');
  const timeUtc = el('time-utc');
  const playBtn = el<HTMLButtonElement>('play');

  // ---- Sensor hover tooltip (location + shortened seismogram) ----
  const tip = el('sensor-tip');
  const tipCode = el('sensor-tip-code');
  const tipName = el('sensor-tip-name');
  const tipMeta = el('sensor-tip-meta');
  const tipCanvas = el<HTMLCanvasElement>('sensor-tip-trace');
  const tipCtx = setupContext(tipCanvas);
  const TIP_TRACE_W = 202;
  const TIP_TRACE_H = 46;
  const SENSOR_HIT_PX = 14;
  {
    const dpr = window.devicePixelRatio || 1;
    tipCanvas.width = Math.round(TIP_TRACE_W * dpr);
    tipCanvas.height = Math.round(TIP_TRACE_H * dpr);
    tipCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  let hoveredSensor: RenderSensor | null = null;

  // ---- Per-event state, replaced on every loadEvent() ----
  let dataset: ShakeDataset | null = null;
  let bounds = {minLon: 0, maxLon: 1, minLat: 0, maxLat: 1};
  let scene: Scene = {
    width: 0,
    height: 0,
    coastline: [],
    sensors: [],
    epicenter: null,
  };
  // Seismogram of the station nearest the epicentre, shown in the timeline.
  let traceSamples: readonly number[] = [];
  let traceScale = 1;
  let normalisation: Normalisation = 'uniform';
  let amplitudeMode: AmplitudeMode = 'envelope';
  // Precomputed shaking envelope per sensor (parallel to dataset.sensors).
  let envelopes: number[][] = [];
  // Current projector (kept so wavefronts can be projected each frame).
  let projector: Projector | null = null;
  let showWaves = true;
  // Distance to the farthest recording sensor; the fronts stop just beyond it.
  let maxSensorKm = 0;

  const clock = new PlaybackClock(1);
  clock.setSpeed(INITIAL_SPEED);
  clock.setLoop(true);

  const durationMs = () => (dataset ? dataset.endMs - dataset.startMs : 1);

  const buildScene = (
    projector: Projector,
    width: number,
    height: number
  ): Scene => {
    if (!dataset)
      return {width, height, coastline: [], sensors: [], epicenter: null};
    const projectedCoast = coastline.rings.map(ring =>
      ring.map(([lon, lat]) => projector.project({lat, lon}))
    );
    const placed: PlacedSensor[] = dataset.sensors.map((s, index) => {
      const p = projector.project({lat: s.lat, lon: s.lon});
      return {x: p.x, y: p.y, index};
    });
    const clusters = decimateByGrid(placed, {
      cellSize: DECIMATION_CELL_PX,
      priority: p => (dataset!.sensors[p.index].hasData ? 1 : 0),
    });
    const sensors: RenderSensor[] = clusters.map(c => {
      const s = dataset!.sensors[c.representative.index];
      return {
        code: s.code,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        x: c.representative.x,
        y: c.representative.y,
        hasData: s.hasData,
        samples: s.samples,
        envelope: envelopes[c.representative.index] ?? [],
        scale: s.scale,
        count: c.count,
      };
    });
    const epi = projector.project({
      lat: dataset.event.lat,
      lon: dataset.event.lon,
    });
    const withData = dataset.sensors.filter(s => s.hasData).length;
    el('sensor-count').textContent =
      `${sensors.length} shown · ${withData}/${dataset.sensors.length} recording · ${dataset.network}`;
    return {width, height, coastline: projectedCoast, sensors, epicenter: epi};
  };

  const computeWavefronts = (elapsedSec: number): Wavefronts | null => {
    if (!dataset || !projector || !showWaves || elapsedSec <= 0) return null;
    const epi = {lat: dataset.event.lat, lon: dataset.event.lon};
    const cutoff = maxSensorKm + WAVE_MARGIN_KM;
    const proj = projector;
    const front = (km: number) =>
      km > 0 && km <= cutoff
        ? wavefrontRing(epi, km).map(p => proj.project(p))
        : null;
    return {p: front(VP_KMS * elapsedSec), s: front(VS_KMS * elapsedSec)};
  };

  const drawMap = (): void => {
    if (!dataset) return;
    const currentTimeMs = dataset.startMs + clock.positionMs;
    const elapsedSec = (currentTimeMs - dataset.event.originTimeMs) / 1000;
    renderFrame(mapCtx, scene, DEFAULT_STYLE, {
      startMs: dataset.startMs,
      sampleRateHz: dataset.sampleRateHz,
      globalScale: dataset.amplitudeScale,
      normalisation,
      amplitudeMode,
      currentTimeMs,
      wavefronts: computeWavefronts(elapsedSec),
    });
  };

  const drawTrace = (): void => {
    if (!dataset) return;
    const rect = traceCanvas.getBoundingClientRect();
    const originFrac =
      (dataset.event.originTimeMs - dataset.startMs) / durationMs();
    renderTraceStrip(traceCtx, rect.width, rect.height, {
      samples: traceSamples,
      scale: traceScale,
      positionFrac: clock.positionMs / durationMs(),
      originFrac,
    });
  };

  // Redraw the hovered sensor's mini-seismogram (playhead tracks the clock).
  const drawTip = (): void => {
    if (!hoveredSensor || !dataset) return;
    const originFrac =
      (dataset.event.originTimeMs - dataset.startMs) / durationMs();
    renderTraceStrip(tipCtx, TIP_TRACE_W, TIP_TRACE_H, {
      samples: hoveredSensor.samples,
      scale: Math.max(1, hoveredSensor.scale),
      positionFrac: clock.positionMs / durationMs(),
      originFrac,
    });
  };

  const sizeCanvas = (
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D
  ): {w: number; h: number} => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {w: rect.width, h: rect.height};
  };

  const layoutMap = (): void => {
    const {w, h} = sizeCanvas(mapCanvas, mapCtx);
    projector = createProjector(bounds, {
      width: w,
      height: h,
      padding: MAP_PADDING_PX,
    });
    scene = buildScene(projector, w, h);
    hideTip();
    drawMap();
  };

  const layoutTrace = (): void => {
    sizeCanvas(traceCanvas, traceCtx);
    drawTrace();
  };

  const updateReadout = (): void => {
    if (!dataset) return;
    const epoch = dataset.startMs + clock.positionMs;
    const rel = (epoch - dataset.event.originTimeMs) / 1000;
    const sign = rel >= 0 ? '+' : '−';
    timeOrigin.textContent = `${sign}${Math.abs(rel).toFixed(1)} s`;
    timeUtc.textContent = `${formatNzClock(epoch)} · NZ time`;
    traceCanvas.setAttribute(
      'aria-valuenow',
      String(Math.round(clock.positionMs))
    );
    traceCanvas.setAttribute(
      'aria-valuetext',
      `${sign}${Math.abs(rel).toFixed(1)} seconds from origin`
    );
  };

  clock.onTick((_pos, playing) => {
    updateReadout();
    drawMap();
    drawTrace();
    drawTip();
    if (!playing) playBtn.textContent = '▶';
  });

  const loadEvent = async (id: string): Promise<void> => {
    const entry = catalog.events.find(e => e.id === id);
    if (!entry) return;
    el('event-name').textContent = 'Loading…';
    const res = await fetch(`${DATA_BASE}${entry.file}`);
    if (!res.ok) throw new Error(`Failed to load ${entry.file}: ${res.status}`);
    dataset = (await res.json()) as ShakeDataset;

    el('event-name').textContent = `${dataset.event.name} · ${entry.region}`;

    const extent: LngLat[] = [
      ...coastline.rings.flatMap(ring =>
        ring.map(([lon, lat]) => ({lat, lon}))
      ),
      ...dataset.sensors.map(s => ({lat: s.lat, lon: s.lon})),
    ];
    bounds = padBounds(computeBounds(extent), 0.04);

    // Precompute each sensor's smoothed shaking envelope (drives circle radius
    // in envelope mode).
    const rate = dataset.sampleRateHz;
    envelopes = dataset.sensors.map(s =>
      s.hasData ? shakingEnvelope(s.samples, {sampleRateHz: rate}) : []
    );

    // Timeline shows the seismogram of the station nearest the epicentre.
    const recording = dataset.sensors.filter(s => s.hasData);
    const nearest: SensorTrace | null = nearestTo(recording, dataset.event);
    traceSamples = nearest ? nearest.samples : [];
    traceScale = nearest ? Math.max(1, robustMaxAbs(nearest.samples, 1)) : 1;
    maxSensorKm = recording.reduce(
      (m, s) => Math.max(m, haversineKm(s, dataset!.event)),
      0
    );
    const captionEl = document.getElementById('trace-caption');
    if (captionEl) {
      captionEl.textContent = nearest
        ? `${nearest.code} · nearest station, ${Math.round(
            haversineKm(nearest, dataset.event)
          )} km from epicentre — vertical ground motion · click/drag to scrub`
        : 'No recording station · click/drag to scrub';
    }

    clock.setDuration(durationMs());
    traceCanvas.setAttribute('aria-valuemax', String(Math.round(durationMs())));
    clock.seek(0);

    layoutMap();
    layoutTrace();
    updateReadout();
    clock.play();
    playBtn.textContent = '⏸';
  };

  // ---- Event picker ----
  const select = el<HTMLSelectElement>('event-select');
  for (const e of catalog.events) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => void loadEvent(select.value));

  // ---- Transport ----
  playBtn.addEventListener('click', () => {
    clock.toggle();
    playBtn.textContent = clock.isPlaying ? '⏸' : '▶';
  });

  // ---- Trace scrubbing (pointer + keyboard) ----
  const seekToClientX = (clientX: number): void => {
    const rect = traceCanvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    clock.seek(frac * durationMs());
    updateReadout();
    drawMap();
    drawTrace();
    drawTip();
  };
  let scrubbing = false;
  traceCanvas.addEventListener('pointerdown', ev => {
    scrubbing = true;
    traceCanvas.setPointerCapture(ev.pointerId);
    seekToClientX(ev.clientX);
  });
  traceCanvas.addEventListener('pointermove', ev => {
    if (scrubbing) seekToClientX(ev.clientX);
  });
  traceCanvas.addEventListener('pointerup', () => (scrubbing = false));
  traceCanvas.addEventListener('keydown', ev => {
    const step = ev.shiftKey ? 10_000 : 2_000;
    let handled = true;
    if (ev.key === 'ArrowRight') clock.seek(clock.positionMs + step);
    else if (ev.key === 'ArrowLeft') clock.seek(clock.positionMs - step);
    else if (ev.key === 'Home') clock.seek(0);
    else if (ev.key === 'End') clock.seek(durationMs());
    else handled = false;
    if (handled) {
      ev.preventDefault();
      updateReadout();
      drawMap();
      drawTrace();
      drawTip();
    }
  });

  // ---- Sensor hover: show location + shortened trace over the map ----
  const findSensorAt = (cssX: number, cssY: number): RenderSensor | null => {
    let best: RenderSensor | null = null;
    let bestDist = SENSOR_HIT_PX * SENSOR_HIT_PX;
    for (const s of scene.sensors) {
      const dx = s.x - cssX;
      const dy = s.y - cssY;
      const d = dx * dx + dy * dy;
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  };

  const positionTip = (s: RenderSensor): void => {
    const off = 16;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = s.x + off;
    let top = s.y - h - off;
    if (left + w > scene.width - 4) left = s.x - w - off;
    if (left < 4) left = 4;
    if (top < 4) top = s.y + off;
    if (top + h > scene.height - 4) top = scene.height - h - 4;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const showTip = (s: RenderSensor): void => {
    hoveredSensor = s;
    tipCode.textContent = s.code;
    tipName.textContent = s.name;
    const parts: string[] = [];
    if (dataset) {
      parts.push(
        `${Math.round(haversineKm(s, dataset.event))} km from epicentre`
      );
    }
    if (!s.hasData) parts.push('no waveform');
    if (s.count > 1) parts.push(`+${s.count - 1} nearby`);
    tipMeta.textContent = parts.join(' · ');
    tip.hidden = false;
    positionTip(s);
    drawTip();
  };

  const hideTip = (): void => {
    if (!hoveredSensor) return;
    hoveredSensor = null;
    tip.hidden = true;
  };

  mapCanvas.addEventListener('pointermove', ev => {
    if (ev.pointerType === 'touch') return;
    const rect = mapCanvas.getBoundingClientRect();
    const found = findSensorAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (found) {
      if (found !== hoveredSensor) showTip(found);
      else positionTip(found);
      mapCanvas.style.cursor = 'pointer';
    } else {
      hideTip();
      mapCanvas.style.cursor = 'default';
    }
  });
  mapCanvas.addEventListener('pointerleave', () => {
    hideTip();
    mapCanvas.style.cursor = 'default';
  });

  // ---- Speed presets ----
  const speedBox = el('speed-buttons');
  const speedButtons: HTMLButtonElement[] = SPEED_PRESETS.map(speed => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${speed}×`;
    b.addEventListener('click', () => {
      clock.setSpeed(speed);
      speedButtons.forEach(x => x.classList.toggle('active', x === b));
    });
    if (speed === INITIAL_SPEED) b.classList.add('active');
    speedBox.appendChild(b);
    return b;
  });

  // ---- Loop + normalisation ----
  el<HTMLInputElement>('loop-toggle').addEventListener('change', ev => {
    clock.setLoop((ev.target as HTMLInputElement).checked);
  });
  el<HTMLSelectElement>('amp-mode').addEventListener('change', ev => {
    amplitudeMode = (ev.target as HTMLSelectElement).value as AmplitudeMode;
    drawMap();
  });
  el<HTMLSelectElement>('norm-toggle').addEventListener('change', ev => {
    normalisation = (ev.target as HTMLSelectElement).value as Normalisation;
    drawMap();
  });
  el<HTMLInputElement>('waves-toggle').addEventListener('change', ev => {
    showWaves = (ev.target as HTMLInputElement).checked;
    drawMap();
  });

  // ---- Spacebar toggles playback (unless typing in a control) ----
  window.addEventListener('keydown', ev => {
    if (ev.code === 'Space' && ev.target !== select) {
      ev.preventDefault();
      clock.toggle();
      playBtn.textContent = clock.isPlaying ? '⏸' : '▶';
    }
  });

  // ---- Resize ----
  new ResizeObserver(() => layoutMap()).observe(el('stage'));
  new ResizeObserver(() => layoutTrace()).observe(el('trace-wrap'));

  await loadEvent(catalog.events[0].id);
}

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  el('event-name').textContent = `Error: ${msg}`;
  // eslint-disable-next-line no-console
  console.error(err);
});
