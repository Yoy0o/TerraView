/**
 * Options and CPU-side math of the volumetric clouds (`VolumetricClouds`): option
 * validation, the camera-height fade, the cloud layer seen as two spheres around the
 * camera's local center of curvature (the same formulas the shaders use), the ray-march
 * step growth, the reduced-resolution history and its 2 × 2 interleave, and the extents
 * of the weather and cloud-shadow maps. Pure functions, no three.js: unit-tested.
 */
import { smoothstep } from '../core/math';

export interface VolumetricCloudOptions {
  /**
   * Draw volumetric clouds near the ground while the cloud layer is visible (default
   * true; the viewer turns it off on the `low` GPU tier unless set explicitly).
   */
  enabled?: boolean;
  /** Cloud base, meters above the ellipsoid (default 1,500; 0–15,000). */
  bottom?: number;
  /** Depth of the cloud layer, meters (default 2,500; 200–10,000). */
  thickness?: number;
  /** Wind speed, meters per second (default 6; 0–60; 0 holds the clouds still). */
  windSpeed?: number;
  /** Direction the clouds move toward, degrees clockwise from north (default 60). */
  windHeading?: number;
  /** Optical density, a multiplier (default 1; 0.1–4): thinner or thicker clouds. */
  density?: number;
  /** Clouds shade the ground, buildings and 3D Tiles while `viewer.lighting` is on (default true). */
  shadows?: boolean;
  /**
   * Camera heights in meters [fully shown below, hidden above] (default [100 km, 300 km]):
   * the volumetric clouds fade out on the way up, where the cloud shell takes over.
   */
  fadeHeights?: [number, number];
  /** Clouds end this far beyond where the view ray enters the layer, meters (default 80,000; 10,000–200,000). */
  maxDistance?: number;
}

export const VOLUMETRIC_CLOUD_DEFAULTS: Required<VolumetricCloudOptions> = {
  enabled: true,
  bottom: 1500,
  thickness: 2500,
  windSpeed: 6,
  windHeading: 60,
  density: 1,
  shadows: true,
  fadeHeights: [100_000, 300_000],
  maxDistance: 80_000,
};

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Clamps and validates volumetric options; invalid values are dropped (the current value is kept). */
export function normalizeVolumetricOptions(options: VolumetricCloudOptions): VolumetricCloudOptions {
  const out: VolumetricCloudOptions = {};
  if (typeof options.enabled === 'boolean') out.enabled = options.enabled;
  if (isNum(options.bottom)) out.bottom = clampTo(options.bottom, 0, 15_000);
  if (isNum(options.thickness)) out.thickness = clampTo(options.thickness, 200, 10_000);
  if (isNum(options.windSpeed)) out.windSpeed = clampTo(options.windSpeed, 0, 60);
  if (isNum(options.windHeading)) out.windHeading = ((options.windHeading % 360) + 360) % 360;
  if (isNum(options.density)) out.density = clampTo(options.density, 0.1, 4);
  if (typeof options.shadows === 'boolean') out.shadows = options.shadows;
  const f = options.fadeHeights;
  if (Array.isArray(f) && f.length === 2 && isNum(f[0]) && isNum(f[1]) && f[0] >= 0 && f[1] > f[0]) out.fadeHeights = [f[0], f[1]];
  if (isNum(options.maxDistance)) out.maxDistance = clampTo(options.maxDistance, 10_000, 200_000);
  return out;
}

/** Visibility of the volumetric clouds (0–1) for a camera height in meters. */
export function volumetricFade(cameraHeight: number, fadeHeights: readonly [number, number]): number {
  return 1 - smoothstep(fadeHeights[0], fadeHeights[1], cameraHeight);
}

/**
 * Gaussian radius of curvature √(M·N) of an ellipsoid at a geodetic latitude (radians):
 * the sphere that best matches the surface around a point, used as the clouds' local
 * Earth (heights stay within meters of the ellipsoid's over the 100 km the clouds reach).
 */
export function localEarthRadius(latitude: number, a: number, b: number): number {
  const e2 = 1 - (b * b) / (a * a);
  const s = Math.sin(latitude);
  const w = 1 - e2 * s * s;
  const n = a / Math.sqrt(w);
  const m = (a * (1 - e2)) / (w * Math.sqrt(w));
  return Math.sqrt(m * n);
}

/**
 * Where a ray from height `h0` (meters above a sphere of radius `radius`), with
 * cosine `mu` between the ray and the local vertical, crosses the sphere at height
 * `hs`: [near, far] distances (either may be negative: behind), or null when it misses.
 * The constant term is written as (h0 − hs)(2R + h0 + hs) and the near root in the
 * stable form, so nothing cancels in float32 (the shaders use the same formulas).
 */
