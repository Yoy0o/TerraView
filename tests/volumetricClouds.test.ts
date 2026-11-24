// Volumetric clouds: options, the layer geometry the shaders share with the CPU, march and history
// sizing, the tileable noise, the cloud layer's volumetric settings and drift, frame pacing.
import { describe, expect, it } from 'vitest';
import { CLOUD_DEFAULTS, CloudLayer, normalizeCloudOptions } from '../src/clouds/CloudLayer';
import { CLOUD_NOISE_SIZE, generateCloudNoise, periodicPerlin, sampleCloudNoise } from '../src/clouds/cloudNoise';
import {
  CLOUD_SCALES,
  cloudInterval,
  historySize,
  INTERLEAVE_SLOTS,
  localEarthRadius,
  normalizeVolumetricOptions,
  periodicFraction,
  shellRoots,
  stepGrowth,
  VOLUMETRIC_CLOUD_DEFAULTS,
  volumetricFade,
  weatherExtent,
  WEATHER_MAX_REACH,
  WEATHER_SLACK,
} from '../src/clouds/volumetricCloudMath';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { GPU_TIERS, gpuProfile } from '../src/core/gpuProfile';
import { CLOUD_MAX_STEP_PX, volumetricCloudFrameRate, VOLUMETRIC_NEAREST_M } from '../src/viewer/framePacing';

const E = Ellipsoid.WGS84;
const R = 6_371_000;

describe('volumetric cloud options', () => {
  it('clamps values and drops invalid ones', () => {
    expect(normalizeVolumetricOptions({ bottom: -5, thickness: 50, windSpeed: 100, density: 9, maxDistance: 1 })).toEqual({
      bottom: 0,
      thickness: 200,
      windSpeed: 60,
      density: 4,
      maxDistance: 10_000,
    });
    expect(normalizeVolumetricOptions({ bottom: NaN, windHeading: Infinity, fadeHeights: [5, 1], enabled: 1 as unknown as boolean })).toEqual({});
    expect(normalizeVolumetricOptions({ windHeading: -90, fadeHeights: [10, 20], shadows: false })).toEqual({ windHeading: 270, fadeHeights: [10, 20], shadows: false });
  });

  it('come with the cloud options, as an object or a switch', () => {
    expect(normalizeCloudOptions({ volumetric: false })).toEqual({ volumetric: { enabled: false } });
    expect(normalizeCloudOptions({ volumetric: { bottom: 2000, density: -1 } })).toEqual({ volumetric: { bottom: 2000, density: 0.1 } });
    expect(CLOUD_DEFAULTS.volumetric).toEqual(VOLUMETRIC_CLOUD_DEFAULTS);
  });

  it('fade out on the way up, where the shell takes over', () => {
    const f = VOLUMETRIC_CLOUD_DEFAULTS.fadeHeights;
    expect(volumetricFade(0, f)).toBe(1);
    expect(volumetricFade(f[0], f)).toBe(1);
    expect(volumetricFade(f[1], f)).toBe(0);
    expect(volumetricFade((f[0] + f[1]) / 2, f)).toBeCloseTo(0.5);
    // The shell is still faint where the volumetric clouds start to fade.
    expect(f[0]).toBeGreaterThanOrEqual(CLOUD_DEFAULTS.fadeHeights[0]);
  });
});

