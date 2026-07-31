/**
 * Black-and-white canvas renderer.
 *
 * Draws the NZ coastline and, for each displayed sensor, a solid white disc
 * whose radius tracks the magnitude of shaking at the current playback time
 * (signed polarity lives in the bottom timeline, not the map).
 *
 * Coastline rings and sensor positions arrive already projected to screen
 * pixels (see `main.ts`); only the amplitude-driven parts change per frame, so
 * this stays cheap enough to run every animation frame.
 */
import {
  sampleTraceAt,
  amplitudeToCircle,
  perStationScale,
} from '../data/amplitude';
import {geologyCategory, type GeologyCategory} from '../geo/geology';

export interface ScreenPoint {
  x: number;
  y: number;
}

/** A bedrock province projected to screen space (see geo/geology). */
export interface GeologyShape {
  category: GeologyCategory;
  label: string;
  ring: ScreenPoint[];
  /** Where the province label is drawn (ring centroid). */
  labelAt: ScreenPoint;
}

export interface RenderSensor {
  code: string;
  /** Human-readable site name (for the hover tooltip). */
  name: string;
  /** Site latitude/longitude (for the tooltip's distance readout). */
  lat: number;
  lon: number;
  x: number;
  y: number;
  hasData: boolean;
  samples: readonly number[];
  /** Fast-attack/slow-decay amplitude envelope (see shakingEnvelope). */
  envelope: readonly number[];
  /** Per-station robust amplitude scale. */
  scale: number;
  /** Number of real sensors this representative stands in for (≥ 1). */
  count: number;
}

/**
 * How a sensor's circle radius is driven:
 *  - `envelope`: smoothed magnitude (calm; no strobing) — the default,
 *  - `instantaneous`: the raw rectified value (the literal waveform magnitude).
 */
export type AmplitudeMode = 'envelope' | 'instantaneous';

export type Normalisation = 'per-station' | 'uniform';

export interface RenderStyle {
  background: string;
  coastline: string;
  /** Sensor disc outline colour (a crisp, solid stroke). */
  sensor: string;
  /** Sensor disc fill colour — translucent so overlapping discs read clearly. */
  sensorFill: string;
  /** Sensor disc outline width in px (pre-scaled by the caller). */
  sensorStrokeWidth: number;
  restSensor: string;
  epicenter: string;
  fault: string;
  pWave: string;
  sWave: string;
  minRadius: number;
  maxRadius: number;
  /** Log dynamic range (decades) for the radius mapping; see amplitudeToCircle. */
  rangeDecades: number;
  /**
   * Floor for per-station normalisation, as a fraction of the global scale, so
   * a not-yet-reached station's noise doesn't blow up to full size.
   */
  perStationFloor: number;
  coastlineWidth: number;
  /** Line width for the optional fault overlay. */
  faultWidth: number;
  /** Opacity of the bedrock-geology overlay fills (0..1). */
  geologyFillAlpha: number;
  /**
   * Responsive size multiplier for fixed-size markers (epicentre, wavefront and
   * province labels). 1 = the reference size; `main.ts` scales it with the map's
   * on-screen size so markers stay proportional across screens. The disc radii
   * and line widths above are pre-scaled by the caller, so they are unaffected.
   */
  uiScale: number;
}

export const DEFAULT_STYLE: RenderStyle = {
  background: '#000000',
  coastline: 'rgba(255,255,255,0.5)',
  sensor: 'rgba(255,255,255,0.9)',
  sensorFill: 'rgba(255,255,255,0.22)',
  sensorStrokeWidth: 1.2,
  restSensor: 'rgba(255,255,255,0.28)',
  epicenter: 'rgba(255,255,255,0.85)',
  // A restrained warm accent — the geological convention for faults — kept
  // subtle so it reads as background context under the seismic data.
  fault: 'rgba(226,140,74,0.62)',
  pWave: 'rgba(255,255,255,0.4)',
  sWave: 'rgba(255,255,255,0.7)',
  minRadius: 1.6,
  maxRadius: 22,
  // Two decades (100× range). A wider range (e.g. 3) is too generous at the
  // quiet end: a far station sitting at ~1% of the network's peak — real but
  // faint precursory motion, barely visible in its own seismogram — would swell
  // to nearly half the maximum radius, reading as "already shaking" long before
  // the wave truly arrives. Two decades keeps such precursors near the minimum
  // while still resolving the genuinely-shaking stations.
  rangeDecades: 2,
  perStationFloor: 0.05,
  coastlineWidth: 1,
  faultWidth: 1.1,
  geologyFillAlpha: 0.5,
  uiScale: 1,
};