export function shellRoots(h0: number, mu: number, hs: number, radius: number): [number, number] | null {
  const b = (radius + h0) * mu;
  const c = (h0 - hs) * (2 * radius + h0 + hs);
  const d = b * b - c;
  if (d < 0) return null;
  const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(d));
  const other = Math.abs(q) > 1e-9 ? c / q : 0;
  return [Math.min(q, other), Math.max(q, other)];
}

/**
 * The part of a ray inside the cloud layer [bottom, top] (heights in meters), nearest
 * stretch only: [start, end] distances from the origin, or null when the ray stays out.
 * Also stops at the sphere itself (the ground of the local Earth).
 */
export function cloudInterval(h0: number, mu: number, bottom: number, top: number, radius: number): [number, number] | null {
  const outer = shellRoots(h0, mu, top, radius);
  if (!outer || outer[1] <= 0) return null;
  const inner = shellRoots(h0, mu, bottom, radius);
  let start = 0;
  let end = outer[1];
  if (h0 < bottom) {
    // Below the layer: from where the ray leaves the inner sphere (never, if it hits the ground first).
    if (!inner) return null;
    start = Math.max(inner[1], 0);
  } else if (h0 > top) {
    start = Math.max(outer[0], 0);
    if (inner && inner[0] > 0) end = inner[0];
  } else if (inner && inner[0] > 0) {
    end = inner[0];
  }
  const ground = shellRoots(h0, mu, 0, radius);
  if (ground && ground[0] > 0) end = Math.min(end, ground[0]);
  return end > start ? [start, end] : null;
}

/**
 * Growth g of the ray-march step (step = minStep + g · distance marched) such that
 * `steps` steps cover `distance` meters: n(g) = ln(1 + g·D/m) / ln(1 + g), solved by bisection.
 */
export function stepGrowth(steps: number, minStep: number, distance: number): number {
  if (steps * minStep >= distance) return 0;
  const n = (g: number) => Math.log1p((g * distance) / minStep) / Math.log1p(g);
  let lo = 1e-5;
  let hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (n(mid) > steps) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Size of the cloud history for a drawing buffer: at most half its resolution and at most
 * `maxPixels` pixels, rounded to even sizes so the trace (a quarter of the history, 2 × 2
 * interleaved) covers it exactly.
 */
export function historySize(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(0.5, Math.sqrt(Math.max(maxPixels, 4) / (w * h)));
  return { width: Math.max(2, 2 * Math.ceil((w * scale) / 2)), height: Math.max(2, 2 * Math.ceil((h * scale) / 2)) };
}

/**
 * Which pixel of each 2 × 2 history block the trace refreshes, frame after frame: diagonal
 * first, so consecutive frames fill opposite corners (no block is refreshed twice in a row).
 */
export const INTERLEAVE_SLOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

/** Texels along each side of the cloud noise volume (`cloudNoise.ts`). */
export const CLOUD_NOISE_SIZE = 64;

/** Weather and shadow map coverage the camera may drift from before the maps are drawn again, meters. */
export const WEATHER_SLACK = 15_000;

/**
 * Most the weather map reaches from its center, meters: its 512 texels then stay under ~900 m,
 * a quarter of a weather cell. Coarser texels lose the cells (the clouds turn into an even
 * haze); beyond the map the clouds fade out, high up where the cloud shell takes over.
 */
export const WEATHER_MAX_REACH = 220_000;

/**
 * Full width (meters) of the weather map around the camera: the clouds' reach plus slack,
 * more when the camera is high (it then sees farther), up to `WEATHER_MAX_REACH`.
 */
export function weatherExtent(maxDistance: number, cameraHeight: number): number {
  const near = maxDistance + 2 * WEATHER_SLACK;
  const far = Math.min(WEATHER_MAX_REACH, maxDistance + 4 * Math.max(cameraHeight, 0));
  return 2 * Math.max(near, far);
}

/** Half width of the cloud shadow map, meters: shadows reach this far from the camera. */
export const CLOUD_SHADOW_RANGE = 15_000;

/**
 * Noise scales, meters per period of the 64³ noise volume: the weather's cell field and
 * its large clusters (baked into the weather map), the base shape and the edge detail.
 */
export const CLOUD_SCALES = {
  /** Worley cells of the weather: 4 cells per period → individual clouds ~3.5 km apart. */
  cells: 14_000,
  /** Perlin-Worley clusters of the weather: clear and cloudy areas some 15 km across. */
  clusters: 60_000,
  /** Variation of cloud tops. */
  tops: 23_000,
  /** Base shape: Perlin-Worley billows ~1.1 km. */
  shape: 4_500,
  /** Edge detail: Worley wisps 20–75 m. */
  detail: 600,
} as const;

/** Fractional part of x / period, in [0, 1) (float64 on the CPU: shader noise coordinates stay small). */
export function periodicFraction(x: number, period: number): number {
  const q = x / period;
  return q - Math.floor(q);
}
