/**
 * Camera framing for indoor levels (ThingJS "nearest object position"): the
 * nearest of four diagonal views around a subject, with the distance
 * normalized to the field of view. Pure math on ECEF vectors.
 */
import { Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';

/** A camera view of a target: look at `target` from `heading` / `pitch` at `range`. */
export interface LevelView {
  /** World (ECEF) point looked at. */
  target: Vector3;
  /** Degrees clockwise from north. */
  heading: number;
  /** Degrees, negative looks down. */
  pitch: number;
  /** Meters from the target. */
  range: number;
}

/** Framing of a level type. */
export interface Framing {
  /** Degrees, negative looks down (default -45). */
  pitch?: number;
  /** Camera distance in bounding radii, for a 60° vertical field of view. */
  radii: number;
  /** Smallest radius used for framing (meters), so tiny subjects are not filled edge to edge. */
  minRadius: number;
}

/** Field of view the `Framing.radii` are tuned for. */
const REFERENCE_FOV = 60;

/**
 * Scales a distance tuned for a 60° vertical field of view so that the
 * subject keeps its on-screen size at `fovDeg`: `tan(30°) / tan(fov / 2)`.
 */
export function fovNormalizedRange(range: number, fovDeg: number): number {
  return (range * Math.tan((REFERENCE_FOV / 2) * DEG2RAD)) / Math.tan((Math.min(Math.max(fovDeg, 1), 179) / 2) * DEG2RAD);
}

/** The four diagonal headings (degrees, 0..360) around a building with this heading: 45°, 135°, 225°, 315° off its +Y axis. */
export function diagonalHeadings(buildingHeadingDeg: number): number[] {
  return [45, 135, 225, 315].map((a) => (((buildingHeadingDeg + a) % 360) + 360) % 360);
}

const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _p = new Vector3();

/** Camera position of a view (ECEF), without building an orientation. */
export function viewPosition(ellipsoid: Ellipsoid, view: LevelView, out = new Vector3()): Vector3 {
  ellipsoid.eastNorthUp(view.target, _e, _n, _u);
  const h = view.heading * DEG2RAD;
  const p = view.pitch * DEG2RAD;
  // The camera looks along (cp·sh, cp·ch, sp) in ENU; it sits `range` behind the target.
  return out
    .copy(view.target)
    .addScaledVector(_e, -Math.cos(p) * Math.sin(h) * view.range)
    .addScaledVector(_n, -Math.cos(p) * Math.cos(h) * view.range)
    .addScaledVector(_u, -Math.sin(p) * view.range);
}

/**
 * The diagonal view of a bounding sphere closest to the camera: four
 * candidates at 45° / 135° / 225° / 315° from the building's +Y axis, so every
 * entry lands on a tidy three-quarter view while the camera moves the least.
 */
export function nearestDiagonalView(
  ellipsoid: Ellipsoid,
  center: Vector3,
  radius: number,
  buildingHeadingDeg: number,
  cameraPosition: Vector3,
  fovDeg: number,
  framing: Framing,
): LevelView {
  const range = fovNormalizedRange(Math.max(radius, framing.minRadius) * framing.radii, fovDeg);
  const pitch = framing.pitch ?? -45;
  let best: LevelView | null = null;
  let bestDistance = Infinity;
  for (const heading of diagonalHeadings(buildingHeadingDeg)) {
    const view: LevelView = { target: center.clone(), heading, pitch, range };
    const d = viewPosition(ellipsoid, view, _p).distanceToSquared(cameraPosition);
    if (d < bestDistance) {
      bestDistance = d;
      best = view;
    }
  }
  return best!;
}
