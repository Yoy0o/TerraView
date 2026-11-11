/**
 * Opening animation: the globe spins about its axis and slows to a stop on
 * the view the page opened with.
 *
 * The camera, not the globe, moves: it runs along its circle of latitude
 * (west, as the real earth turns east) with heading, pitch and latitude held,
 * so world coordinates stay ECEF and the sun keeps its place. The spin is
 * aimed to end exactly on the starting view. It runs as a controller
 * animation (`GlobeCameraController.playAnimation`), so any gesture, flight
 * or other camera call interrupts it.
 */
import type { PerspectiveCamera } from 'three';
import { cartographic, type Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';
import { orientationFromHeadingPitch, getHeadingPitch } from './cameraMath';
import type { GlobeCameraController } from './GlobeCameraController';

export interface IntroSpinOptions {
  /** Seconds from the start until the globe is at rest (default 6). */
  duration?: number;
  /**
   * Spin speed at the start in degrees of longitude per second (default 40).
   * Positive turns the globe eastwards like the real earth; negative reverses it.
   */
  speed?: number;
  /** Seconds of the final slow-down, within `duration` (default 60 % of it). */
  slowdown?: number;
  /**
   * The camera starts this many times higher and settles into the view while
   * spinning (default 1.3; 1 = no height change).
   */
  zoomFrom?: number;
  /**
   * Lowest camera height in meters at which the intro plays (default 2,000 km):
   * spinning a close-up view about the earth's axis would sweep it across
   * continents. Lower views skip the intro unless `force` is set.
   */
  minHeight?: number;
  /** Play even below `minHeight`. */
  force?: boolean;
}

export const INTRO_DEFAULTS: Required<IntroSpinOptions> = {
  duration: 6,
  speed: 40,
  slowdown: 3.6,
  zoomFrom: 1.3,
  minHeight: 2_000_000,
  force: false,
};

/** Resolved timing of a spin; all angles in degrees. */
export interface IntroSpinProfile {
  /** Seconds. */
  duration: number;
  /** Seconds of slow-down at the end. */
  slowdown: number;
  /** Starting speed, degrees per second (signed). */
  speed: number;
  /** Degrees turned over the whole animation (signed). */
  total: number;
}

/**
 * Speed profile: constant `speed` until the slow-down starts, then
 * `speed · (1 − s)²` for s from 0 to 1, so the globe eases to a stop with no
 * jump in speed. Invalid numbers fall back to the defaults.
 */
export function introSpinProfile(options: IntroSpinOptions = {}): IntroSpinProfile {
  const duration = positive(options.duration, INTRO_DEFAULTS.duration);
  const speed = Number.isFinite(options.speed) ? (options.speed as number) : INTRO_DEFAULTS.speed;
  const slowdown = Math.min(duration, options.slowdown !== undefined && options.slowdown >= 0 ? options.slowdown : duration * 0.6);
  const total = speed * (duration - slowdown) + (speed * slowdown) / 3;
  return { duration, slowdown, speed, total };
}

/** Degrees turned after `t` seconds (clamped to [0, duration]). */
export function introSpinAngle(profile: IntroSpinProfile, t: number): number {
  const { duration, slowdown, speed } = profile;
  const time = Math.max(0, Math.min(duration, t));
  const cruise = duration - slowdown;
  if (time <= cruise) return speed * time;
  const s = (time - cruise) / slowdown;
  return speed * cruise + ((speed * slowdown) / 3) * (1 - (1 - s) ** 3);
}

/** Height multiplier at time `t`: from `zoomFrom` down to 1, settling as the spin slows. */
export function introHeightScale(profile: IntroSpinProfile, zoomFrom: number, t: number): number {
  if (profile.total === 0 || zoomFrom === 1) return 1;
  const remaining = 1 - introSpinAngle(profile, t) / profile.total;
  return 1 + (zoomFrom - 1) * remaining * remaining;
}

export interface IntroHost {
  readonly ellipsoid: Ellipsoid;
  readonly camera: PerspectiveCamera;
  readonly controller: GlobeCameraController;
}

/**
 * Plays the opening spin, ending on the current view. Resolves true when it
 * ran to the end, false when skipped (camera too low) or interrupted.
 */
export function playIntroSpin(host: IntroHost, options: IntroSpinOptions = {}): Promise<boolean> {
  const { ellipsoid, camera, controller } = host;
  const end = ellipsoid.cartesianToCartographic(camera.position, cartographic());
  const minHeight = options.minHeight ?? INTRO_DEFAULTS.minHeight;
  if (!end || (!options.force && end.height < minHeight)) return Promise.resolve(false);
  const { heading, pitch } = getHeadingPitch(ellipsoid, camera.position, camera.quaternion);
  const profile = introSpinProfile(options);
  const zoomFrom = positive(options.zoomFrom, INTRO_DEFAULTS.zoomFrom);
  let time = 0;
  const pose = (cam: PerspectiveCamera) => {
    // The camera starts east of the view and moves west (the globe turns east under it).
    const remaining = (profile.total - introSpinAngle(profile, time)) * DEG2RAD;
    const height = end.height * introHeightScale(profile, zoomFrom, time);
    ellipsoid.cartographicToCartesian(end.longitude + remaining, end.latitude, height, cam.position);
    orientationFromHeadingPitch(ellipsoid, cam.position, heading, pitch, cam.quaternion);
  };
  pose(camera);
  return controller.playAnimation((dt, cam) => {
    time += dt;
    pose(cam);
    return time < profile.duration;
  });
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}
