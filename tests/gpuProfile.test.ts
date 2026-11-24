/**
 * GPU tiers and budgets (core/gpuProfile), the 3D Tiles level-of-detail
 * policy (tiles3d/lodPolicy) and the tile texture policy.
 */
import { LinearFilter, LinearMipmapLinearFilter, NearestFilter, NearestMipmapNearestFilter } from 'three';
import { describe, expect, it } from 'vitest';
import {
  classifyGpu,
  effectivePixelRatio,
  estimateFramebufferBytes,
  gpuProfile,
  GPU_TIERS,
  parseGpuTier,
  type GpuHints,
} from '../src/core/gpuProfile';
import {
  createAdaptiveErrorState,
  FALLOFF_DENSITY,
  FALLOFF_FADE_END,
  stepAdaptiveError,
  tilesFalloffDensity,
} from '../src/tiles3d/lodPolicy';
import { CLOUD_SCALES, WEATHER_MAX_REACH } from '../src/clouds/volumetricCloudMath';
import { applyTexturePolicy, type PolicyTexture } from '../src/tiles3d/nodeMaterials';

const MB = 2 ** 20;

function hints(over: Partial<GpuHints> = {}): GpuHints {
  return { webgpu: true, vendor: '', architecture: '', fallbackAdapter: false, maxTextureSize: 8192, deviceMemoryGB: 8, cores: 8, mobile: false, ...over };
}

describe('classifyGpu', () => {
  it('rates discrete vendors high and integrated graphics medium', () => {
    expect(classifyGpu(hints({ vendor: 'nvidia', architecture: 'lovelace' }))).toBe('high');
    expect(classifyGpu(hints({ vendor: 'intel', architecture: 'xe-lpg' }))).toBe('medium');
    expect(classifyGpu(hints({ vendor: 'intel', architecture: 'gen-12lp' }))).toBe('medium');
    // Intel Arc cards (Alchemist, Battlemage) are discrete.
    expect(classifyGpu(hints({ vendor: 'intel', architecture: 'xe-hpg' }))).toBe('high');
    expect(classifyGpu(hints({ vendor: 'intel', architecture: 'xe2-hpg' }))).toBe('high');
    // AMD names do not tell integrated from discrete: stay in the middle.
    expect(classifyGpu(hints({ vendor: 'amd', architecture: 'rdna-3' }))).toBe('medium');
    expect(classifyGpu(hints({ vendor: 'apple' }))).toBe('high');
    expect(classifyGpu(hints({ vendor: 'apple', deviceMemoryGB: 4.5 }))).toBe('medium');
    expect(classifyGpu(hints({ vendor: 'something-new' }))).toBe('medium');
  });

  it('rates constrained devices low whatever the vendor', () => {
    expect(classifyGpu(hints({ vendor: 'nvidia', fallbackAdapter: true }))).toBe('low');
    expect(classifyGpu(hints({ vendor: 'nvidia', mobile: true }))).toBe('low');
    expect(classifyGpu(hints({ vendor: 'nvidia', deviceMemoryGB: 4 }))).toBe('low');
    expect(classifyGpu(hints({ vendor: 'intel', maxTextureSize: 4096 }))).toBe('low');
    expect(classifyGpu(hints({ vendor: 'qualcomm' }))).toBe('low');
    expect(classifyGpu(hints({ vendor: 'arm' }))).toBe('low');
  });

  it('falls back on the core count without a WebGPU adapter', () => {
    expect(classifyGpu(hints({ webgpu: false, cores: 16 }))).toBe('medium');
    expect(classifyGpu(hints({ webgpu: false, cores: 4 }))).toBe('low');
    expect(classifyGpu(hints({ webgpu: false, cores: null }))).toBe('low');
    expect(classifyGpu(hints({ webgpu: false, cores: 16, mobile: true }))).toBe('low');
  });

  it('never guesses ultra', () => {
    const vendors = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', ''];
    for (const vendor of vendors) expect(classifyGpu(hints({ vendor, deviceMemoryGB: 64, cores: 64, maxTextureSize: 16384 }))).not.toBe('ultra');
  });

  it('accepts unknown memory and texture limits', () => {
    expect(classifyGpu(hints({ vendor: 'nvidia', deviceMemoryGB: null, maxTextureSize: 0 }))).toBe('high');
  });
});

