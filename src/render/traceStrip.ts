/**
 * The bottom timeline: the real seismogram of the station nearest the epicentre,
 * drawn as a single line centred on zero with positive (up) and negative (down)
 * ground motion — plus a moving playhead. Drawing only; pointer/keyboard
 * scrubbing is wired up in main.ts. Monochrome to match the map.
 */
import {signedPeakBins} from '../data/waveform';

export interface TraceStripStyle {
  background: string;
  wave: string;
  axis: string;
  playhead: string;
  originTick: string;
}

export const DEFAULT_TRACE_STYLE: TraceStripStyle = {
  background: 'transparent',
  wave: 'rgba(255,255,255,0.85)',
  axis: 'rgba(255,255,255,0.22)',
  playhead: '#ffffff',
  originTick: 'rgba(255,255,255,0.45)',
};

export interface TraceStripFrame {
  /** Signed seismogram samples of the reference station (empty if none). */
  samples: readonly number[];
  /** Amplitude that reaches the top/bottom of the strip (peak of the trace). */
  scale: number;
  /** Playhead position as a fraction of the window, in [0, 1]. */
  positionFrac: number;
  /** Origin-time position as a fraction of the window, in [0, 1]. */
  originFrac: number;
}

export function renderTraceStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: TraceStripFrame,
  style: TraceStripStyle = DEFAULT_TRACE_STYLE
): void {
  ctx.clearRect(0, 0, width, height);
  if (style.background !== 'transparent') {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);
  }

  const pad = 4;
  const midY = height / 2;
  const halfH = height / 2 - pad;

  // Origin-time tick (dashed vertical).
  if (frame.originFrac >= 0 && frame.originFrac <= 1) {
    const ox = frame.originFrac * width;
    ctx.strokeStyle = style.originTick;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ox, pad);
    ctx.lineTo(ox, height - pad);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Zero axis (the centre line the waveform oscillates about).
  ctx.strokeStyle = style.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY + 0.5);
  ctx.lineTo(width, midY + 0.5);
  ctx.stroke();

  // Waveform: one signed peak per pixel column, centred on zero.
  if (frame.samples.length > 0) {
    const scale = frame.scale > 0 ? frame.scale : 1;
    const cols = Math.max(1, Math.floor(width));
    const bins = signedPeakBins(frame.samples, cols);
    ctx.strokeStyle = style.wave;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let x = 0; x < cols; x++) {
      const v = Math.max(-1, Math.min(1, bins[x] / scale));
      const y = midY - v * halfH;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Playhead.
  const px = Math.max(0, Math.min(1, frame.positionFrac)) * width;
  ctx.strokeStyle = style.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
  ctx.fillStyle = style.playhead;
  ctx.beginPath();
  ctx.arc(px, pad, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
