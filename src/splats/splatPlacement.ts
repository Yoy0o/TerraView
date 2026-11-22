/**
 * Where a splat scene sits on the globe: the conversion of the file's axes to the SDK's
 * local frame (X east, Y north, Z up), the pivot put on the anchor, and the model matrix
 * within the anchor's east-north-up frame. Pure math (no three.js), unit tested.
 * See docs/agents/splats.md §3.
 */
import type { SplatBounds } from './splatData';

const DEG2RAD = Math.PI / 180;

/**
 * Which way is up in the file:
 * - `'-y'`: Y points down and Z forward: what 3DGS training on COLMAP poses produces, and
 *   so most `.ply`, `.splat` and `.spz` files (default);
 * - `'+y'`: Y up, Z towards the viewer (glTF, files already turned for three.js or Blender exports);
 * - `'+z'`: Z up (surveyed data, files aligned in a GIS).
 */
export type SplatUpAxis = '-y' | '+y' | '+z';

/**
 * The point of the scene put on the layer's position:
 * - `'bottom'`: the middle of the scene's footprint, at its lowest point (default: it stands on the ground);
 * - `'center'`: the middle of the scene;
 * - `'origin'`: the origin of the file's coordinates (data that was aligned beforehand);
 * - `[x, y, z]`: a point in the file's coordinates.
 * "The scene" is its core bounds, without stray splats (`SplatBounds.coreMin` / `coreMax`).
 */
export type SplatPivot = 'bottom' | 'center' | 'origin' | readonly [number, number, number];

/** Row-major 3 × 3 rotations from file axes to X east, Y north, Z up. */
const AXES: Record<SplatUpAxis, readonly number[]> = {
  // x → east, z (forward) → north, −y → up
  '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
  // x → east, −z → north, y → up
  '+y': [1, 0, 0, 0, 0, -1, 0, 1, 0],
  '+z': [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

/** The rotation (row-major 3 × 3) taking file coordinates to the local frame (X east, Y north, Z up). */
export function upAxisMatrix(upAxis: SplatUpAxis): readonly number[] {
  return AXES[upAxis];
}

/** `m · v` for a row-major 3 × 3 matrix. */
export function rotate3(m: ArrayLike<number>, v: ArrayLike<number>): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** `mᵀ · v`: the inverse of a rotation. */
export function rotate3Inverse(m: ArrayLike<number>, v: ArrayLike<number>): [number, number, number] {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** A box given in file coordinates as a box in the local frame (the axes only swap and flip, so it stays exact). */
export function boxToLocal(min: ArrayLike<number>, max: ArrayLike<number>, upAxis: SplatUpAxis): { min: [number, number, number]; max: [number, number, number] } {
  const a = rotate3(AXES[upAxis], min);
  const b = rotate3(AXES[upAxis], max);
  return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
}

/** The pivot in file coordinates. */
export function resolvePivot(pivot: SplatPivot, bounds: SplatBounds, upAxis: SplatUpAxis): [number, number, number] {
  if (pivot === 'origin') return [0, 0, 0];
  if (typeof pivot !== 'string') return [pivot[0], pivot[1], pivot[2]];
  const box = boxToLocal(bounds.coreMin, bounds.coreMax, upAxis);
  const local: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, pivot === 'bottom' ? box.min[2] : (box.min[2] + box.max[2]) / 2];
  return rotate3Inverse(AXES[upAxis], local);
}

export interface SplatTransform {
  upAxis: SplatUpAxis;
  /** Pivot in file coordinates. */
  pivot: ArrayLike<number>;
  /** Degrees clockwise from north, about the up axis. */
  heading: number;
  /** Degrees about the east axis (positive lifts the north side). */
  pitch: number;
  /** Degrees about the north axis (positive lifts the west side). */
  roll: number;
  /** Meters per file unit. */
  scale: number;
}

/**
 * Model matrix from file coordinates to the anchor's east-north-up frame (meters), column
 * major like three.js's `Matrix4.elements`: heading · pitch · roll · scale · axes · (p − pivot).
 */
export function splatModelMatrix(t: SplatTransform, out: number[] = new Array<number>(16)): number[] {
  const h = -t.heading * DEG2RAD;
  const p = t.pitch * DEG2RAD;
  const r = t.roll * DEG2RAD;
  const [ch, sh, cp, sp, cr, sr] = [Math.cos(h), Math.sin(h), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
  // Rz(h) · Rx(p) · Ry(r), row major.
  const rot = [
    ch * cr - sh * sp * sr, -sh * cp, ch * sr + sh * sp * cr,
    sh * cr + ch * sp * sr, ch * cp, sh * sr - ch * sp * cr,
    -cp * sr, sp, cp * cr,
  ];
  const a = AXES[t.upAxis];
  const s = t.scale;
  // m = rot · a · s (3 × 3, row major); translation = −m · pivot.
  const m = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = (rot[i * 3] * a[j] + rot[i * 3 + 1] * a[3 + j] + rot[i * 3 + 2] * a[6 + j]) * s;
  const tr = rotate3(m, t.pivot);
  out[0] = m[0]; out[1] = m[3]; out[2] = m[6]; out[3] = 0;
  out[4] = m[1]; out[5] = m[4]; out[6] = m[7]; out[7] = 0;
  out[8] = m[2]; out[9] = m[5]; out[10] = m[8]; out[11] = 0;
  out[12] = -tr[0]; out[13] = -tr[1]; out[14] = -tr[2]; out[15] = 1;
  return out;
}

/**
 * How many pixels a sphere's radius covers on screen, for a perspective camera with the
 * given vertical field of view (degrees) and viewport height (pixels). Infinity inside the sphere.
 */
export function screenRadius(radius: number, distance: number, fovDeg: number, viewportHeight: number): number {
  if (distance <= radius) return Infinity;
  return (radius / distance) * (viewportHeight / (2 * Math.tan((fovDeg * DEG2RAD) / 2)));
}

/** Whether a sphere (center in view space, −Z forward) touches the view pyramid of a perspective camera (`tanX`, `tanY`: tangents of its half angles). */
export function sphereInView(x: number, y: number, z: number, radius: number, tanX: number, tanY: number): boolean {
  const depth = -z;
  if (depth + radius <= 0) return false;
  // Distance to a side plane through the eye: (|x| − depth · tan) / √(1 + tan²).
  if (Math.abs(x) - depth * tanX > radius * Math.sqrt(1 + tanX * tanX)) return false;
  if (Math.abs(y) - depth * tanY > radius * Math.sqrt(1 + tanY * tanY)) return false;
  return true;
}