describe('gpuProfile', () => {
  it('grows every budget with the tier', () => {
    for (let i = 1; i < GPU_TIERS.length; i++) {
      const a = gpuProfile(GPU_TIERS[i - 1]);
      const b = gpuProfile(GPU_TIERS[i]);
      expect(b.maxPixelRatio).toBeGreaterThanOrEqual(a.maxPixelRatio);
      expect(b.globe.maxCachedTiles).toBeGreaterThan(a.globe.maxCachedTiles);
      expect(b.globe.maxAnisotropy).toBeGreaterThanOrEqual(a.globe.maxAnisotropy);
      expect(b.globe.hiddenReleaseSeconds).toBeGreaterThan(a.globe.hiddenReleaseSeconds);
      expect(b.tiles.cacheMaxBytes).toBeGreaterThan(a.tiles.cacheMaxBytes);
      expect(b.tiles.gpuBytesTarget).toBeGreaterThan(a.tiles.gpuBytesTarget);
      expect(b.indoor.modelBytesTarget).toBeGreaterThan(a.indoor.modelBytesTarget);
      expect(b.indoor.unloadDelayMs).toBeGreaterThanOrEqual(a.indoor.unloadDelayMs);
      // More detail (a lower error target) on the better tier.
      expect(b.tiles.errorTargetScale).toBeLessThanOrEqual(a.tiles.errorTargetScale);
      expect(b.tiles.errorFalloffScale).toBeLessThanOrEqual(a.tiles.errorFalloffScale);
    }
  });

  it('keeps each tier consistent', () => {
    for (const tier of GPU_TIERS) {
      const p = gpuProfile(tier);
      expect(p.tier).toBe(tier);
      // Eviction floor below the load limit, and room for the GPU share inside the cache.
      expect(p.tiles.cacheMinBytes).toBeLessThan(p.tiles.cacheMaxBytes);
      expect(p.tiles.gpuBytesTarget).toBeLessThan(p.tiles.cacheMinBytes);
      expect(p.tiles.adaptiveErrorMaxScale).toBeGreaterThanOrEqual(1);
      expect(p.globe.hiddenKeepTiles).toBeLessThan(p.globe.maxCachedTiles);
      // Anisotropy needs a mip chain.
      if (!p.tiles.mipmaps) expect(p.tiles.anisotropy).toBe(1);
    }
  });

  it('leaves the high tier at the settings the viewer had before tiers existed', () => {
    const p = gpuProfile('high');
    expect(p.maxPixelRatio).toBe(2);
    expect(p.antialias).toBe(true);
    expect(p.globe.maxCachedTiles).toBe(700);
    expect(p.globe.maxAnisotropy).toBe(8);
    expect(p.tiles.errorTargetScale).toBe(1);
  });

  it('returns copies', () => {
    const p = gpuProfile('medium');
    p.tiles.cacheMaxBytes = 1;
    p.globe.maxCachedTiles = 1;
    p.indoor.modelBytesTarget = 1;
    p.shadows.mapSize = 1;
    expect(gpuProfile('medium').tiles.cacheMaxBytes).toBe(448 * MB);
    expect(gpuProfile('medium').globe.maxCachedTiles).toBe(500);
    expect(gpuProfile('medium').indoor.modelBytesTarget).toBe(128 * MB);
    expect(gpuProfile('medium').shadows.mapSize).toBe(2048);
  });

  it('turns sun shadows on above low and order-independent transparency on ultra only (M3.9)', () => {
    expect(gpuProfile('low').shadows.enabled).toBe(false);
    for (const tier of ['medium', 'high', 'ultra'] as const) expect(gpuProfile(tier).shadows.enabled).toBe(true);
    // Power-of-two maps, never shrinking with the tier; 4 bytes per texel stays within 64 MB.
    for (let i = 0; i < GPU_TIERS.length; i++) {
      const size = gpuProfile(GPU_TIERS[i]).shadows.mapSize;
      expect(Math.log2(size) % 1).toBe(0);
      expect(size * size * 4).toBeLessThanOrEqual(64 * MB);
      if (i > 0) expect(size).toBeGreaterThanOrEqual(gpuProfile(GPU_TIERS[i - 1]).shadows.mapSize);
    }
    expect(GPU_TIERS.filter((t) => gpuProfile(t).orderIndependentTransparency)).toEqual(['ultra']);
  });

  it('keeps volumetric cloud weather texels small enough for round cells above low (B12)', () => {
    // The map spans up to twice WEATHER_MAX_REACH; a cloud cell is about CLOUD_SCALES.cells / 4 across.
    const cell = CLOUD_SCALES.cells / 4;
    for (let i = 0; i < GPU_TIERS.length; i++) {
      const { weatherSize } = gpuProfile(GPU_TIERS[i]).clouds;
      expect(Math.log2(weatherSize) % 1).toBe(0);
      const texel = (2 * WEATHER_MAX_REACH) / weatherSize;
      // low keeps 512 (clouds off by default there): a quarter of a cell; the others an eighth.
      expect(texel).toBeLessThanOrEqual(cell / (GPU_TIERS[i] === 'low' ? 4 : 8));
      if (i > 0) expect(weatherSize).toBeGreaterThanOrEqual(gpuProfile(GPU_TIERS[i - 1]).clouds.weatherSize);
    }
  });
});

