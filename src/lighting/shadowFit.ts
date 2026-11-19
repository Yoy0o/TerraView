/**
 * Range of the sun shadow map (roadmap M3.9), pure math. One orthographic shadow map looks down
 * the sun's rays; it must cover every visible point that a caster can shade, and nothing else,
 * so its texels stay small. The approach follows t3d's `LightShadowAdapter` (bounding volume ∩
 * view frustum), worked out in the light frame where it is simple:
 *
 * - Seen along the sun's rays, a caster and its shadow have the same light-frame (x, y): the
 *   shadows of a box fall inside the box's footprint, on whatever receives them. Only the depth
 *   range has to reach down to the ground the shadow falls on (box height over the sun's sine,
 *   plus a margin for terrain lower than the base).
 * - A shaded point is visible only inside the view frustum (cut at `maxDistance`), so the map
 *   covers the casters' footprints ∩ the frustum's footprint: the whole building seen from
 *   afar, the part around the camera from inside.
 * - The map is square, its half size quantized in steps of 2^(1/4) and its center snapped to
 *   whole texels in a frame fixed to the scene (origin at a building anchor, axes from the sun
 *   and the local vertical), so moving the camera does not make shadow edges crawl: a texel
 *   covers the same ground until the size steps.
 *
 * Coordinates are world (ECEF) meters in float64; the light frame is relative to `origin`.
 */
import { Matrix4, Vector3 } from 'three';

/** A box that casts shadows: a building's local bounds and its local → world transform. */
export interface ShadowCaster {
  /** Local → world (ECEF): rotation and translation, local +Z up (the building's ENU frame). */
  readonly matrix: Matrix4;
  /** Local bounds, meters. */
  readonly min: Vector3;
  readonly max: Vector3;
}

/** The view the shadow has to serve: a perspective camera's pose and opening. */
export interface ShadowView {
  /** Camera → world (ECEF). */
  readonly matrixWorld: Matrix4;
  /** tan of half the horizontal / vertical field of view. */
  readonly tanX: number;
  readonly tanY: number;
  /** Near plane distance, meters. */
  readonly near: number;
}

export interface ShadowFitOptions {
  /** Texels along a side of the (square) shadow map. */
  mapSize: number;
  /** Shadows are drawn up to this distance from the camera, meters. */
  maxDistance: number;
  /** Ground below a caster's base (terrain, a sunken courtyard) that still receives its shadow, meters. Default 10. */
  groundMargin?: number;
  /**
   * Sine of the sun altitude below which shadow lengths are capped (default sin 4°): a lower sun
   * would need a map reaching far beyond the casters; its shadows fade out anyway (`sunShadowStrength`).
   */
  minSunSine?: number;
  /** Smallest half size of the map, meters (default 4). */
  minHalfSize?: number;
}

/** Where the shadow map lies: a square across the sun's rays and a depth range along them. */
export interface ShadowFit {
  /** Light frame: origin (world), axes across the rays (`x`, `y`) and toward the sun (`z`). */
  readonly origin: Vector3;
  readonly x: Vector3;
  readonly y: Vector3;
  readonly z: Vector3;
  /** Center of the map in the light frame, meters (whole texels). */
  readonly centerX: number;
  readonly centerY: number;
  /** Half the side of the map, meters. */
  readonly halfSize: number;
  /** Depth range along `z`, meters: `top` is closest to the sun (the camera sits there), `bottom` the farthest receiver. */
  readonly top: number;
  readonly bottom: number;
  /** Size of a texel, meters. */
  readonly texel: number;
}

const DEFAULT_GROUND_MARGIN = 10;
const DEFAULT_MIN_SUN_SINE = Math.sin((4 * Math.PI) / 180);
const DEFAULT_MIN_HALF_SIZE = 4;
/** Depth range steps, meters (quantized so a still scene keeps the same fit). */
const DEPTH_STEP = 2;
/** Room above the highest caster point, meters. */
const TOP_MARGIN = 1;