/** Parse a `#rrggbb` colour into an `rgba(...)` string at the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Expanding P and S wavefronts, as projected closed rings (null = not shown). */
export interface Wavefronts {
  p: ScreenPoint[] | null;
  s: ScreenPoint[] | null;
}

export interface FrameContext {
  startMs: number;
  sampleRateHz: number;
  globalScale: number;
  normalisation: Normalisation;
  amplitudeMode: AmplitudeMode;
  currentTimeMs: number;
  wavefronts?: Wavefronts | null;
  /** Whether to draw the optional major-faults overlay. */
  showFaults?: boolean;
  /** Draw the bedrock-geology overlay this frame. */
  showGeology?: boolean;
}

export interface Scene {
  width: number;
  height: number;
  coastline: ScreenPoint[][];
  /** Projected major-fault polylines (drawn only when the overlay is on). */
  faults: ScreenPoint[][];
  sensors: RenderSensor[];
  epicenter: ScreenPoint | null;
  /** Projected bedrock provinces (empty if the overlay data is unavailable). */
  geology: GeologyShape[];
}

function drawCoastline(
  ctx: CanvasRenderingContext2D,
  rings: ScreenPoint[][],
  style: RenderStyle
): void {
  ctx.strokeStyle = style.coastline;
  ctx.lineWidth = style.coastlineWidth;
  ctx.lineJoin = 'round';
  for (const ring of rings) {
    if (ring.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
    ctx.stroke();
  }
}

function drawFaults(
  ctx: CanvasRenderingContext2D,
  lines: ScreenPoint[][],
  style: RenderStyle
): void {
  ctx.strokeStyle = style.fault;
  ctx.lineWidth = style.faultWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of lines) {
    if (line.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(line[0].x, line[0].y);
    for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y);
    ctx.stroke();
  }
}

/**
 * Fill the bedrock-geology provinces, clipped to the land so no colour spills
 * into the sea, then label each province. Drawn beneath the coastline stroke.
 */
