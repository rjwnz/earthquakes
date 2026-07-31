/**
 * Black-and-white canvas renderer.
 *
 * Draws the NZ coastline and, for each displayed sensor, a circle whose radius
 * tracks the magnitude of the ground motion at the current playback time:
 *   - positive amplitude → a solid (filled) white disc,
 *   - negative amplitude → a hollow white ring.
 *
 * Coastline rings and sensor positions arrive already projected to screen
 * pixels (see `main.ts`); only the amplitude-driven parts change per frame, so
 * this stays cheap enough to run every animation frame.
 */
import {sampleTraceAt, amplitudeToCircle} from '../data/amplitude';

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface RenderSensor {
  code: string;
  x: number;
  y: number;
  hasData: boolean;
  samples: readonly number[];
  /** Per-station robust amplitude scale. */
  scale: number;
  /** Number of real sensors this representative stands in for (≥ 1). */
  count: number;
}

export type Normalisation = 'per-station' | 'uniform';

export interface RenderStyle {
  background: string;
  coastline: string;
  sensor: string;
  restSensor: string;
  epicenter: string;
  pWave: string;
  sWave: string;
  minRadius: number;
  maxRadius: number;
  /** Log dynamic range (decades) for the radius mapping; see amplitudeToCircle. */
  rangeDecades: number;
  coastlineWidth: number;
  ringWidth: number;
}

export const DEFAULT_STYLE: RenderStyle = {
  background: '#000000',
  coastline: 'rgba(255,255,255,0.5)',
  sensor: '#ffffff',
  restSensor: 'rgba(255,255,255,0.28)',
  epicenter: 'rgba(255,255,255,0.85)',
  pWave: 'rgba(255,255,255,0.4)',
  sWave: 'rgba(255,255,255,0.7)',
  minRadius: 1.6,
  maxRadius: 22,
  rangeDecades: 3,
  coastlineWidth: 1,
  ringWidth: 1.6,
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
  currentTimeMs: number;
  wavefronts?: Wavefronts | null;
}

export interface Scene {
  width: number;
  height: number;
  coastline: ScreenPoint[][];
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

    const amp = sampleTraceAt(
      s.samples,
      frame.startMs,
      frame.sampleRateHz,
      frame.currentTimeMs
    );
    const scale =
      frame.normalisation === 'per-station' ? s.scale : frame.globalScale;
    const {radius, filled} = amplitudeToCircle(amp, {...circleOpts, scale});

    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    if (filled) {
      ctx.fill();
    } else {
      ctx.lineWidth = style.ringWidth;
      ctx.stroke();
    }
  }

  if (scene.epicenter) drawEpicentre(ctx, scene.epicenter, style);
}
