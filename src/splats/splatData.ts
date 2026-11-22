/**
 * Decoded 3D Gaussian splats and the operations on them that need no renderer:
 * covariance packing, bounds that ignore stray splats, the budget (which splats to
 * keep), cropping and the memory estimate. Shared by the decoding Worker and the main
 * thread: no three.js, no DOM. See docs/agents/splats.md.
 *
 * The arrays have the layout three.js's `GaussianSplat` takes
 * (`createGaussianSplatGeometry`), so they are handed over without another copy.
 */

/** Spherical harmonics degree of the view-dependent color (0 = one color per splat). */
export type SplatShDegree = 0 | 1 | 2 | 3;

/** Coefficients (bytes) of an SH band per splat: 3, 5 and 7 RGB vectors. */
export const SH_BAND_COMPONENTS: readonly number[] = [0, 9, 15, 21];
/** Uint32 words of an SH band per splat (four coefficient bytes a word). */
export const SH_BAND_WORDS: readonly number[] = [0, 3, 4, 6];
/** Zeroth-order SH basis constant: color = 0.5 + SH_C0 × f_dc. */
export const SH_C0 = 0.2820947917738781;

/**
 * Splats in the coordinates of their file. Colors are display (sRGB) values as stored by
 * 3DGS training; spherical harmonics bands are bytes `(value × 128 + 128)` packed four to
 * a word, coefficient-major (RGB, RGB, …).
 */
export interface SplatData {
  count: number;
  /** Centers: x, y, z per splat. */
  centers: Float32Array;
  /** Covariance, upper triangle per splat: xx, xy, xz, yy, yz, zz. */
  covariances: Float32Array;
  /** R, G, B (display values) and opacity, one byte each. */
  colors: Uint8Array;
  shDegree: SplatShDegree;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3?: Uint32Array;
}

/** A box or a sphere in a layer's local frame (see `SplatLayerOptions.crop`). */
export type SplatCrop =
  | { type: 'box'; min: readonly [number, number, number]; max: readonly [number, number, number] }
  | { type: 'sphere'; center: readonly [number, number, number]; radius: number };

/** Bounds of splat centers. */
export interface SplatBounds {
  /** Box holding all centers. */
  min: [number, number, number];
  max: [number, number, number];
  /** Box without the outermost centers on each axis (`trim` of them on either side): what the scene is, without floaters. */
  coreMin: [number, number, number];
  coreMax: [number, number, number];
}

/** The SH band array of a degree (1–3), if the data has it. */
export function shBand(data: SplatData, degree: number): Uint32Array | undefined {
  return degree === 1 ? data.sh1 : degree === 2 ? data.sh2 : degree === 3 ? data.sh3 : undefined;
}

/** An SH band filled with zero coefficients (byte 128). */
export function createShBand(count: number, degree: number): { words: Uint32Array; bytes: Uint8ClampedArray } {
  const words = new Uint32Array(count * SH_BAND_WORDS[degree]);
  words.fill(0x80808080);
  return { words, bytes: new Uint8ClampedArray(words.buffer) };
}

/**
 * Writes the covariance Σ = R S Sᵀ Rᵀ of a splat with scale (sx, sy, sz) and rotation
 * quaternion (x, y, z, w; normalized here) as its upper triangle.
 */
