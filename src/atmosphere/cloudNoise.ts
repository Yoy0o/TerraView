/**
 * Tileable 3D noise for the volumetric clouds (no three.js: it runs in a Worker,
 * `cloudNoise.worker.ts`, and in the unit tests).
 *
 * One RGBA8 volume of `size`³ texels that repeats seamlessly on every axis
 * (period 1 in texture coordinates), in the layout of Schneider's cloud
 * noises (Guerrilla Games, "The Real-time Volumetric Cloudscapes of Horizon
 * Zero Dawn", SIGGRAPH 2015):
 *
 * - R: Perlin-Worley: fractal Perlin noise (4, 8 and 16 cells per period) lifted by
 *   inverted Worley noise, billowy blobs for the base shape.
 * - G, B, A: inverted Worley noise, one octave each (4, 8 and 16 cells per period),
 *   summed into fractal noise by the shaders, which drop the octaves that get
 *   smaller than a pixel (the volume has no mipmaps), for eroding the base shape and,
 *   sampled at a smaller scale, for the wispy detail at the edges.
 *
 * The shaders sample the same volume at three scales (weather cells, base shape,
 * detail), so a single 1 MB texture (64³) serves all of them.
 */

import { CLOUD_NOISE_SIZE } from './volumetricCloudMath';

export { CLOUD_NOISE_SIZE };

/** Fixed seed: every page and every viewer gets the same noise (and the same clouds). */
const SEED = 0x2f6b9c1d;

/** 32-bit integer hash of three lattice coordinates → [0, 1). */
function hash3(i: number, j: number, k: number, seed: number): number {
  let h = Math.imul(i | 0, 0x8da6b343) ^ Math.imul(j | 0, 0xd8163841) ^ Math.imul(k | 0, 0xcb1ab31f) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The 12 edge directions of a cube (Perlin's improved noise gradients). */
const GRADIENTS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Gradient noise in about [-1, 1], periodic with `period` lattice cells (coordinates in cells). */
export function periodicPerlin(x: number, y: number, z: number, period: number, seed = SEED): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const g = (dx: number, dy: number, dz: number): number => {
    const h = hash3(mod(xi + dx, period), mod(yi + dy, period), mod(zi + dz, period), seed);
    const v = GRADIENTS[Math.floor(h * 12) % 12];
    return v[0] * (xf - dx) + v[1] * (yf - dy) + v[2] * (zf - dz);
  };
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  return lerp(
    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v),
    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v),
    w,
  );
}

/**
 * Feature points of a periodic Worley grid: one per cell, `cells`³ cells, stored
 * as offsets within their cell (x, y, z in [0, 1)).
 */
function featurePoints(cells: number, seed: number): Float32Array {
  const points = new Float32Array(cells * cells * cells * 3);
  for (let k = 0; k < cells; k++) {
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const n = ((k * cells + j) * cells + i) * 3;
        points[n] = hash3(i, j, k, seed);
        points[n + 1] = hash3(i, j, k, seed ^ 0x51ed27);
        points[n + 2] = hash3(i, j, k, seed ^ 0x2a9b61);
      }
    }
  }
  return points;
}

/** Distance to the nearest feature point, in cell units (0 at a point, rarely above 1). */
function worleyF1(points: Float32Array, cells: number, x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = zi + dz;
    const kz = mod(cz, cells);
    for (let dy = -1; dy <= 1; dy++) {
      const cy = yi + dy;
      const ky = mod(cy, cells);
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const n = ((kz * cells + ky) * cells + mod(cx, cells)) * 3;
        const px = cx + points[n] - x;
        const py = cy + points[n + 1] - y;
        const pz = cz + points[n + 2] - z;
        const d = px * px + py * py + pz * pz;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

/** Worley frequencies (cells per period) of the channels. */
const WORLEY_CELLS = [4, 8, 16] as const;

/** Lazily built feature points per frequency (shared by all evaluations). */
let grids: Float32Array[] | null = null;

function worleyGrids(): Float32Array[] {
  if (!grids) grids = WORLEY_CELLS.map((c, i) => featurePoints(c, SEED + 977 * (i + 1)));
  return grids;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The noise at a point of the unit period cube (coordinates repeat with period 1):
 * [Perlin-Worley, Worley 4, Worley 8, Worley 16], each 0–1 (before the stretch of
 * `generateCloudNoise`).
 */
export function sampleCloudNoise(x: number, y: number, z: number, out: number[] = [0, 0, 0, 0]): number[] {
  const g = worleyGrids();
  const w = WORLEY_CELLS.map((c, i) => clamp01(1 - worleyF1(g[i], c, x * c, y * c, z * c)));
  const lowFbm = w[0] * 0.625 + w[1] * 0.25 + w[2] * 0.125;
  // Fractal Perlin noise, 3 octaves from 4 cells per period.
  let perlin = 0;
  let amplitude = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    const c = 4 << o;
    perlin += periodicPerlin(x * c, y * c, z * c, c, SEED ^ (o * 0x9e3779b1)) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
  }
  const p01 = clamp01((perlin / norm) * 0.75 + 0.5);
  // Perlin-Worley: remap(perlin, 0, 1, worley, 1): billows wherever the cells are.
  out[0] = clamp01(lowFbm + p01 * (1 - lowFbm));
  out[1] = w[0];
  out[2] = w[1];
  out[3] = w[2];
  return out;
}

/**
 * The whole volume, RGBA8, x fastest then y then z (the layout of a three.js
 * `Data3DTexture`). Texel (i, j, k) holds the noise at its center ((i + 0.5) / size, …),
 * each channel stretched to the full 0–255 range (its own minimum and maximum over the
 * volume), so the shaders' thresholds see all 8 bits. About 0.5 s for 64³ (run it in a Worker).
 */
export function generateCloudNoise(size = CLOUD_NOISE_SIZE): Uint8Array {
  const count = size * size * size;
  const values = new Float32Array(count * 4);
  const lo = [Infinity, Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0, 0];
  for (let k = 0; k < size; k++) {
    const z = (k + 0.5) / size;
    for (let j = 0; j < size; j++) {
      const y = (j + 0.5) / size;
      for (let i = 0; i < size; i++) {
        sampleCloudNoise((i + 0.5) / size, y, z, v);
        const n = ((k * size + j) * size + i) * 4;
        for (let c = 0; c < 4; c++) {
          values[n + c] = v[c];
          if (v[c] < lo[c]) lo[c] = v[c];
          if (v[c] > hi[c]) hi[c] = v[c];
        }
      }
    }
  }
  const data = new Uint8Array(count * 4);
  const scale = hi.map((h, c) => (h > lo[c] ? 255 / (h - lo[c]) : 0));
  for (let n = 0; n < values.length; n++) {
    const c = n & 3;
    data[n] = Math.round((values[n] - lo[c]) * scale[c]);
  }
  return data;
}