describe('parseGpuTier', () => {
  it('accepts the four names and nothing else', () => {
    expect(parseGpuTier('low')).toBe('low');
    expect(parseGpuTier(' Ultra ')).toBe('ultra');
    expect(parseGpuTier('HIGH')).toBe('high');
    expect(parseGpuTier('max')).toBeUndefined();
    expect(parseGpuTier('')).toBeUndefined();
    expect(parseGpuTier(null)).toBeUndefined();
    expect(parseGpuTier(undefined)).toBeUndefined();
  });
});

describe('frame buffer estimate', () => {
  it('caps the pixel ratio and survives odd values', () => {
    expect(effectivePixelRatio(3, 2)).toBe(2);
    expect(effectivePixelRatio(1.25, 2)).toBe(1.25);
    expect(effectivePixelRatio(0, 2)).toBe(1);
    expect(effectivePixelRatio(NaN, 1.5)).toBe(1);
  });

  it('counts color, MSAA and depth', () => {
    const px = 1920 * 1080;
    // No MSAA: swap chain color + depth.
    expect(estimateFramebufferBytes({ width: 1920, height: 1080, samples: 1 })).toBe(px * 8);
    // 4x: resolve target + 4 color samples + 4 depth samples.
    expect(estimateFramebufferBytes({ width: 1920, height: 1080, samples: 4 })).toBe(px * (4 + 16 + 16));
    // Half-resolution pick buffer: a quarter of the pixels at 20 bytes.
    expect(estimateFramebufferBytes({ width: 1920, height: 1080, samples: 1, pickScale: 0.5 })).toBe(px * 8 + (px / 4) * 20);
    expect(estimateFramebufferBytes({ width: 0, height: 0, samples: 4 })).toBe(0);
  });

  it('shows what a 4K canvas at full resolution costs', () => {
    const uhd = estimateFramebufferBytes({ width: 3840, height: 2160, samples: 4, pickScale: 0.5 });
    const hd = estimateFramebufferBytes({ width: 1920, height: 1080, samples: 4, pickScale: 0.5 });
    expect(uhd).toBe(hd * 4);
    expect(uhd / MB).toBeGreaterThan(300);
  });
});

describe('tilesFalloffDensity', () => {
  it('is off looking straight down and strongest towards the horizon', () => {
    expect(tilesFalloffDensity(500, -1)).toBe(0);
    expect(tilesFalloffDensity(500, 1)).toBe(0);
    expect(tilesFalloffDensity(500, 0)).toBeCloseTo(FALLOFF_DENSITY, 12);
    const p30 = tilesFalloffDensity(500, -0.5);
    const p60 = tilesFalloffDensity(500, -Math.sqrt(3) / 2);
    expect(p30).toBeCloseTo(FALLOFF_DENSITY * 0.75, 12);
    expect(p60).toBeLessThan(p30);
    expect(p60).toBeGreaterThan(0);
  });

  it('fades out with height so the view from orbit is not relaxed', () => {
    const low = tilesFalloffDensity(1_000, -0.3);
    const mid = tilesFalloffDensity(7_000, -0.3);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(low);
    expect(tilesFalloffDensity(FALLOFF_FADE_END, -0.3)).toBe(0);
    expect(tilesFalloffDensity(2e7, -0.3)).toBe(0);
  });

  it('never returns a negative or non-finite density', () => {
    for (const altitude of [-100, 0, 1, 1e3, 1e5, NaN, Infinity]) {
      for (const dot of [-2, -1, -0.5, 0, 0.5, 1, 2, NaN]) {
        const d = tilesFalloffDensity(altitude, dot);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(FALLOFF_DENSITY);
      }
    }
  });
});