const _p = new Vector3();
const _d = new Vector3();
const _n = new Vector3();
const _c = new Vector3();
const _q = new Vector3();

/**
 * Axes of the light frame: `z` toward the sun, `x` horizontal (across the sun's azimuth) at
 * the place whose vertical is `up`, `y` completing a right-handed frame. Falls back to a fixed
 * world axis when the sun stands (almost) straight above.
 */
export function lightFrame(sun: Vector3, up: Vector3, x: Vector3, y: Vector3, z: Vector3): void {
  z.copy(sun).normalize();
  x.crossVectors(up, z);
  if (x.lengthSq() < 1e-6) {
    // Sun at the zenith: any horizontal axis; the world X (or Y) axis keeps it stable.
    x.set(1, 0, 0).cross(z);
    if (x.lengthSq() < 1e-6) x.set(0, 1, 0).cross(z);
  }
  x.normalize();
  y.crossVectors(z, x).normalize();
}

/**
 * Half size of the map for a footprint of half size `h`: the next step of 2^(1/4) that leaves a
 * texel of slack for snapping the center, at least `min`.
 */
export function quantizeHalfSize(h: number, mapSize: number, min = DEFAULT_MIN_HALF_SIZE): number {
  let q = Math.pow(2, Math.ceil(Math.log2(Math.max(h, min)) * 4) / 4);
  // Snapping moves the center by up to half a texel (2q / mapSize / 2): keep it covered.
  while (q < h + q / mapSize) q *= Math.SQRT2 ** 0.5;
  return q;
}