describe('cloud layer geometry', () => {
  it('uses the Gaussian radius of curvature (between the polar and equatorial extremes)', () => {
    const a = E.radii.x;
    const b = E.radii.z;
    expect(localEarthRadius(0, a, b)).toBeCloseTo(Math.sqrt(a * ((b * b) / a)), 3);
    expect(localEarthRadius(Math.PI / 2, a, b)).toBeCloseTo((a * a) / b, 3);
    const mid = localEarthRadius(0.7, a, b);
    expect(mid).toBeGreaterThan(localEarthRadius(0, a, b));
    expect(mid).toBeLessThan((a * a) / b);
  });

  it('finds where a ray crosses a shell (as a brute-force sphere intersection does)', () => {
    for (const [h0, mu, hs] of [
      [600, 0.3, 1500],
      [600, -0.2, 1500],
      [9000, -0.9, 4000],
      [2000, 0.01, 4000],
      [120_000, -0.6, 1500],
    ]) {
      const roots = shellRoots(h0, mu, hs, R);
      // The ray in a 2D plane: origin (0, R + h0), direction (sin, mu).
      const r0 = R + h0;
      const s = Math.sqrt(1 - mu * mu);
      const b = r0 * mu;
      const c = r0 * r0 - (R + hs) ** 2;
      const d = b * b - c;
      if (d < 0) {
        expect(roots).toBeNull();
        continue;
      }
      expect(roots).not.toBeNull();
      for (const t of roots!) {
        const x = s * t;
        const y = r0 + mu * t;
        expect(Math.hypot(x, y) - R).toBeCloseTo(hs, 3);
      }
    }
  });

  it('marches the nearest stretch of the layer, stopping at the ground', () => {
    // Below the base looking up: from the base to the top.
    const up = cloudInterval(600, 1, 1500, 4000, R)!;
    expect(up[0]).toBeCloseTo(900, 3);
    expect(up[1]).toBeCloseTo(3400, 3);
    // Below the base looking down: the ground comes first.
    expect(cloudInterval(600, -0.5, 1500, 4000, R)).toBeNull();
    // Above looking down: from the top to the base.
    const down = cloudInterval(9000, -1, 1500, 4000, R)!;
    expect(down[0]).toBeCloseTo(5000, 3);
    expect(down[1]).toBeCloseTo(7500, 3);
    // Inside, level: from here until the ray leaves the top (curving away from the ground).
    const level = cloudInterval(2000, 0, 1500, 4000, R)!;
    expect(level[0]).toBe(0);
    expect(level[1]).toBeCloseTo(Math.sqrt((R + 4000) ** 2 - (R + 2000) ** 2), 0);
    // Above the layer, looking at the sky: nothing.
    expect(cloudInterval(9000, 0.2, 1500, 4000, R)).toBeNull();
  });
});

