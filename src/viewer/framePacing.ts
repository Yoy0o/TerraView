/**
 * Idle frame-rate throttling (roadmap P2.1a): the viewer draws every animation frame while
 * something changes, and only `idleFrameRate` frames per second once the view has been quiet
 * for `QUIET_MS`. Unlike skipping frames altogether (on-demand rendering, P2.1), every frame
 * still advances all time-based state by the real elapsed time: a change the viewer fails to
 * notice is drawn late and choppy, never left half done.
 *
 * Why these numbers (measurements and reasoning in docs/agents/roadmap.md, P2.1a):
 * - 10 frames per second keeps about 80 % of the CPU and GPU time a static view can save;
 *   below 10 the saving stopped being reliable (5 fps cost more than 10 in a building view).
 * - The frame loop clamps `dt` to 0.25 s and the camera controller to 0.1 s: from 10 fps up,
 *   both still advance in real time, so a missed camera motion keeps its speed.
 * - A missed change shows at most one idle frame late: 100 ms at 10 fps, the usual limit for
 *   a response that feels instantaneous.
 *
 * No three.js here (unit tested in tests/framePacing.test.ts).
 */

/** Default `GeoViewerOptions.idleFrameRate`. */
export const DEFAULT_IDLE_FRAME_RATE = 10;
/** Lowest idle frame rate accepted (except 0, which turns throttling off). */
export const MIN_IDLE_FRAME_RATE = 10;
/** Highest idle frame rate accepted; at or above the display rate nothing is throttled. */
export const MAX_IDLE_FRAME_RATE = 60;
/** How long the view must stay quiet before frames are throttled, ms (covers tile, label and backdrop fades of up to 0.5 s). */
export const QUIET_MS = 1000;
/** Cloud drift may move the clouds at most this many CSS pixels between two idle frames. */
export const CLOUD_MAX_STEP_PX = 1.5;
/** Slack when comparing frame intervals, ms: animation frames arrive on the display's clock, not exactly on the target interval. */
const INTERVAL_SLACK_MS = 4;

/**
 * The idle frame rate to use for a requested value: 0 (throttling off) stays 0, values below
 * `MIN_IDLE_FRAME_RATE` become it, values above `MAX_IDLE_FRAME_RATE` become it, anything that
 * is not a finite non-negative number becomes the default.
 */
export function normalizeIdleFrameRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_IDLE_FRAME_RATE;
  if (value === 0) return 0;
  return Math.min(MAX_IDLE_FRAME_RATE, Math.max(MIN_IDLE_FRAME_RATE, value));
}

/** What `cloudFrameRate` needs to know. */
export interface CloudMotion {
  /** Drift in degrees of longitude per second (sign ignored). */
  speedDegPerSec: number;
  /** Radius of the cloud shell in meters (equatorial radius + layer height). */
  layerRadius: number;
  /** Camera height above the cloud layer in meters. */
  distance: number;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Viewport height in CSS pixels. */
  viewportHeight: number;
}

/**
 * Frames per second the cloud drift needs to move at most `CLOUD_MAX_STEP_PX` per frame:
 * drift speed at the equator (the fastest point of the shell) over the size of a pixel at the
 * view center, looking straight down. With the default 0.5°/s: about 88 fps from 500 km,
 * 22 fps from 2000 km, 2 fps from 20,000 km.
 */
export function cloudFrameRate(m: CloudMotion): number {
  if (!(m.speedDegPerSec !== 0 && m.distance > 0 && m.viewportHeight > 0)) return 0;
  const speed = Math.abs(m.speedDegPerSec) * (Math.PI / 180) * m.layerRadius;
  const metersPerPixel = (m.distance * 2 * Math.tan((m.fovDeg * Math.PI) / 360)) / m.viewportHeight;
  return speed / metersPerPixel / CLOUD_MAX_STEP_PX;
}

/**
 * Decides, per animation frame, whether the viewer draws. `markActivity` whenever something
 * changes (input, camera motion, loading, transitions, `requestRender()`); after `QUIET_MS`
 * without activity frames are drawn at the idle rate, or faster when something still
 * animating needs it (`floorRate`, the clouds).
 */
export class FramePacer {
  private lastActivity: number;
  private lastFrame = -Infinity;
  private _throttled = false;

  constructor(
    /** Frames per second while quiet; 0 draws every frame. Set through `normalizeIdleFrameRate`. */
    public idleFrameRate: number,
    now: number,
  ) {
    // A new viewer starts at the full rate.
    this.lastActivity = now;
  }

  /** Whether the last decision was taken at the idle rate. */
  get throttled(): boolean {
    return this._throttled;
  }

  markActivity(now: number): void {
    if (now > this.lastActivity) this.lastActivity = now;
  }

  /**
   * Whether to draw the animation frame at `now` (ms, the frame's timestamp).
   * @param floorRate Frames per second that something still animating needs (0 = none).
   */
  shouldDraw(now: number, floorRate = 0): boolean {
    const rate = this.idleFrameRate;
    if (rate <= 0 || now - this.lastActivity < QUIET_MS) {
      this._throttled = false;
      return true;
    }
    const effective = Math.max(rate, floorRate);
    if (effective >= MAX_IDLE_FRAME_RATE) {
      this._throttled = false;
      return true;
    }
    this._throttled = true;
    return now - this.lastFrame >= 1000 / effective - INTERVAL_SLACK_MS;
  }

  /** Call when a frame was drawn. */
  frameDrawn(now: number): void {
    this.lastFrame = now;
  }
}
