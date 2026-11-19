/**
 * GPU tiers and the budgets that follow from them: frame buffer cost (pixel
 * ratio, MSAA), globe tile cache, the 3D Tiles memory and level-of-detail
 * settings, and the building model budget. Pure data and functions (no
 * three.js, no DOM), unit tested.
 *
 * Browsers do not tell a page how much video memory there is. The tier is
 * therefore a guess from what WebGPU does report (adapter vendor and
 * architecture, limits, `navigator.deviceMemory`), and it can always be set
 * explicitly (`GeoViewerOptions.gpuTier`, `?gpu=low|medium|high|ultra`).
 * `ultra` is never guessed. See docs/agents/gpu-memory.md.
 */

export type GpuTier = 'low' | 'medium' | 'high' | 'ultra';

/** Tiers from smallest to largest budget. @advanced */
export const GPU_TIERS: readonly GpuTier[] = ['low', 'medium', 'high', 'ultra'];

const MB = 2 ** 20;

/** What the page can find out about the graphics hardware before the renderer exists. @advanced */
export interface GpuHints {
  /** False when `navigator.gpu` gave no adapter (the renderer will fall back to WebGL 2). */
  webgpu: boolean;
  /** `GPUAdapterInfo.vendor`, lower case (`nvidia`, `amd`, `intel`, `apple`, `qualcomm`, `arm`, …); '' when unknown. */
  vendor: string;
  /** `GPUAdapterInfo.architecture`, lower case (`lovelace`, `xe-lpg`, `rdna-3`, …); '' when unknown. */
  architecture: string;
  /** Software rasterizer (SwiftShader, WARP). */
  fallbackAdapter: boolean;
  /** `adapter.limits.maxTextureDimension2D` in pixels (0 when unknown). */
  maxTextureSize: number;
  /** `navigator.deviceMemory` in GiB (Chromium only, rounded and capped by the browser); null when not exposed. */
  deviceMemoryGB: number | null;
  /** `navigator.hardwareConcurrency`; null when not exposed. */
  cores: number | null;
  /** Phone or tablet (user agent). */
  mobile: boolean;
}

/** 3D Tiles settings of a tier (applied by `Tiles3DLayer`). */
export interface TilesQuality {
  /** Multiplies each layer's `errorTarget` (above 1 = coarser tiles, fewer of them). */
  errorTargetScale: number;
  /**
   * Extra screen-space error distant tiles may have when the view is oblique,
   * as a multiple of the layer's error target (0 disables). See `lodPolicy.ts`.
   */
  errorFalloffScale: number;
  /**
   * Highest factor the error target may be raised by when the tile cache is
   * full and tiles are being refused (1 disables the adaptation).
   */
  adaptiveErrorMaxScale: number;
  /**
   * Tile cache: eviction keeps at least `cacheMinBytes` and loading stops at
   * `cacheMaxBytes`. An estimate of decoded tile content (geometry plus RGBA
   * textures) whether or not it is on the GPU: mostly system memory.
   */
  cacheMinBytes: number;
  cacheMaxBytes: number;
  /**
   * Target for tile content uploaded to the GPU: hidden tiles are freed from
   * the GPU (after `unloadDelayMs`) only while the total is above it.
   */
  gpuBytesTarget: number;
  /** Milliseconds a hidden tile stays on the GPU before it may be freed. */
  unloadDelayMs: number;
  /** Mipmaps for tile textures (a third more texture memory; without them oblique ground shimmers). */
  mipmaps: boolean;
  /** Anisotropic filtering of tile textures (1 = off). Needs mipmaps. */
  anisotropy: number;
  /** Tiles the traversal may initialize per frame (bounds the cost of opening a new subtree). */
  maxTilesProcessed: number;
  /** Concurrent tile parses (glTF, Draco, image decoding). */
  parseJobs: number;
  /** Concurrent tile downloads. */
  downloadJobs: number;
}

