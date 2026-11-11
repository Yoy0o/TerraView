/**
 * Math of the GPU pick buffer (M2.1), shared by the TSL pick material and
 * the CPU decoder: octahedral normal encoding, `packSnorm2x16`, and
 * reconstructing a view-space position from a pixel and its view depth.
 * Pure functions on plain numbers (no three.js), so they are unit tested
 * against the GPU formulas.
 */

/**
 * Octahedral encoding of a unit vector to two values in [-1, 1]
 * (Cigolle et al. 2014, "A Survey of Efficient Representations for
 * Independent Unit Vectors"); the lower hemisphere folds over the diagonals.
 */
export function octEncode(x: number, y: number, z: number, out: [number, number] = [0, 0]): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    const fv = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = fu;
    v = fv;
  }
  out[0] = u;
  out[1] = v;
  return out;
}

/** Inverse of `octEncode`: a unit vector from two values in [-1, 1]. */
export function octDecode(u: number, v: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  let x = u;
  let y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const t = -z;
    x += x >= 0 ? -t : t;
    y += y >= 0 ? -t : t;
  }
  const len = Math.hypot(x, y, z) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

/** Signed normalized 16-bit value of a number in [-1, 1] (WGSL `packSnorm2x16` per component). */
function snorm16(v: number): number {
  return Math.round(Math.min(1, Math.max(-1, v)) * 32767) & 0xffff;
}

/** WGSL / GLSL `packSnorm2x16`: `a` in the low 16 bits, `b` in the high 16 bits. */
export function packSnorm2x16(a: number, b: number): number {
  return (snorm16(a) | (snorm16(b) << 16)) >>> 0;
}

/** Inverse of `packSnorm2x16`. */
export function unpackSnorm2x16(p: number, out: [number, number] = [0, 0]): [number, number] {
  const lo = (p & 0xffff) << 16 >> 16;
  const hi = p >> 16;
  out[0] = Math.max(-1, lo / 32767);
  out[1] = Math.max(-1, hi / 32767);
  return out;
}

/**
 * View-space position on the camera ray through normalized device
 * coordinates (x, y in [-1, 1], +y up) at view depth `viewZ` (negative in
 * front of a perspective camera). `projectionInverse` is the inverse
 * projection matrix (16 numbers, column-major, as `Matrix4.elements`).
 * Any depth convention works: only the ray direction is taken from the
 * matrix, the distance comes from `viewZ`.
 */
export function viewPositionFromDepth(
  ndcX: number,
  ndcY: number,
  viewZ: number,
  projectionInverse: ArrayLike<number>,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const e = projectionInverse;
  // Point on the ray at an arbitrary clip depth (0.5), then perspective divide.
  const z = 0.5;
  const w = e[3] * ndcX + e[7] * ndcY + e[11] * z + e[15];
  const x = (e[0] * ndcX + e[4] * ndcY + e[8] * z + e[12]) / w;
  const y = (e[1] * ndcX + e[5] * ndcY + e[9] * z + e[13]) / w;
  const vz = (e[2] * ndcX + e[6] * ndcY + e[10] * z + e[14]) / w;
  const s = viewZ / vz;
  out[0] = x * s;
  out[1] = y * s;
  out[2] = viewZ;
  return out;
}

/** Applies a column-major 4x4 matrix to a point (world position from a view position and the camera's world matrix). */
export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** Applies the rotation part of a column-major 4x4 matrix to a direction (view normal to world). */
export function transformDirection(m: ArrayLike<number>, x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const ox = m[0] * x + m[4] * y + m[8] * z;
  const oy = m[1] * x + m[5] * y + m[9] * z;
  const oz = m[2] * x + m[6] * y + m[10] * z;
  const len = Math.hypot(ox, oy, oz) || 1;
  out[0] = ox / len;
  out[1] = oy / len;
  out[2] = oz / len;
  return out;
}

/**
 * Pixel of a buffer (`width` × `height`, row 0 at the top) under a point
 * given as a fraction of the canvas (0..1 from the left / top edge); null
 * outside.
 */
export function bufferPixel(fx: number, fy: number, width: number, height: number): [number, number] | null {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return null;
  return [Math.min(width - 1, Math.floor(fx * width)), Math.min(height - 1, Math.floor(fy * height))];
}

/** One decoded pick sample. */
export interface PickSample {
  /** Object id (0 = nothing drawn). */
  objectId: number;
  /** Instance index of an instanced draw (0 otherwise). */
  instanceId: number;
  /** View-space depth (negative in front of the camera). */
  viewZ: number;
  /** View-space unit normal. */
  normal: [number, number, number];
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const _oct: [number, number] = [0, 0];

/** `bitcast<f32>` of a uint (WGSL `bitcast`, the inverse of `floatBitsToUint`). */
export function uintBitsToFloat(u: number): number {
  _u32[0] = u;
  return _f32[0];
}

/** `floatBitsToUint` (for tests and fabricated buffers). */
export function floatBitsToUint(f: number): number {
  _f32[0] = f;
  return _u32[0];
}

/** Decodes the RGBA32Uint texel at (px, py) of a tightly packed buffer; null where nothing was drawn. */
export function decodeTexel(data: Uint32Array, width: number, px: number, py: number): PickSample | null {
  const o = (py * width + px) * 4;
  const objectId = data[o];
  if (objectId === 0) return null;
  unpackSnorm2x16(data[o + 3], _oct);
  return { objectId, instanceId: data[o + 1], viewZ: uintBitsToFloat(data[o + 2]), normal: octDecode(_oct[0], _oct[1]) };
}