describe('stepAdaptiveError', () => {
  const base = { cacheMinBytes: 300 * MB, maxScale: 2, dt: 1 / 60 };

  function run(state: ReturnType<typeof createAdaptiveErrorState>, seconds: number, input: { refused: number; usedBytes: number }, over = {}): number {
    let scale = state.scale;
    for (let i = 0; i < Math.round(seconds * 60); i++) scale = stepAdaptiveError(state, { ...base, ...input, ...over });
    return scale;
  }

  it('stays at 1 while nothing is refused', () => {
    const s = createAdaptiveErrorState();
    expect(run(s, 10, { refused: 0, usedBytes: 100 * MB })).toBe(1);
    expect(run(s, 10, { refused: 0, usedBytes: 400 * MB })).toBe(1);
  });

  it('ignores a short burst of refusals', () => {
    const s = createAdaptiveErrorState();
    expect(run(s, 0.3, { refused: 40, usedBytes: 400 * MB })).toBe(1);
    expect(run(s, 0.3, { refused: 0, usedBytes: 400 * MB })).toBe(1);
    // The burst does not add up across the break.
    expect(run(s, 0.3, { refused: 40, usedBytes: 400 * MB })).toBe(1);
  });

  it('raises the error target while tiles keep being refused, up to the limit', () => {
    const s = createAdaptiveErrorState();
    const after2 = run(s, 2, { refused: 40, usedBytes: 400 * MB });
    expect(after2).toBeGreaterThan(1.3);
    expect(after2).toBeLessThan(2);
    expect(run(s, 20, { refused: 40, usedBytes: 400 * MB })).toBe(2);
  });

  it('holds the raised target while the used tiles still fill the cache', () => {
    const s = createAdaptiveErrorState();
    const raised = run(s, 2, { refused: 40, usedBytes: 400 * MB });
    // No refusals any more, but the tiles in use take about what the cache keeps: no room to refine.
    expect(run(s, 30, { refused: 0, usedBytes: 280 * MB })).toBe(raised);
  });

  it('returns to full detail slowly once there is room', () => {
    const s = createAdaptiveErrorState();
    const raised = run(s, 2, { refused: 40, usedBytes: 400 * MB });
    // Room has to last a while first.
    expect(run(s, 2, { refused: 0, usedBytes: 100 * MB })).toBe(raised);
    const later = run(s, 4, { refused: 0, usedBytes: 100 * MB });
    expect(later).toBeLessThan(raised);
    expect(later).toBeGreaterThan(1);
    expect(run(s, 120, { refused: 0, usedBytes: 100 * MB })).toBe(1);
  });

  it('rises faster than it falls', () => {
    const up = createAdaptiveErrorState();
    const raised = run(up, 1.4, { refused: 1, usedBytes: 400 * MB });
    const down = { ...up };
    run(down, 3, { refused: 0, usedBytes: 0 });
    const lowered = run(down, 1, { refused: 0, usedBytes: 0 });
    expect(raised - 1).toBeGreaterThan(raised - lowered);
  });

  it('can be disabled and clamps long frames', () => {
    const off = createAdaptiveErrorState();
    expect(run(off, 5, { refused: 40, usedBytes: 400 * MB }, { maxScale: 1 })).toBe(1);
    const s = createAdaptiveErrorState();
    // A 10 s frame (tab in the background) counts as a quarter second.
    stepAdaptiveError(s, { ...base, refused: 5, usedBytes: 400 * MB, dt: 10 });
    expect(s.refusedFor).toBe(0.25);
    expect(s.scale).toBe(1);
  });
});

describe('applyTexturePolicy', () => {
  function texture(over: Partial<PolicyTexture> = {}): PolicyTexture {
    return { isTexture: true, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, anisotropy: 1, ...over };
  }

  it('sets anisotropy and keeps mipmaps', () => {
    const map = texture();
    applyTexturePolicy({ map, color: { isColor: true }, name: 'tile', nothing: null }, { mipmaps: true, anisotropy: 4 });
    expect(map.anisotropy).toBe(4);
    expect(map.generateMipmaps).toBe(true);
    expect(map.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('drops mipmaps and switches to a filter that needs none', () => {
    const map = texture();
    const emissiveMap = texture({ minFilter: NearestMipmapNearestFilter });
    const plain = texture({ minFilter: LinearFilter, generateMipmaps: false });
    applyTexturePolicy({ map, emissiveMap, plain }, { mipmaps: false, anisotropy: 8 });
    expect(map.generateMipmaps).toBe(false);
    expect(map.minFilter).toBe(LinearFilter);
    expect(map.anisotropy).toBe(1);
    expect(emissiveMap.minFilter).toBe(NearestFilter);
    expect(plain.minFilter).toBe(LinearFilter);
  });

  it('leaves the mip chain of compressed textures alone', () => {
    const map = texture({ isCompressedTexture: true, generateMipmaps: false });
    applyTexturePolicy({ map }, { mipmaps: false, anisotropy: 1 });
    expect(map.minFilter).toBe(LinearMipmapLinearFilter);
    applyTexturePolicy({ map }, { mipmaps: true, anisotropy: 8 });
    expect(map.anisotropy).toBe(8);
  });
});
