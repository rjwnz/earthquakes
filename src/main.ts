/**
 * Application entry point: load the dataset, lay out the map, and drive the
 * animation loop and controls.
 *
 * All the interesting maths lives in the unit-tested modules
 * (`geo/projection`, `data/decimate`, `data/amplitude`, `playback/clock`,
 * `render/renderer`); this file is the glue that turns them into a page.
 */
import './style.css';
import coastlineJson from './geo/nz-coastline.json';
import type {Coastline, ShakeDataset} from './data/types';
import {
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
  type Projector,
} from './geo/projection';
import {decimateByGrid, type Placed} from './data/decimate';
import {
  renderFrame,
  DEFAULT_STYLE,
  type RenderSensor,
  type Scene,
  type Normalisation,
} from './render/renderer';
import {PlaybackClock, SPEED_PRESETS} from './playback/clock';

const coastline = coastlineJson as unknown as Coastline;
const INITIAL_SPEED = 0.1;
const DECIMATION_CELL_PX = 26;
const MAP_PADDING_PX = 30;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

async function loadDataset(): Promise<ShakeDataset> {
  const url = `${import.meta.env.BASE_URL}data/event.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load dataset: ${res.status}`);
  return (await res.json()) as ShakeDataset;
}

interface PlacedSensor extends Placed {
  index: number;
}

function main(dataset: ShakeDataset): void {
  const canvas = el<HTMLCanvasElement>('map');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  el('event-name').textContent = dataset.event.name;
  const withData = dataset.sensors.filter(s => s.hasData).length;

  // Fixed geographic extent: coastline vertices ∪ sensor positions, padded.
  const extentPoints: LngLat[] = [
    ...coastline.rings.flatMap(ring => ring.map(([lon, lat]) => ({lat, lon}))),
    ...dataset.sensors.map(s => ({lat: s.lat, lon: s.lon})),
  ];
  const bounds = padBounds(computeBounds(extentPoints), 0.04);

  const durationMs = dataset.endMs - dataset.startMs;
  let scene: Scene = {width: 0, height: 0, coastline: [], sensors: [], epicenter: null};
  let normalisation: Normalisation = 'per-station';

  const buildScene = (projector: Projector, width: number, height: number): Scene => {
    const projectedCoast = coastline.rings.map(ring =>
      ring.map(([lon, lat]) => projector.project({lat, lon}))
    );

    // Decimate in screen space, preferring sensors that actually recorded data.
    const placed: PlacedSensor[] = dataset.sensors.map((s, index) => {
      const p = projector.project({lat: s.lat, lon: s.lon});
      return {x: p.x, y: p.y, index};
    });
    const clusters = decimateByGrid(placed, {
      cellSize: DECIMATION_CELL_PX,
      priority: p => (dataset.sensors[p.index].hasData ? 1 : 0),
    });

    const sensors: RenderSensor[] = clusters.map(c => {
      const s = dataset.sensors[c.representative.index];
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

    const epi = projector.project({lat: dataset.event.lat, lon: dataset.event.lon});
    el('sensor-count').textContent =
      `${sensors.length} shown · ${withData}/${dataset.sensors.length} recording · ` +
      `${dataset.network} network`;

    return {width, height, coastline: projectedCoast, sensors, epicenter: epi};
  };

  const draw = (): void => {
    renderFrame(ctx, scene, DEFAULT_STYLE, {
      startMs: dataset.startMs,
      sampleRateHz: dataset.sampleRateHz,
      globalScale: dataset.amplitudeScale,
      normalisation,
      currentTimeMs: dataset.startMs + clock.positionMs,
    });
  };

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const projector = createProjector(bounds, {
      width: rect.width,
      height: rect.height,
      padding: MAP_PADDING_PX,
    });
    scene = buildScene(projector, rect.width, rect.height);
    draw();
  };

  // ---- Playback clock ----
  const clock = new PlaybackClock(durationMs);
  clock.setSpeed(INITIAL_SPEED);
  clock.setLoop(true);

  const timeline = el<HTMLInputElement>('timeline');
  const playBtn = el<HTMLButtonElement>('play');
  const timeOrigin = el('time-origin');
  const timeUtc = el('time-utc');
  timeline.max = String(durationMs);

  const updateReadout = (): void => {
    const epoch = dataset.startMs + clock.positionMs;
    const rel = (epoch - dataset.event.originTimeMs) / 1000;
    const sign = rel >= 0 ? '+' : '−';
    timeOrigin.textContent = `${sign}${Math.abs(rel).toFixed(1)} s`;
    timeUtc.textContent = `${new Date(epoch).toISOString().slice(11, 23)} UTC · relative to origin`;
  };

  clock.onTick((pos, playing) => {
    timeline.value = String(pos);
    updateReadout();
    draw();
    if (!playing) playBtn.textContent = '▶';
  });

  playBtn.addEventListener('click', () => {
    clock.toggle();
    playBtn.textContent = clock.isPlaying ? '⏸' : '▶';
  });

  timeline.addEventListener('input', () => {
    clock.seek(Number(timeline.value));
    updateReadout();
    draw();
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

  // ---- Loop + normalisation toggles ----
  el<HTMLInputElement>('loop-toggle').addEventListener('change', ev => {
    clock.setLoop((ev.target as HTMLInputElement).checked);
  });
  el<HTMLSelectElement>('norm-toggle').addEventListener('change', ev => {
    normalisation = (ev.target as HTMLSelectElement).value as Normalisation;
    draw();
  });

  // Spacebar toggles playback.
  window.addEventListener('keydown', ev => {
    if (ev.code === 'Space') {
      ev.preventDefault();
      clock.toggle();
      playBtn.textContent = clock.isPlaying ? '⏸' : '▶';
    }
  });

  // ---- Kick off ----
  const ro = new ResizeObserver(() => resize());
  ro.observe(el('stage'));
  resize();
  updateReadout();
  clock.play();
  playBtn.textContent = '⏸';
}

loadDataset()
  .then(main)
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    el('event-name').textContent = `Error: ${msg}`;
    // eslint-disable-next-line no-console
    console.error(err);
  });
