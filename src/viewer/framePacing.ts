/**
 * Frame pacing (roadmap P2.1a, P3.3): the viewer updates and draws every animation frame while
 * something changes, only `idleFrameRate` frames per second once the view has been quiet for
 * `QUIET_MS`, and with supersampling on it refines a still view over a few jittered frames and
 * then stops drawing (`drawMode`) until the next change.
 *
 * Two kinds of signals:
 * - a **change** (`markChange`): the picture may differ from the one on screen (camera motion,
 *   loading, level changes, `requestRender()`, setters). It restarts the quiet period and
 *   discards the supersampled picture.
 * - a **wake** (`markWake`): input that may lead to a change (pointer moves, wheel, keys) or work
 *   spread over frames that does not touch the canvas (markers placed in the DOM). Frames run at
 *   the full rate so the viewer reacts at once, but a still picture stays as it is: moving the
 *   pointer over a view does not throw its supersampling away.
 *
 * Throttled frames still advance all time-based state by the real elapsed time: a change the
 * viewer fails to notice is drawn late, never left half done. A held (converged) picture is not
 * redrawn at all, so there a missed change shows only with the next one; the viewer therefore
 * also compares what it can cheaply read each frame (camera, globe surface, label fades, 3D Tiles
 * fades, the simulated date...) before holding a picture.
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
 * How a frame draws:
 * - `live`: the scene as it is, straight to the canvas (the picture changes, or it is not still);
 * - `sample`: one more jittered supersampling sample averaged into the still picture;
 * - `hold`: nothing; the still picture has all its samples and stays on the canvas.
 */
export type DrawMode = 'live' | 'sample' | 'hold';

/**
 * The draw mode of a frame: live unless the view is `still` (see `FramePacer.isStill`) and
 * supersampling is on; then samples until `target` are taken, and holds after that.
 * @param samples Samples already in the picture on screen.
 * @param target Samples to take (`viewer.supersampling.samples`).
 */
export function drawMode(still: boolean, supersampling: boolean, samples: number, target: number): DrawMode {
  if (!still || !supersampling) return 'live';
  return samples < target ? 'sample' : 'hold';
}

/**
 * Decides, per animation frame, whether the viewer runs a frame (`shouldTick`) and whether the
 * view is still (`isStill`). See the module comment for changes and wakes. After `QUIET_MS`
 * without either, frames run at the idle rate, or faster when something still animating needs
 * it (`floorRate`, e.g. the clouds), or at the full rate while a still view is being refined.
 */
export class FramePacer {
  private lastChange: number;
  private lastWake = -Infinity;
  private lastTick = -Infinity;
  private _throttled = false;

  constructor(
    /** Frames per second while quiet; 0 runs every frame (and nothing is ever still). Set through `normalizeIdleFrameRate`. */
    public idleFrameRate: number,
    now: number,
  ) {
    // A new viewer starts at the full rate.
    this.lastChange = now;
  }

  /** Whether the last decision was taken at the idle rate. */
  get throttled(): boolean {
    return this._throttled;
  }

  /** Time of the latest change (ms, as passed to `markChange`). */
  get changedAt(): number {
    return this.lastChange;
  }

  /** The picture may have changed: full rate for `QUIET_MS`, and not still before that. */
  markChange(now: number): void {
    if (now > this.lastChange) this.lastChange = now;
  }

  /** Input or off-canvas work: full rate for `QUIET_MS`, the picture stays as it is. */
  markWake(now: number): void {
    if (now > this.lastWake) this.lastWake = now;
  }

  /**
   * Whether the view is still at `now`: throttling is on, nothing changed for `QUIET_MS` and
   * nothing animates on its own (`floorRate` 0). A still picture can be supersampled and held.
   * Wakes do not count: input that changes nothing leaves a still view still.
   */
  isStill(now: number, floorRate = 0): boolean {
    return this.idleFrameRate > 0 && !(floorRate > 0) && now - this.lastChange >= QUIET_MS;
  }

  /**
   * Whether to run the animation frame at `now` (ms, the frame's timestamp).
   * @param floorRate Frames per second that something still animating needs (0 = none).
   * @param refining A still view is being supersampled: take the samples at the full rate.
   */
  shouldTick(now: number, floorRate = 0, refining = false): boolean {
    const rate = this.idleFrameRate;
    const last = Math.max(this.lastChange, this.lastWake);
    if (rate <= 0 || refining || now - last < QUIET_MS) {
      this._throttled = false;
      return true;
    }
    const effective = Math.max(rate, floorRate);
    if (effective >= MAX_IDLE_FRAME_RATE) {
      this._throttled = false;
      return true;
    }
    this._throttled = true;
    return now - this.lastTick >= 1000 / effective - INTERVAL_SLACK_MS;
  }

  /** Call when a frame ran. */
  ticked(now: number): void {
    this.lastTick = now;
  }
}