export function writeCovariance(target: Float32Array, offset: number, sx: number, sy: number, sz: number, qx: number, qy: number, qz: number, qw: number): void {
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;
  // Columns of M = R S.
  const m00 = (1 - 2 * (y * y + z * z)) * sx;
  const m10 = 2 * (x * y + w * z) * sx;
  const m20 = 2 * (x * z - w * y) * sx;
  const m01 = 2 * (x * y - w * z) * sy;
  const m11 = (1 - 2 * (x * x + z * z)) * sy;
  const m21 = 2 * (y * z + w * x) * sy;
  const m02 = 2 * (x * z + w * y) * sz;
  const m12 = 2 * (y * z - w * x) * sz;
  const m22 = (1 - 2 * (x * x + y * y)) * sz;
  target[offset] = m00 * m00 + m01 * m01 + m02 * m02;
  target[offset + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  target[offset + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  target[offset + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  target[offset + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  target[offset + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

/**
 * Bounds of the centers. The core box drops the outermost `trim` (0–0.2, default 0.01) of
 * the centers on either side of each axis: trained scenes have stray splats far away that
 * would otherwise decide where a scene is placed and how the camera frames it. The
 * percentiles come from at most `maxSamples` evenly spaced centers.
 */
export function computeSplatBounds(data: SplatData, trim = 0.01, maxSamples = 100_000): SplatBounds {
  const { centers, count } = data;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0], coreMin: [0, 0, 0], coreMax: [0, 0, 0] };
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = centers[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const step = Math.max(1, Math.floor(count / maxSamples));
  const n = Math.ceil(count / step);
  const axis = new Float32Array(n);
  const coreMin: [number, number, number] = [0, 0, 0];
  const coreMax: [number, number, number] = [0, 0, 0];
  const t = Math.min(0.2, Math.max(0, trim));
  for (let a = 0; a < 3; a++) {
    for (let k = 0; k < n; k++) axis[k] = centers[k * step * 3 + a];
    axis.sort();
    coreMin[a] = axis[Math.floor(t * (n - 1))];
    coreMax[a] = axis[Math.ceil((1 - t) * (n - 1))];
  }
  return { min, max, coreMin, coreMax };
}

/** A copy of the data with only the splats at `indices`, in that order. */
export function selectSplats(data: SplatData, indices: Uint32Array): SplatData {
  const count = indices.length;
  const centers = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  const out: SplatData = { count, centers, covariances, colors, shDegree: data.shDegree };
  for (let k = 0; k < count; k++) {
    const i = indices[k];
    centers.set(data.centers.subarray(i * 3, i * 3 + 3), k * 3);
    covariances.set(data.covariances.subarray(i * 6, i * 6 + 6), k * 6);
    colors.set(data.colors.subarray(i * 4, i * 4 + 4), k * 4);
  }
  for (let degree = 1; degree <= data.shDegree; degree++) {
    const source = shBand(data, degree)!;
    const words = SH_BAND_WORDS[degree];
    const band = new Uint32Array(count * words);
    for (let k = 0; k < count; k++) band.set(source.subarray(indices[k] * words, indices[k] * words + words), k * words);
    if (degree === 1) out.sh1 = band;
    else if (degree === 2) out.sh2 = band;
    else out.sh3 = band;
  }
  return out;
}

/** The data with spherical harmonics above `maxDegree` dropped (no copy of what stays). */
export function limitShDegree(data: SplatData, maxDegree: number): SplatData {
  const degree = Math.max(0, Math.min(data.shDegree, Math.floor(maxDegree))) as SplatShDegree;
  if (degree === data.shDegree) return data;
  const out: SplatData = { count: data.count, centers: data.centers, covariances: data.covariances, colors: data.colors, shDegree: degree };
  if (degree >= 1) out.sh1 = data.sh1;
  if (degree >= 2) out.sh2 = data.sh2;
  return out;
}

/**
 * How much a splat adds to the picture, for the budget: opacity × the sum of its variances
 * (its extent squared). Splats with no opacity or a degenerate shape score 0.
 */
export function splatImportance(data: SplatData, i: number): number {
  const c = data.covariances;
  const size = c[i * 6] + c[i * 6 + 3] + c[i * 6 + 5];
  return size > 0 && Number.isFinite(size) ? (data.colors[i * 4 + 3] / 255) * size : 0;
}

/**
 * Indices of the splats to keep within a budget of `maxSplats`, in file order (training
 * order keeps neighbors together, which the sort and the caches like). Drops splats that
 * cannot be drawn at all (zero opacity, non-finite center or shape) first, then the least
 * important ones (`splatImportance`). Null when every splat stays.
 */
export function budgetSplats(data: SplatData, maxSplats: number): Uint32Array | null {
  const { count, centers } = data;
  const scores = new Float32Array(count);
  let drawable = 0;
  for (let i = 0; i < count; i++) {
    const finite = Number.isFinite(centers[i * 3]) && Number.isFinite(centers[i * 3 + 1]) && Number.isFinite(centers[i * 3 + 2]);
    const s = finite ? splatImportance(data, i) : 0;
    scores[i] = s;
    if (s > 0) drawable++;
  }
  const keep = Math.max(0, Math.min(drawable, Math.floor(maxSplats)));
  if (keep === count) return null;
  // The score of the last splat that stays.
  let threshold = 0;
  if (keep < drawable) {
    const sorted = scores.slice().sort();
    threshold = sorted[count - keep];
  }
  const out = new Uint32Array(keep);
  let n = 0;
  // Above the threshold first, then ties at the threshold until the budget is full.
  let ties = keep;
  for (let i = 0; i < count; i++) if (scores[i] > threshold) ties--;
  for (let i = 0; i < count && n < keep; i++) {
    const s = scores[i];
    if (s > threshold) out[n++] = i;
    else if (s === threshold && s > 0 && ties > 0) {
      out[n++] = i;
      ties--;
    }
  }
  return n === keep ? out : out.subarray(0, n);
}

/**
 * Indices of the splats whose center lies in a crop shape. The shape is given in a frame
 * reached from file coordinates by `local = M (p − pivot)` with `M` a row-major 3 × 3
 * matrix (a layer's axis conversion).
 */
export function cropSplats(data: SplatData, crop: SplatCrop, matrix: ArrayLike<number>, pivot: ArrayLike<number>): Uint32Array {
  const { centers, count } = data;
  const out = new Uint32Array(count);
  let n = 0;
  const r2 = crop.type === 'sphere' ? crop.radius * crop.radius : 0;
  for (let i = 0; i < count; i++) {
    const px = centers[i * 3] - pivot[0];
    const py = centers[i * 3 + 1] - pivot[1];
    const pz = centers[i * 3 + 2] - pivot[2];
    const x = matrix[0] * px + matrix[1] * py + matrix[2] * pz;
    const y = matrix[3] * px + matrix[4] * py + matrix[5] * pz;
    const z = matrix[6] * px + matrix[7] * py + matrix[8] * pz;
    let inside: boolean;
    if (crop.type === 'sphere') {
      const dx = x - crop.center[0];
      const dy = y - crop.center[1];
      const dz = z - crop.center[2];
      inside = dx * dx + dy * dy + dz * dz <= r2;
    } else {
      inside = x >= crop.min[0] && x <= crop.max[0] && y >= crop.min[1] && y <= crop.max[1] && z >= crop.min[2] && z <= crop.max[2];
    }
    if (inside) out[n++] = i;
  }
  return out.slice(0, n);
}

/**
 * Estimated video memory of `count` splats drawn by three.js's `GaussianSplat`, in bytes:
 * center, covariance (two vec4) and color buffers, the SH bands, and the sort's order and
 * key buffers; on WebGPU also the per-splat SH color the compute pass writes.
 */
export function splatGpuBytes(count: number, shDegree: number, webgpu = true): number {
  let perSplat = 16 + 16 + 16 + 4 + 4 + 4;
  for (let degree = 1; degree <= shDegree; degree++) perSplat += SH_BAND_WORDS[degree] * 4;
  if (shDegree > 0 && webgpu) perSplat += 16;
  return count * perSplat;
}

/** The transferable buffers of the data (posting it to or from a Worker). */
export function splatTransferables(data: SplatData): ArrayBuffer[] {
  const list = [data.centers.buffer, data.covariances.buffer, data.colors.buffer];
  for (let degree = 1; degree <= data.shDegree; degree++) list.push(shBand(data, degree)!.buffer);
  return list as ArrayBuffer[];
}
