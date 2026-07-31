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
import faultsJson from './geo/nz-faults.json';
import type {
  Catalog,
  CatalogEntry,
  Coastline,
  EventInfoMap,
  Fault,
  FaultNetwork,
  SensorTrace,
  ShakeDataset,
} from './data/types';
import {
  computeBounds,
  padBounds,
  createProjector,
  type LngLat,
  type Projector,
} from './geo/projection';
import {haversineKm, nearestTo, wavefrontRing} from './geo/distance';
import {GEOLOGY_REGIONS} from './geo/geology';
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
  type GeologyShape,
} from './render/renderer';
import {renderTraceStrip} from './render/traceStrip';
import {PlaybackClock, SPEED_PRESETS} from './playback/clock';

const coastline = coastlineJson as unknown as Coastline;
const faults = faultsJson as unknown as FaultNetwork;
const INITIAL_SPEED = 1;

// Well-known reference earthquakes shown alongside the catalogue in the
// "how it compares" magnitude chart (moment magnitudes).
const REFERENCE_QUAKES: ReadonlyArray<{label: string; mag: number}> = [
  {label: 'Napier, 1931', mag: 7.8},
  {label: 'Tōhoku, Japan 2011', mag: 9.1},
];

// GEM slip-type codes → plain-language descriptions for fault tooltips.
const SLIP_TYPE_TEXT: Record<string, string> = {
  Dextral: 'right-lateral strike-slip fault',
  Sinistral: 'left-lateral strike-slip fault',
  Reverse: 'reverse (thrust) fault',
  Normal: 'normal (extensional) fault',
  'Dextral-Reverse': 'right-lateral strike-slip fault with reverse motion',
  'Reverse-Dextral': 'reverse fault with right-lateral motion',
  'Dextral-Normal': 'right-lateral strike-slip fault with normal motion',
  'Normal-Dextral': 'normal fault with right-lateral motion',
  Subduction_Thrust: 'subduction thrust',
  Spreading_Ridge: 'spreading ridge',
  Dextral_Transform: 'right-lateral transform fault',
};