/** Shadow strength by the sun's altitude (sine) above the local horizon: fades out between 10° and 2°. */
export function sunShadowStrength(sunSine: number): number {
  const lo = Math.sin((2 * Math.PI) / 180);
  const hi = Math.sin((10 * Math.PI) / 180);
  const t = Math.min(1, Math.max(0, (sunSine - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * World positions of the corners of the view frustum cut at `far` (4 near corners, then 4 far ones).
 */
export function frustumCorners(view: ShadowView, far: number, out: Vector3[] = []): Vector3[] {
  let i = 0;
  for (const d of [view.near, far]) {
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const v = out[i] ?? (out[i] = new Vector3());
        v.set(sx * view.tanX * d, sy * view.tanY * d, -d).applyMatrix4(view.matrixWorld);
        i++;
      }
    }
  }
  out.length = 8;
  return out;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function emptyRect(): Rect {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function extend(r: Rect, x: number, y: number): void {
  if (x < r.x0) r.x0 = x;
  if (x > r.x1) r.x1 = x;
  if (y < r.y0) r.y0 = y;
  if (y > r.y1) r.y1 = y;
}

/**
 * Fits the shadow map to the casters seen by a view (see the module comment), or null when no
 * caster can shade anything visible: none within `maxDistance`, or their footprints miss the
 * frustum's.
 *
 * @param sun Unit vector toward the sun (world).
 * @param origin Fixed point of the light frame (a building anchor): texels are snapped relative to it.
 * @param up Vertical at `origin` (unit), for the frame's horizontal axis.
 */
export function fitSunShadow(
  sun: Vector3,
  origin: Vector3,
  up: Vector3,
  casters: readonly ShadowCaster[],
  view: ShadowView,
  options: ShadowFitOptions,
): ShadowFit | null {
  const groundMargin = options.groundMargin ?? DEFAULT_GROUND_MARGIN;
  const minSunSine = options.minSunSine ?? DEFAULT_MIN_SUN_SINE;
  const x = new Vector3();
  const y = new Vector3();
  const z = new Vector3();
  lightFrame(sun, up, x, y, z);

  const camera = _c.setFromMatrixPosition(view.matrixWorld);
  _d.set(0, 0, -1).transformDirection(view.matrixWorld);
  const footprint = emptyRect();
  let top = -Infinity;
  let bottom = Infinity;
  let farthest = 0;
  let any = false;

  for (const caster of casters) {
    // Box center and radius (world) for the distance test.
    _p.addVectors(caster.min, caster.max).multiplyScalar(0.5).applyMatrix4(caster.matrix);
    const radius = _n.subVectors(caster.max, caster.min).length() / 2;
    if (_p.distanceTo(camera) - radius > options.maxDistance) continue;

    // Sun height over the box's own horizon: how long its shadows get.
    _n.setFromMatrixColumn(caster.matrix, 2).normalize();
    const sine = Math.max(z.dot(_n), minSunSine);
    const rect = emptyRect();
    let boxTop = -Infinity;
    let boxBottom = Infinity;
    let boxFar = 0;
    for (let i = 0; i < 8; i++) {
      const lz = i & 4 ? caster.max.z : caster.min.z;
      _p.set(i & 1 ? caster.max.x : caster.min.x, i & 2 ? caster.max.y : caster.min.y, lz).applyMatrix4(caster.matrix);
      boxFar = Math.max(boxFar, _q.subVectors(_p, camera).dot(_d));
      _p.sub(origin);
      const px = _p.dot(x);
      const py = _p.dot(y);
      const pz = _p.dot(z);
      extend(rect, px, py);
      boxTop = Math.max(boxTop, pz);
      // The corner's shadow on the ground below the base (the deepest receiver it can shade).
      const height = lz - caster.min.z + groundMargin;
      boxBottom = Math.min(boxBottom, pz - height / sine);
    }
    if (boxFar <= 0) continue; // entirely behind the camera
    any = true;
    extend(footprint, rect.x0, rect.y0);
    extend(footprint, rect.x1, rect.y1);
    top = Math.max(top, boxTop);
    bottom = Math.min(bottom, boxBottom);
    farthest = Math.max(farthest, boxFar);
  }
  if (!any) return null;

  // What the view can see of the light frame: the frustum, cut where shadows end.
  const far = Math.max(view.near * 2, Math.min(options.maxDistance, farthest));
  const seen = emptyRect();
  for (const c of frustumCorners(view, far)) {
    _p.subVectors(c, origin);
    extend(seen, _p.dot(x), _p.dot(y));
  }
  const x0 = Math.max(footprint.x0, seen.x0);
  const x1 = Math.min(footprint.x1, seen.x1);
  const y0 = Math.max(footprint.y0, seen.y0);
  const y1 = Math.min(footprint.y1, seen.y1);
  if (x0 >= x1 || y0 >= y1) return null;

  const halfSize = quantizeHalfSize(Math.max(x1 - x0, y1 - y0) / 2, options.mapSize, options.minHalfSize);
  const texel = (2 * halfSize) / options.mapSize;
  return {
    origin: origin.clone(),
    x,
    y,
    z,
    centerX: Math.round((x0 + x1) / 2 / texel) * texel,
    centerY: Math.round((y0 + y1) / 2 / texel) * texel,
    halfSize,
    top: Math.ceil((top + TOP_MARGIN) / DEPTH_STEP) * DEPTH_STEP,
    bottom: Math.floor(bottom / DEPTH_STEP) * DEPTH_STEP,
    texel,
  };
}

/** Whether two fits put the map at the same place (a still view keeps its shadow map). */
export function sameFit(a: ShadowFit | null, b: ShadowFit | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.origin.equals(b.origin) &&
    a.z.equals(b.z) &&
    a.x.equals(b.x) &&
    a.centerX === b.centerX &&
    a.centerY === b.centerY &&
    a.halfSize === b.halfSize &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}

/**
 * Camera → world matrix of the shadow camera for a fit: it sits at the map center at depth
 * `top`, looking down the sun's rays (-z), with `x` to the right and `y` up.
 */
export function shadowCameraMatrix(fit: ShadowFit, out = new Matrix4()): Matrix4 {
  const p = _p
    .copy(fit.origin)
    .addScaledVector(fit.x, fit.centerX)
    .addScaledVector(fit.y, fit.centerY)
    .addScaledVector(fit.z, fit.top);
  return out.makeBasis(fit.x, fit.y, fit.z).setPosition(p);
}