describe('march and history sizing', () => {
  it('grows the step so the budget reaches the distance', () => {
    const g = stepGrowth(80, 30, 80_000);
    expect(g).toBeGreaterThan(0);
    const n = Math.log1p((g * 80_000) / 30) / Math.log1p(g);
    expect(n).toBeCloseTo(80, 3);
    // Enough steps at the minimum size: no growth.
    expect(stepGrowth(100, 1000, 50_000)).toBe(0);
  });

  it('keeps the history at most half the resolution, within the pixel budget, with even sizes', () => {
    const s = historySize(1920, 1080, 520_000);
    expect(s).toEqual({ width: 960, height: 540 });
    const small = historySize(1920, 1080, 160_000);
    expect(small.width % 2).toBe(0);
    expect(small.height % 2).toBe(0);
    expect(small.width * small.height).toBeLessThan(170_000);
    expect(small.width / small.height).toBeCloseTo(1920 / 1080, 1);
    expect(historySize(0, 0, 100)).toEqual({ width: 2, height: 2 });
  });

  it('refreshes each pixel of a 2 × 2 block once per cycle, starting on the diagonal', () => {
    const keys = INTERLEAVE_SLOTS.map(([x, y]) => `${x},${y}`);
    expect(new Set(keys).size).toBe(4);
    expect(keys.slice(0, 2)).toEqual(['0,0', '1,1']);
  });

  it('sizes the weather map for the clouds reach, larger from high up', () => {
    expect(weatherExtent(80_000, 500)).toBe(2 * (80_000 + 2 * WEATHER_SLACK));
    expect(weatherExtent(80_000, 100_000)).toBeGreaterThan(weatherExtent(80_000, 1000));
    expect(weatherExtent(80_000, 10_000_000)).toBe(2 * WEATHER_MAX_REACH);
    // Texels stay under a quarter of a weather cell.
    expect((2 * WEATHER_MAX_REACH) / 512).toBeLessThan(CLOUD_SCALES.cells / 4 / 0.9);
  });

  it('takes noise coordinates modulo the period in float64', () => {
    expect(periodicFraction(6_378_137, 4500)).toBeCloseTo(6_378_137 / 4500 - Math.floor(6_378_137 / 4500), 12);
    expect(periodicFraction(-1, 4)).toBeCloseTo(0.75, 12);
    for (const x of [-6.4e6, 0, 123.4, 6.4e6]) {
      const f = periodicFraction(x, 600);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});

describe('cloud noise', () => {
  it('repeats with period 1 on every axis', () => {
    const a = sampleCloudNoise(0.3, 0.7, 0.1);
    const b = sampleCloudNoise(1.3, -0.3, 2.1);
    for (let c = 0; c < 4; c++) expect(b[c]).toBeCloseTo(a[c], 9);
    expect(periodicPerlin(2.5, 7.25, 1.5, 8)).toBeCloseTo(periodicPerlin(10.5, -0.75, 9.5, 8), 9);
  });

  it('is continuous across the wrap (the texture tiles without a seam)', () => {
    const e = 1e-4;
    const a = sampleCloudNoise(1 - e, 0.4, 0.6);
    const b = sampleCloudNoise(e, 0.4, 0.6);
    for (let c = 0; c < 4; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(0.02);
  });

  it('fills an RGBA8 volume using the full range of each channel', () => {
    const size = 8;
    const data = generateCloudNoise(size);
    expect(data.length).toBe(size ** 3 * 4);
    for (let c = 0; c < 4; c++) {
      let lo = 255;
      let hi = 0;
      for (let i = c; i < data.length; i += 4) {
        lo = Math.min(lo, data[i]);
        hi = Math.max(hi, data[i]);
      }
      expect(lo).toBe(0);
      expect(hi).toBe(255);
    }
    expect(CLOUD_NOISE_SIZE).toBe(64);
  });
});

describe('CloudLayer volumetric settings', () => {
  it('merges volumetric options and returns copies', () => {
    const clouds = new CloudLayer(E, { volumetric: false });
    expect(clouds.getOptions().volumetric.enabled).toBe(false);
    clouds.set({ volumetric: true });
    clouds.set({ volumetric: { bottom: 2000, fadeHeights: [1000, 2000] } });
    clouds.set({ volumetric: { thickness: NaN } });
    const o = clouds.getOptions();
    expect(o.volumetric).toMatchObject({ enabled: true, bottom: 2000, thickness: VOLUMETRIC_CLOUD_DEFAULTS.thickness, fadeHeights: [1000, 2000] });
    o.volumetric.fadeHeights[0] = 5;
    o.volumetric.bottom = 1;
    expect(clouds.volumetricOptions.fadeHeights[0]).toBe(1000);
    expect(clouds.volumetricOptions.bottom).toBe(2000);
    // The defaults stay untouched.
    expect(CLOUD_DEFAULTS.volumetric.bottom).toBe(VOLUMETRIC_CLOUD_DEFAULTS.bottom);
    clouds.dispose();
  });

  it('holds the weather still under a camera near the ground (the drift only advances while the shell shows)', () => {
    const clouds = new CloudLayer(E);
    clouds.set({ visible: true, speed: 1 });
    clouds.update(1, 2e7);
    const high = clouds.weatherState.drift;
    expect(high).toBeGreaterThan(0);
    clouds.update(1, 5_000);
    expect(clouds.weatherState.drift).toBe(high);
    clouds.update(1, 2e7);
    expect(clouds.weatherState.drift).toBeGreaterThan(high);
    clouds.dispose();
  });

  it('follows the GPU tier: off on low, more pixels and steps higher up', () => {
    expect(gpuProfile('low').clouds.volumetric).toBe(false);
    for (const tier of ['medium', 'high', 'ultra'] as const) expect(gpuProfile(tier).clouds.volumetric).toBe(true);
    for (let i = 1; i < GPU_TIERS.length; i++) {
      const a = gpuProfile(GPU_TIERS[i - 1]).clouds;
      const b = gpuProfile(GPU_TIERS[i]).clouds;
      expect(b.historyPixels).toBeGreaterThanOrEqual(a.historyPixels);
      expect(b.steps).toBeGreaterThanOrEqual(a.steps);
    }
    const p = gpuProfile('medium');
    p.clouds.steps = 1;
    expect(gpuProfile('medium').clouds.steps).toBe(64);
  });
});

describe('volumetricCloudFrameRate', () => {
  const base = { windSpeed: 6, cameraHeight: 500, bottom: 1500, top: 4000, fovDeg: 50, viewportHeight: 1000 };

  it('moves the nearest clouds at most CLOUD_MAX_STEP_PX per frame', () => {
    const rate = volumetricCloudFrameRate(base);
    const metersPerPixel = (1000 * 2 * Math.tan((25 * Math.PI) / 180)) / 1000;
    expect(rate).toBeCloseTo(6 / metersPerPixel / CLOUD_MAX_STEP_PX, 6);
    expect(rate).toBeCloseTo(4.3, 1);
  });

  it('needs more frames inside the layer and fewer from far above', () => {
    const inside = volumetricCloudFrameRate({ ...base, cameraHeight: 2500 });
    expect(inside).toBeCloseTo(volumetricCloudFrameRate({ ...base, cameraHeight: 1500 - VOLUMETRIC_NEAREST_M }), 6);
    expect(inside).toBeGreaterThan(volumetricCloudFrameRate(base));
    expect(volumetricCloudFrameRate({ ...base, cameraHeight: 50_000 })).toBeLessThan(1);
  });

  it('asks for nothing without wind', () => {
    expect(volumetricCloudFrameRate({ ...base, windSpeed: 0 })).toBe(0);
    expect(volumetricCloudFrameRate({ ...base, viewportHeight: 0 })).toBe(0);
  });
});
