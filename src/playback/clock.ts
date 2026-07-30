/**
 * Playback clock: maps real elapsed wall-clock time onto a position within the
 * event window, scaled by a speed factor and optionally looping.
 *
 * The brief calls for slow motion down to 0.05× real speed and looped playback.
 * The pure time-stepping logic ({@link advancePlayhead}) is separated from the
 * `requestAnimationFrame` driver ({@link PlaybackClock}) so the arithmetic —
 * the part that can be wrong — is unit tested without any timers.
 */

/** Speed presets offered in the UI, from real-time down to 0.05×. */
export const SPEED_PRESETS = [1, 0.5, 0.25, 0.1, 0.05] as const;

export const MIN_SPEED = 0.05;
export const MAX_SPEED = 1;

export interface PlayheadUpdate {
  /** New position within `[0, durationMs]`. */
  positionMs: number;
  /** False once a non-looping clock reaches the end. */
  playing: boolean;
}

/**
 * Advance a playhead by `dtMs` of real time at `speed`×.
 *
 * - While the result stays within the window, it simply moves forward.
 * - Looping wraps back into `[0, durationMs)`.
 * - Non-looping playback clamps to the end and reports `playing: false`.
 */
export function advancePlayhead(
  positionMs: number,
  dtMs: number,
  speed: number,
  durationMs: number,
  loop: boolean
): PlayheadUpdate {
  if (durationMs <= 0) return {positionMs: 0, playing: false};
  const next = positionMs + dtMs * speed;

  if (next < durationMs) {
    return {positionMs: Math.max(0, next), playing: true};
  }
  if (!loop) {
    return {positionMs: durationMs, playing: false};
  }
  // Wrap into [0, durationMs). Modulo can leave a negative if next went < 0.
  const wrapped = ((next % durationMs) + durationMs) % durationMs;
  return {positionMs: wrapped, playing: true};
}

/** Clamp a requested speed to the supported range. */
export function clampSpeed(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

type TickListener = (positionMs: number, playing: boolean) => void;

/** Provider of monotonically increasing timestamps in ms (injected for tests). */
export type Now = () => number;

/**
 * rAF-driven clock wrapping {@link advancePlayhead}. Framework-free; the caller
 * supplies a per-frame scheduler (defaults to `requestAnimationFrame`).
 */
export class PlaybackClock {
  private position = 0;
  private playing = false;
  private speed = 0.1;
  private loop = true;
  private lastTs: number | null = null;
  private rafId: number | null = null;
  private readonly listeners = new Set<TickListener>();

  constructor(
    private durationMs: number,
    private readonly now: Now = () => performance.now(),
    private readonly schedule: (cb: () => void) => number = cb =>
      requestAnimationFrame(cb),
    private readonly cancel: (id: number) => void = id =>
      cancelAnimationFrame(id)
  ) {}

  get positionMs(): number {
    return this.position;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentSpeed(): number {
    return this.speed;
  }

  get isLooping(): boolean {
    return this.loop;
  }

  onTick(listener: TickListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSpeed(speed: number): void {
    this.speed = clampSpeed(speed);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setDuration(durationMs: number): void {
    this.durationMs = durationMs;
    if (this.position > durationMs) this.position = durationMs;
  }

  seek(positionMs: number): void {
    this.position = Math.min(this.durationMs, Math.max(0, positionMs));
    this.emit();
  }

  play(): void {
    if (this.playing) return;
    // Restart from the beginning if parked at the end (non-looping finish).
    if (this.position >= this.durationMs) this.position = 0;
    this.playing = true;
    this.lastTs = null;
    this.loopFrame();
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) {
      this.cancel(this.rafId);
      this.rafId = null;
    }
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private loopFrame(): void {
    this.rafId = this.schedule(() => {
      const ts = this.now();
      if (this.lastTs !== null) {
        const dt = ts - this.lastTs;
        const update = advancePlayhead(
          this.position,
          dt,
          this.speed,
          this.durationMs,
          this.loop
        );
        this.position = update.positionMs;
        this.playing = update.playing;
        this.emit();
      }
      this.lastTs = ts;
      if (this.playing) this.loopFrame();
    });
  }

  private emit(): void {
    for (const l of this.listeners) l(this.position, this.playing);
  }
}
