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

export interface ScreenPoint {
  x: number;
  y: number;
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
  sensor: string;
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
}

export const DEFAULT_STYLE: RenderStyle = {
  background: '#000000',
  coastline: 'rgba(255,255,255,0.5)',
  sensor: '#ffffff',
  restSensor: 'rgba(255,255,255,0.28)',
  epicenter: 'rgba(255,255,255,0.85)',
  // A restrained warm accent — the geological convention for faults — kept
  // subtle so it reads as background context under the seismic data.
  fault: 'rgba(226,140,74,0.62)',
  pWave: 'rgba(255,255,255,0.4)',
  sWave: 'rgba(255,255,255,0.7)',
  minRadius: 1.6,
  maxRadius: 22,
  rangeDecades: 3,
  perStationFloor: 0.05,
  coastlineWidth: 1,
  faultWidth: 1.1,
};

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
}

export interface Scene {
  width: number;
  height: number;
  coastline: ScreenPoint[][];
  /** Projected major-fault polylines (drawn only when the overlay is on). */
  faults: ScreenPoint[][];
  sensors: RenderSensor[];
  epicenter: ScreenPoint | null;
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

function drawWavefront(
  ctx: CanvasRenderingContext2D,
  ring: ScreenPoint[],
  colour: string,
  dashed: boolean,
  label: string
): void {
  if (ring.length < 2) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4;
  ctx.setLineDash(dashed ? [7, 5] : []);
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
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, top.x, top.y - 5);
}

function drawWavefronts(
  ctx: CanvasRenderingContext2D,
  waves: Wavefronts,
  style: RenderStyle
): void {
  // S is the inner (slower) ring, P the outer (faster); draw S first.
  if (waves.s) drawWavefront(ctx, waves.s, style.sWave, false, 'S');
  if (waves.p) drawWavefront(ctx, waves.p, style.pWave, true, 'P');
}

function drawEpicentre(
  ctx: CanvasRenderingContext2D,
  p: ScreenPoint,
  style: RenderStyle
): void {
  const r = 7;
  ctx.strokeStyle = style.epicenter;
  ctx.lineWidth = 1.4;
  // A small ring with a cross-hair — reads clearly in monochrome.
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.moveTo(p.x - r - 4, p.y);
  ctx.lineTo(p.x + r + 4, p.y);
  ctx.moveTo(p.x, p.y - r - 4);
  ctx.lineTo(p.x, p.y + r + 4);
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

  ctx.fillStyle = style.sensor;
  ctx.strokeStyle = style.sensor;

  for (const s of scene.sensors) {
    if (!s.hasData) {
      // Located-only sensor: a faint fixed dot so the site is still visible.
      ctx.beginPath();
      ctx.arc(s.x, s.y, style.minRadius, 0, Math.PI * 2);
      ctx.fillStyle = style.restSensor;
      ctx.fill();
      ctx.fillStyle = style.sensor;
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

    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (scene.epicenter) drawEpicentre(ctx, scene.epicenter, style);
}