function drawGeology(
  ctx: CanvasRenderingContext2D,
  coastline: ScreenPoint[][],
  geology: GeologyShape[],
  style: RenderStyle
): void {
  if (geology.length === 0) return;

  ctx.save();
  // Clip to the union of the coastline rings (the land mass).
  ctx.beginPath();
  for (const ring of coastline) {
    if (ring.length < 3) continue;
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  }
  ctx.clip();

  for (const region of geology) {
    if (region.ring.length < 3) continue;
    ctx.fillStyle = withAlpha(
      geologyCategory(region.category).color,
      style.geologyFillAlpha
    );
    ctx.beginPath();
    ctx.moveTo(region.ring[0].x, region.ring[0].y);
    for (let i = 1; i < region.ring.length; i++) {
      ctx.lineTo(region.ring[i].x, region.ring[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Labels sit above the fills but are not clipped, so coastal provinces stay
  // legible. A dark halo keeps them readable over any colour.
  ctx.font = `600 ${10 * style.uiScale}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const region of geology) {
    if (!region.label) continue;
    const {x, y} = region.labelAt;
    ctx.lineWidth = 3 * style.uiScale;
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.strokeText(region.label, x, y);
    ctx.fillStyle = withAlpha(geologyCategory(region.category).color, 0.95);
    ctx.fillText(region.label, x, y);
  }
  ctx.textBaseline = 'alphabetic';
}

function drawWavefront(
  ctx: CanvasRenderingContext2D,
  ring: ScreenPoint[],
  colour: string,
  dashed: boolean,
  label: string,
  uiScale: number
): void {
  if (ring.length < 2) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4 * uiScale;
  ctx.setLineDash(dashed ? [7 * uiScale, 5 * uiScale] : []);
  ctx.beginPath();
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Label at the ring's topmost point.
  let top = ring[0];
  for (const p of ring) if (p.y < top.y) top = p;
  ctx.fillStyle = colour;
  ctx.font = `600 ${12 * uiScale}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(label, top.x, top.y - 5 * uiScale);
}

function drawWavefronts(
  ctx: CanvasRenderingContext2D,
  waves: Wavefronts,
  style: RenderStyle
): void {
  // S is the inner (slower) ring, P the outer (faster); draw S first.
  if (waves.s)
    drawWavefront(ctx, waves.s, style.sWave, false, 'S', style.uiScale);
  if (waves.p)
    drawWavefront(ctx, waves.p, style.pWave, true, 'P', style.uiScale);
}

function drawEpicentre(
  ctx: CanvasRenderingContext2D,
  p: ScreenPoint,
  style: RenderStyle
): void {
  const r = 7 * style.uiScale;
  const arm = 4 * style.uiScale;
  ctx.strokeStyle = style.epicenter;
  ctx.lineWidth = 1.4 * style.uiScale;
  // A small ring with a cross-hair — reads clearly in monochrome.
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.moveTo(p.x - r - arm, p.y);
  ctx.lineTo(p.x + r + arm, p.y);
  ctx.moveTo(p.x, p.y - r - arm);
  ctx.lineTo(p.x, p.y + r + arm);
  ctx.stroke();
}

/** Render one frame of the scene at `frame.currentTimeMs`. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  style: RenderStyle,
  frame: FrameContext
): void {
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, scene.width, scene.height);

  if (frame.showGeology) {
    drawGeology(ctx, scene.coastline, scene.geology, style);
  }

  drawCoastline(ctx, scene.coastline, style);

  if (frame.showFaults && scene.faults.length > 0) {
    drawFaults(ctx, scene.faults, style);
  }

  if (frame.wavefronts) drawWavefronts(ctx, frame.wavefronts, style);

  const circleOpts = {
    scale: 1,
    minRadius: style.minRadius,
    maxRadius: style.maxRadius,
    rangeDecades: style.rangeDecades,
  };

  ctx.strokeStyle = style.sensor;
  ctx.lineWidth = style.sensorStrokeWidth;

  for (const s of scene.sensors) {
    if (!s.hasData) {
      // Located-only sensor: a faint fixed dot so the site is still visible.
      ctx.beginPath();
      ctx.arc(s.x, s.y, style.minRadius, 0, Math.PI * 2);
      ctx.fillStyle = style.restSensor;
      ctx.fill();
      continue;
    }

    // Circle size shows the *magnitude* of shaking — a solid disc either way.
    // Radius follows the smoothed envelope (calm) or the raw rectified value.
    const magnitude =
      frame.amplitudeMode === 'envelope'
        ? sampleTraceAt(
            s.envelope,
            frame.startMs,
            frame.sampleRateHz,
            frame.currentTimeMs
          )
        : Math.abs(
            sampleTraceAt(
              s.samples,
              frame.startMs,
              frame.sampleRateHz,
              frame.currentTimeMs
            )
          );
    const scale =
      frame.normalisation === 'per-station'
        ? perStationScale(s.scale, frame.globalScale, style.perStationFloor)
        : frame.globalScale;
    const {radius} = amplitudeToCircle(magnitude, {...circleOpts, scale});

    // Translucent fill (overlaps accumulate to show density) + a crisp outline
    // (so individual discs stay distinct where they overlap).
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = style.sensorFill;
    ctx.fill();
    ctx.stroke();
  }

  if (scene.epicenter) drawEpicentre(ctx, scene.epicenter, style);
}