/** Building model settings of a tier (applied to `viewer.indoor`). */
export interface IndoorQuality {
  /**
   * Budget for loaded building glTF models (estimated GPU bytes): above it,
   * floor models hidden for `unloadDelayMs` are unloaded, least recently shown first.
   */
  modelBytesTarget: number;
  /** Milliseconds a floor stays hidden before its model may be unloaded. */
  unloadDelayMs: number;
  /** Texels along the longer side of a floor's ambient occlusion texture at most (`indoor.ambientOcclusion.maxResolution`). */
  aoMaxResolution: number;
}

/** Everything a tier decides. Explicit viewer / layer options take precedence over these. */
export interface GpuProfile {
  tier: GpuTier;
  /** Upper bound for the canvas pixel ratio (the frame buffers grow with its square). */
  maxPixelRatio: number;
  /** 4x MSAA (five times the color and depth memory of the canvas) or none. */
  antialias: boolean;
  globe: {
    /** Globe tiles kept loaded (each has a mesh and shares imagery textures). */
    maxCachedTiles: number;
    /** Anisotropic filtering of imagery. */
    maxAnisotropy: number;
    /**
     * Seconds the globe may stay hidden (e.g. under Google 3D Tiles) before
     * its tile cache is released down to `hiddenKeepTiles`; Infinity keeps it.
     */
    hiddenReleaseSeconds: number;
    hiddenKeepTiles: number;
  };
  tiles: TilesQuality;
  indoor: IndoorQuality;
}

const PROFILES: Record<GpuTier, GpuProfile> = {
  // Integrated graphics with little shared memory, phones, software rendering, WebGL fallback.
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    antialias: false,
    globe: { maxCachedTiles: 300, maxAnisotropy: 2, hiddenReleaseSeconds: 5, hiddenKeepTiles: 16 },
    tiles: {
      errorTargetScale: 1.5,
      errorFalloffScale: 1.5,
      adaptiveErrorMaxScale: 2.5,
      cacheMinBytes: 192 * MB,
      cacheMaxBytes: 256 * MB,
      gpuBytesTarget: 128 * MB,
      unloadDelayMs: 1500,
      mipmaps: false,
      anisotropy: 1,
      maxTilesProcessed: 60,
      parseJobs: 3,
      downloadJobs: 12,
    },
    indoor: { modelBytesTarget: 64 * MB, unloadDelayMs: 5000, aoMaxResolution: 512 },
  },
  // Current integrated graphics (Intel Xe / Arc, Radeon 600M-800M), entry discrete cards.
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    antialias: true,
    globe: { maxCachedTiles: 500, maxAnisotropy: 4, hiddenReleaseSeconds: 10, hiddenKeepTiles: 32 },
    tiles: {
      errorTargetScale: 1.2,
      errorFalloffScale: 1,
      adaptiveErrorMaxScale: 2,
      cacheMinBytes: 320 * MB,
      cacheMaxBytes: 448 * MB,
      gpuBytesTarget: 256 * MB,
      unloadDelayMs: 3000,
      mipmaps: true,
      anisotropy: 2,
      maxTilesProcessed: 100,
      parseJobs: 4,
      downloadJobs: 20,
    },
    indoor: { modelBytesTarget: 128 * MB, unloadDelayMs: 10_000, aoMaxResolution: 1024 },
  },
  // Discrete cards (4 GB and up), Apple silicon.
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    antialias: true,
    globe: { maxCachedTiles: 700, maxAnisotropy: 8, hiddenReleaseSeconds: 20, hiddenKeepTiles: 64 },
    tiles: {
      errorTargetScale: 1,
      errorFalloffScale: 1,
      adaptiveErrorMaxScale: 2,
      cacheMinBytes: 512 * MB,
      cacheMaxBytes: 768 * MB,
      gpuBytesTarget: 384 * MB,
      unloadDelayMs: 3000,
      mipmaps: true,
      anisotropy: 4,
      maxTilesProcessed: 150,
      parseJobs: 5,
      downloadJobs: 25,
    },
    indoor: { modelBytesTarget: 256 * MB, unloadDelayMs: 10_000, aoMaxResolution: 1024 },
  },
  // 12 GB cards and up, picked explicitly: large screens, long flights without reloading.
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2,
    antialias: true,
    globe: { maxCachedTiles: 1000, maxAnisotropy: 16, hiddenReleaseSeconds: 60, hiddenKeepTiles: 128 },
    tiles: {
      errorTargetScale: 0.8,
      errorFalloffScale: 0.5,
      adaptiveErrorMaxScale: 1.5,
      cacheMinBytes: 1024 * MB,
      cacheMaxBytes: 1536 * MB,
      gpuBytesTarget: 768 * MB,
      unloadDelayMs: 5000,
      mipmaps: true,
      anisotropy: 8,
      maxTilesProcessed: 250,
      parseJobs: 6,
      downloadJobs: 30,
    },
    indoor: { modelBytesTarget: 512 * MB, unloadDelayMs: 20_000, aoMaxResolution: 2048 },
  },
};

