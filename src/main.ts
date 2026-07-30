/**
 * Application entry point: load the catalogue, let the user pick an earthquake,
 * lay out the map + bottom trace scrubber, and drive the animation and controls.
 *
 * All the interesting maths lives in the unit-tested modules
 * (`geo/projection`, `data/decimate`, `data/amplitude`, `data/envelope`,
 * `playback/clock`, `render/*`); this file is the glue.
 */
import './style.css';
import coastlineJson from './geo/nz-coastline.json';
import type {Catalog, Coastline, ShakeDataset} from './data/types';
import {
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
  type Projector,
} from './geo/projection';
import {decimateByGrid, type Placed} from './data/decimate';
import {networkEnvelope} from './data/envelope';
import {
  renderFrame,
  DEFAULT_STYLE,
  type RenderSensor,
  type Scene,
  type Normalisation,
} from './render/renderer';
import {renderTraceStrip} from './render/traceStrip';
import {PlaybackClock, SPEED_PRESETS} from './playback/clock';

const coastline = coastlineJson as unknown as Coastline;
const INITIAL_SPEED = 0.1;
const DECIMATION_CELL_PX = 26;
const MAP_PADDING_PX = 30;
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

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
  let envelope: number[] = [];
  let normalisation: Normalisation = 'per-station';

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
        x: c.representative.x,
        y: c.representative.y,
        hasData: s.hasData,
        samples: s.samples,
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

  const drawMap = (): void => {
    if (!dataset) return;
    renderFrame(mapCtx, scene, DEFAULT_STYLE, {
      startMs: dataset.startMs,
      sampleRateHz: dataset.sampleRateHz,
      globalScale: dataset.amplitudeScale,
      normalisation,
      currentTimeMs: dataset.startMs + clock.positionMs,
    });
  };

  const drawTrace = (): void => {
    if (!dataset) return;
    const rect = traceCanvas.getBoundingClientRect();
    const originFrac =
      (dataset.event.originTimeMs - dataset.startMs) / durationMs();
    renderTraceStrip(traceCtx, rect.width, rect.height, {
      envelope,
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
    const projector = createProjector(bounds, {
      width: w,
      height: h,
      padding: MAP_PADDING_PX,
    });
    scene = buildScene(projector, w, h);
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
    timeUtc.textContent = `${new Date(epoch).toISOString().slice(11, 23)} UTC · relative to origin`;
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
    const sampleCount = Math.round(
      (durationMs() / 1000) * dataset.sampleRateHz
    );
    envelope = networkEnvelope(dataset.sensors, sampleCount);

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
    }
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
  el<HTMLSelectElement>('norm-toggle').addEventListener('change', ev => {
    normalisation = (ev.target as HTMLSelectElement).value as Normalisation;
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