// Curated one-line overviews for the iconic faults, keyed by the first word of
// the fault name. Faults without an entry fall back to a slip-type description.
const FAULT_NOTES: Record<string, {title: string; blurb: string}> = {
  Alpine: {
    title: 'Alpine Fault',
    blurb:
      "The boundary between the Pacific and Australian plates down the spine of the South Island — New Zealand's longest onland fault and its single biggest earthquake hazard.",
  },
  Hope: {
    title: 'Hope Fault',
    blurb:
      'One of the fastest-slipping faults in the country, running from the Southern Alps into Marlborough; part of the Marlborough Fault System.',
  },
  Wellington: {
    title: 'Wellington Fault',
    blurb:
      'Runs straight through the capital and the Hutt Valley — a major hazard for Wellington, capable of roughly a magnitude 7.5 quake.',
  },
  Wairarapa: {
    title: 'Wairarapa Fault',
    blurb:
      "Ruptured in New Zealand's largest historical earthquake, the 1855 M8.2 Wairarapa quake, which lifted the Wellington coastline.",
  },
  Wairau: {
    title: 'Wairau Fault',
    blurb:
      'The north-eastern continuation of the Alpine Fault into Marlborough, running along the Wairau Valley.',
  },
  Awatere: {
    title: 'Awatere Fault',
    blurb:
      'A major Marlborough Fault System strand; its north-east section ruptured in the 1848 Marlborough earthquake.',
  },
  AwatereNortheast: {
    title: 'Awatere Fault',
    blurb:
      'A major Marlborough Fault System strand; its north-east section ruptured in the 1848 Marlborough earthquake.',
  },
  Clarence: {
    title: 'Clarence Fault',
    blurb:
      'One of the four main Marlborough Fault System faults, linking the Hope and Awatere systems.',
  },
  Kekerengu: {
    title: 'Kekerengu Fault',
    blurb:
      'Ruptured spectacularly in the 2016 Kaikōura earthquake, tearing the ground by up to 10 m near the coast.',
  },
  Hikurangi: {
    title: 'Hikurangi margin faults',
    blurb:
      'Faults above the Hikurangi subduction zone off the east coast of the North Island, where the Pacific Plate dives beneath New Zealand.',
  },
};
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

  // Editorial per-event content (descriptions, images, links). Optional — the
  // panel degrades gracefully to the computed facts if it can't be loaded.
  const eventInfo: EventInfoMap = await fetch(`${DATA_BASE}event-info.json`)
    .then(r => (r.ok ? (r.json() as Promise<EventInfoMap>) : {}))
    .catch(() => ({}));

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

  // ---- Fault hover tooltip (name + overview) ----
  const faultTip = el('fault-tip');
  const faultTipTitle = el('fault-tip-title');
  const faultTipBlurb = el('fault-tip-blurb');
  const faultTipMeta = el('fault-tip-meta');
  const FAULT_HIT_PX = 6;
  let hoveredFault = -1;

  // ---- Per-event state, replaced on every loadEvent() ----
  let dataset: ShakeDataset | null = null;
  let bounds = {minLon: 0, maxLon: 1, minLat: 0, maxLat: 1};
  let scene: Scene = {
    width: 0,
    height: 0,
    coastline: [],
    faults: [],
    sensors: [],
    epicenter: null,
    geology: [],
  };
  // Seismogram of the station nearest the epicentre, shown in the timeline.
  let traceSamples: readonly number[] = [];
  let traceScale = 1;
  // Uniform normalisation across the network (per-station mode was removed).
  const normalisation: Normalisation = 'uniform';
  let amplitudeMode: AmplitudeMode = 'envelope';
  // Precomputed shaking envelope per sensor (parallel to dataset.sensors).
  let envelopes: number[][] = [];
  // Current projector (kept so wavefronts can be projected each frame).
  let projector: Projector | null = null;
  let showWaves = true;
  // Optional major-faults overlay (off by default).
  let showFaults = false;
  // Optional bedrock-geology overlay (off by default).
  let showGeology = false;
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
      return {
        width,
        height,
        coastline: [],
        faults: [],
        sensors: [],
        epicenter: null,
        geology: [],
      };
    const projectedCoast = coastline.rings.map(ring =>
      ring.map(([lon, lat]) => projector.project({lat, lon}))
    );
    const projectedFaults = faults.faults.map(f =>
      f.coords.map(([lon, lat]) => projector.project({lat, lon}))
    );
    const geology: GeologyShape[] = GEOLOGY_REGIONS.map(region => {
      const ring = region.ring.map(([lon, lat]) =>
        projector.project({lat, lon})
      );
      // Label anchor = centroid in screen space (safe across the antimeridian).
      const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
      return {
        category: region.category,
        label: region.label,
        ring,
        labelAt: {x: cx, y: cy},
      };
    });
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
    return {
      width,
      height,
      coastline: projectedCoast,
      faults: projectedFaults,
      sensors,
      epicenter: epi,
      geology,
    };
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
      showFaults,
      wavefronts: computeWavefronts(elapsedSec),
      showGeology,
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
    hideFaultTip();
    drawMap();
  };

  const layoutTrace = (): void => {
    sizeCanvas(traceCanvas, traceCtx);
    drawTrace();
  };

  // ---- "About this earthquake" info panel ----
  const infoBody = el('event-info-body');
  const infoPanel = el('event-info');
  const infoToggle = el<HTMLButtonElement>('event-info-toggle');

  const makeEl = (
    tag: string,
    className?: string,
    text?: string
  ): HTMLElement => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Short place label from a catalogue name like "Kaikōura M7.8 — 14 Nov 2016".
  const placeLabel = (name: string): string => name.split(/\s+M\d/)[0].trim();

  // Human-friendly rounding for the energy-ratio readout.
  const niceRatio = (r: number): string => {
    if (r < 10) return String(Math.round(r));
    if (r < 100) return String(Math.round(r / 10) * 10);
    if (r < 1000) return String(Math.round(r / 50) * 50);
    return String(Math.round(r / 500) * 500);
  };

  const buildComparison = (entry: CatalogEntry, mag: number): HTMLElement => {
    const section = makeEl('div');
    section.appendChild(
      makeEl('p', 'ei-section-label', 'How it compares (magnitude)')
    );

    const rows = [
      ...catalog.events.map(e => ({
        label: placeLabel(e.name) + (e.id === entry.id ? ' — this quake' : ''),
        mag: e.magnitude,
        current: e.id === entry.id,
      })),
      ...REFERENCE_QUAKES.map(r => ({
        label: r.label,
        mag: r.mag,
        current: false,
      })),
    ].sort((a, b) => b.mag - a.mag);

    const mags = rows.map(r => r.mag);
    const lo = Math.min(...mags) - 0.4;
    const hi = Math.max(...mags) + 0.05;
    const bars = makeEl('div', 'ei-bars');
    for (const row of rows) {
      const r = makeEl('div', `ei-bar-row${row.current ? ' current' : ''}`);
      const label = makeEl('div', 'ei-bar-label');
      label.appendChild(makeEl('span', undefined, row.label));
      label.appendChild(makeEl('span', 'mag-val', `M${row.mag.toFixed(1)}`));
      const track = makeEl('div', 'ei-bar-track');
      const fill = makeEl('div', 'ei-bar-fill');
      const frac = Math.max(0.02, Math.min(1, (row.mag - lo) / (hi - lo)));
      fill.style.width = `${(frac * 100).toFixed(1)}%`;
      track.appendChild(fill);
      r.appendChild(label);
      r.appendChild(track);
      bars.appendChild(r);
    }
    section.appendChild(bars);

    // Energy relative to a magnitude-6 quake: ~10^(1.5·ΔM) per magnitude unit.
    const ratio = Math.pow(10, 1.5 * (mag - 6));
    const energy = makeEl('p', 'ei-energy');
    energy.append(
      `A magnitude ${mag.toFixed(1)} quake releases about `,
      makeEl('strong', undefined, `${niceRatio(ratio)}×`),
      ' the energy of a magnitude-6 quake. Each step up the scale is roughly 32× more energy.'
    );
    section.appendChild(energy);
    return section;
  };

  const renderEventInfo = (entry: CatalogEntry, ds: ShakeDataset): void => {
    const info = eventInfo[entry.id];
    while (infoBody.firstChild) infoBody.removeChild(infoBody.firstChild);

    infoBody.appendChild(makeEl('p', 'ei-name', entry.region));

    const chips = makeEl('div', 'ei-chips');
    chips.appendChild(
      makeEl('span', 'ei-chip mag', `M${ds.event.magnitude.toFixed(1)}`)
    );
    chips.appendChild(
      makeEl('span', 'ei-chip', `${Math.round(ds.event.depthKm)} km deep`)
    );
    chips.appendChild(makeEl('span', 'ei-chip', entry.date));
    infoBody.appendChild(chips);

    if (info?.image) {
      const fig = makeEl('figure', 'ei-figure');
      const img = document.createElement('img');
      img.src = info.image.src;
      img.alt = info.image.alt;
      img.loading = 'lazy';
      // A broken image link shouldn't leave an empty box.
      img.addEventListener('error', () => fig.remove());
      fig.appendChild(img);
      const credit = makeEl('figcaption', 'ei-credit');
      const link = document.createElement('a');
      link.href = info.image.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${info.image.credit} · ${info.image.license}`;
      credit.append('Photo: ', link);
      fig.appendChild(credit);
      infoBody.appendChild(fig);
    }

    if (info?.summary) {
      infoBody.appendChild(makeEl('p', 'ei-summary', info.summary));
    }

    if (info?.quickFacts?.length) {
      const facts = makeEl('ul', 'ei-facts');
      for (const f of info.quickFacts)
        facts.appendChild(makeEl('li', undefined, f));
      infoBody.appendChild(facts);
    }

    infoBody.appendChild(buildComparison(entry, ds.event.magnitude));

    if (info?.links?.length) {
      infoBody.appendChild(makeEl('p', 'ei-section-label', 'Learn more'));
      const links = makeEl('ul', 'ei-links');
      for (const l of info.links) {
        const li = makeEl('li');
        const a = document.createElement('a');
        a.href = l.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = l.label;
        li.appendChild(a);
        links.appendChild(li);
      }
      infoBody.appendChild(links);
    }
  };

  infoToggle.addEventListener('click', () => {
    const collapsed = infoPanel.classList.toggle('collapsed');
    infoToggle.setAttribute('aria-expanded', String(!collapsed));
    infoToggle.textContent = collapsed ? '+' : '–';
    infoToggle.title = collapsed ? 'Show panel' : 'Hide panel';
  });

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
    renderEventInfo(entry, dataset);

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

  // ---- Fault hover: name + overview over the map (only when faults shown) ----
  // Squared distance from point (px,py) to segment (ax,ay)-(bx,by).
  const distSqToSegment = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return (px - cx) ** 2 + (py - cy) ** 2;
  };

  const findFaultAt = (cssX: number, cssY: number): number => {
    let best = -1;
    let bestDist = FAULT_HIT_PX * FAULT_HIT_PX;
    for (let i = 0; i < scene.faults.length; i++) {
      const line = scene.faults[i];
      for (let j = 1; j < line.length; j++) {
        const d = distSqToSegment(
          cssX,
          cssY,
          line[j - 1].x,
          line[j - 1].y,
          line[j].x,
          line[j].y
        );
        if (d <= bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    return best;
  };

  const faultOverview = (f: Fault): {title: string; blurb: string} => {
    const base = f.name.split(/\s+/)[0];
    const note = FAULT_NOTES[base];
    if (note) return note;
    const kind = SLIP_TYPE_TEXT[f.slipType] ?? 'active fault';
    const title = f.name.replace(/\s+\d+$/, '');
    const blurb = `A ${kind} in New Zealand's active fault network.`;
    return {title, blurb};
  };

  const positionFaultTip = (cssX: number, cssY: number): void => {
    const off = 14;
    const w = faultTip.offsetWidth;
    const h = faultTip.offsetHeight;
    let left = cssX + off;
    let top = cssY + off;
    if (left + w > scene.width - 4) left = cssX - w - off;
    if (left < 4) left = 4;
    if (top + h > scene.height - 4) top = cssY - h - off;
    if (top < 4) top = 4;
    faultTip.style.left = `${left}px`;
    faultTip.style.top = `${top}px`;
  };

  const showFaultTip = (index: number, cssX: number, cssY: number): void => {
    const f = faults.faults[index];
    if (!f) return;
    if (index !== hoveredFault) {
      hoveredFault = index;
      const {title, blurb} = faultOverview(f);
      faultTipTitle.textContent = title;
      faultTipBlurb.textContent = blurb;
      const kind = SLIP_TYPE_TEXT[f.slipType] ?? 'active fault';
      const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
      faultTipMeta.textContent = `${cap} · slips ~${f.slipRate} mm/yr`;
      faultTip.hidden = false;
    }
    positionFaultTip(cssX, cssY);
  };

  const hideFaultTip = (): void => {
    if (hoveredFault < 0) return;
    hoveredFault = -1;
    faultTip.hidden = true;
  };

  mapCanvas.addEventListener('pointermove', ev => {
    if (ev.pointerType === 'touch') return;
    const rect = mapCanvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;

    // Sensors take priority; faults are the background layer.
    const sensor = findSensorAt(cx, cy);
    if (sensor) {
      if (sensor !== hoveredSensor) showTip(sensor);
      else positionTip(sensor);
      hideFaultTip();
      mapCanvas.style.cursor = 'pointer';
      return;
    }
    hideTip();

    const faultIdx = showFaults ? findFaultAt(cx, cy) : -1;
    if (faultIdx >= 0) {
      showFaultTip(faultIdx, cx, cy);
      mapCanvas.style.cursor = 'pointer';
    } else {
      hideFaultTip();
      mapCanvas.style.cursor = 'default';
    }
  });
  mapCanvas.addEventListener('pointerleave', () => {
    hideTip();
    hideFaultTip();
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

  // ---- Loop + amplitude mode ----
  el<HTMLInputElement>('loop-toggle').addEventListener('change', ev => {
    clock.setLoop((ev.target as HTMLInputElement).checked);
  });
  el<HTMLSelectElement>('amp-mode').addEventListener('change', ev => {
    amplitudeMode = (ev.target as HTMLSelectElement).value as AmplitudeMode;
    drawMap();
  });
  el<HTMLInputElement>('waves-toggle').addEventListener('change', ev => {
    showWaves = (ev.target as HTMLInputElement).checked;
    drawMap();
  });
  el<HTMLInputElement>('faults-toggle').addEventListener('change', ev => {
    showFaults = (ev.target as HTMLInputElement).checked;
    el('legend-faults').hidden = !showFaults;
    if (!showFaults) hideFaultTip();
    drawMap();
  });
  const geoLegend = el('geo-legend');
  el<HTMLInputElement>('geology-toggle').addEventListener('change', ev => {
    showGeology = (ev.target as HTMLInputElement).checked;
    geoLegend.hidden = !showGeology;
    drawMap();
  });

  // ---- Info dialogs ("How it works", "Credits") ----
  const wireDialog = (dialogId: string, openId: string, closeId: string) => {
    const dialog = el<HTMLDialogElement>(dialogId);
    const panel = dialog.querySelector<HTMLElement>('.how-panel');
    el(openId).addEventListener('click', () => dialog.showModal());
    el(closeId).addEventListener('click', () => dialog.close());
    // Click on the dim backdrop (outside the panel) closes the dialog.
    dialog.addEventListener('click', ev => {
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      const outside =
        ev.clientX < r.left ||
        ev.clientX > r.right ||
        ev.clientY < r.top ||
        ev.clientY > r.bottom;
      if (outside) dialog.close();
    });
    return dialog;
  };
  const howDialog = wireDialog('how-dialog', 'how-btn', 'how-close');
  const creditsDialog = wireDialog(
    'credits-dialog',
    'credits-btn',
    'credits-close'
  );

  // ---- Spacebar toggles playback (unless typing in a control or in a dialog) ----
  window.addEventListener('keydown', ev => {
    const dialogOpen = howDialog.open || creditsDialog.open;
    if (ev.code === 'Space' && ev.target !== select && !dialogOpen) {
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