/** The settings of a tier (a fresh copy, safe to modify). @advanced */
export function gpuProfile(tier: GpuTier): GpuProfile {
  const p = PROFILES[tier];
  return { ...p, globe: { ...p.globe }, tiles: { ...p.tiles }, indoor: { ...p.indoor } };
}

/** `low` / `medium` / `high` / `ultra` (any case, surrounding spaces ignored), else undefined. @advanced */
export function parseGpuTier(value: string | null | undefined): GpuTier | undefined {
  const s = value?.trim().toLowerCase();
  return GPU_TIERS.find((t) => t === s);
}

/** Discrete GPU families by `GPUAdapterInfo.architecture` where the vendor also makes integrated ones. */
const INTEL_DISCRETE = /^xe\d*-hpg/;

/**
 * Guesses the tier from what the browser reports. Conservative where the
 * hardware cannot be told apart: AMD (the same architecture names cover
 * integrated and discrete parts) and unknown vendors land on `medium`.
 *
 * @advanced
 */
export function classifyGpu(hints: GpuHints): GpuTier {
  if (hints.fallbackAdapter || hints.mobile) return 'low';
  // No WebGPU adapter: the WebGL 2 fallback, with nothing known about the GPU. A desktop with many cores is
  // unlikely to be a weak machine; anything else is treated as one.
  if (!hints.webgpu) return (hints.cores ?? 0) >= 8 ? 'medium' : 'low';
  const memory = hints.deviceMemoryGB;
  if (memory !== null && memory <= 4) return 'low';
  // Desktop GPUs report 8192 or 16384; less means a constrained device.
  if (hints.maxTextureSize > 0 && hints.maxTextureSize < 8192) return 'low';
  const vendor = hints.vendor;
  if (vendor === 'nvidia') return 'high';
  if (vendor === 'apple') return memory !== null && memory < 8 ? 'medium' : 'high';
  if (vendor === 'intel') return INTEL_DISCRETE.test(hints.architecture) ? 'high' : 'medium';
  if (vendor === 'qualcomm' || vendor === 'arm' || vendor === 'img-tec' || vendor === 'imagination') return 'low';
  return 'medium';
}

/** Canvas pixel ratio a tier renders at for a display's `devicePixelRatio`. */
export function effectivePixelRatio(devicePixelRatio: number, maxPixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, maxPixelRatio);
}

export interface FramebufferEstimateInput {
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** MSAA sample count (1 = none). */
  samples: number;
  /** Pick buffer resolution relative to the canvas (0 = no pick buffer). */
  pickScale?: number;
}

/**
 * Video memory of the render targets, in bytes: the swap chain image
 * (4 bytes per pixel), with MSAA a multisampled color target, and a depth
 * target (32-bit float, per sample); the pick buffer adds an RGBA32Uint
 * color (16 bytes) and a depth target at its own resolution.
 */
export function estimateFramebufferBytes(input: FramebufferEstimateInput): number {
  const pixels = Math.max(0, input.width) * Math.max(0, input.height);
  const samples = Math.max(1, input.samples);
  const color = pixels * 4;
  const multisampled = samples > 1 ? pixels * 4 * samples : 0;
  const depth = pixels * 4 * samples;
  const scale = input.pickScale ?? 0;
  const pickPixels = Math.ceil(input.width * scale) * Math.ceil(input.height * scale);
  return color + multisampled + depth + pickPixels * (16 + 4);
}
