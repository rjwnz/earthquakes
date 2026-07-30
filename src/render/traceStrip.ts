/**
 * The bottom scrubber: a filled waveform of the network shaking envelope with a
 * moving playhead. Drawing only; pointer/keyboard scrubbing is wired up in
 * main.ts. Kept monochrome to match the map.
 */
import {peakBins} from '../data/envelope';

export interface TraceStripStyle {
  background: string;
  fill: string;
  baseline: string;
  playhead: string;
  originTick: string;
}

export const DEFAULT_TRACE_STYLE: TraceStripStyle = {
  background: 'transparent',
  fill: 'rgba(255,255,255,0.42)',
  baseline: 'rgba(255,255,255,0.18)',
  playhead: '#ffffff',
  originTick: 'rgba(255,255,255,0.45)',
};

export interface TraceStripFrame {
  /** Full-resolution envelope, values in [0, 1]. */
  envelope: readonly number[];
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
  const usableH = height - pad * 2;
  const baseY = height - pad;

  // Origin-time tick.
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

  // Envelope as a filled area, one column per pixel.
  const cols = Math.max(1, Math.floor(width));
  const bins = peakBins(frame.envelope, cols);
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  for (let x = 0; x < cols; x++) {
    ctx.lineTo(x, baseY - bins[x] * usableH);
  }
  ctx.lineTo(cols - 1, baseY);
  ctx.closePath();
  ctx.fillStyle = style.fill;
  ctx.fill();

  // Baseline.
  ctx.strokeStyle = style.baseline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, baseY + 0.5);
  ctx.lineTo(width, baseY + 0.5);
  ctx.stroke();

  // Playhead.
  const px = Math.max(0, Math.min(1, frame.positionFrac)) * width;
  ctx.strokeStyle = style.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
  // Playhead handle.
  ctx.fillStyle = style.playhead;
  ctx.beginPath();
  ctx.arc(px, pad, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
