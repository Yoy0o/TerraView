/**
 * Sun shadows (M3.9): fitting the shadow map to buildings ∩ view, its stability, and the
 * matrix that takes world points into the map (the GPU side was checked in the browser).
 */
import { Matrix4, Vector3, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import {
  fitSunShadow,
  frustumCorners,
  lightFrame,
  quantizeHalfSize,
  sameFit,
  shadowCameraMatrix,
  sunShadowStrength,
  type ShadowCaster,
  type ShadowFit,
  type ShadowView,
} from '../src/lighting/shadowFit';
import { SunShadows } from '../src/lighting/SunShadows';

const DEG = Math.PI / 180;
const E = Ellipsoid.WGS84;
const LON = 116.39 * DEG;
const LAT = 39.9 * DEG;
const anchor = E.cartographicToCartesian(LON, LAT, 50);
const enu = E.eastNorthUpToFixedFrame(anchor);
const up = E.geodeticNormal(anchor, new Vector3());

/** A local (east, north, up) offset from the anchor in world coordinates. */
function local(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z).applyMatrix4(enu);
}

/** Unit vector toward a sun at an azimuth (clockwise from north) and altitude, degrees. */
function sunAt(azimuth: number, altitude: number): Vector3 {
  const a = azimuth * DEG;
  const h = altitude * DEG;
  const east = new Vector3().setFromMatrixColumn(enu, 0);
  const north = new Vector3().setFromMatrixColumn(enu, 1);
  return new Vector3()
    .addScaledVector(east, Math.sin(a) * Math.cos(h))
    .addScaledVector(north, Math.cos(a) * Math.cos(h))
    .addScaledVector(up, Math.sin(h))
    .normalize();
}

/** A camera at a local position looking at a local target (zero roll). */
function viewFrom(eye: Vector3, target: Vector3, fovDeg = 50, aspect = 16 / 9, near = 1): ShadowView {
  const m = new Matrix4().lookAt(eye, target, up).setPosition(eye);
  const tanY = Math.tan((fovDeg * DEG) / 2);
  return { matrixWorld: m, tanX: tanY * aspect, tanY, near };
}

const building: ShadowCaster = { matrix: enu, min: new Vector3(-20, -15, -0.3), max: new Vector3(20, 15, 21) };
const OPTIONS = { mapSize: 2048, maxDistance: 2000 };

function lightCoords(fit: ShadowFit, p: Vector3): [number, number, number] {
  const d = p.clone().sub(fit.origin);
  return [d.dot(fit.x), d.dot(fit.y), d.dot(fit.z)];
}

function boxCorners(c: ShadowCaster): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(new Vector3(i & 1 ? c.max.x : c.min.x, i & 2 ? c.max.y : c.min.y, i & 4 ? c.max.z : c.min.z).applyMatrix4(c.matrix));
  }
  return out;
}

describe('light frame', () => {
  it('is orthonormal, with x horizontal and z toward the sun', () => {
    const sun = sunAt(135, 35);
    const x = new Vector3();
    const y = new Vector3();
    const z = new Vector3();
    lightFrame(sun, up, x, y, z);
    expect(z.distanceTo(sun)).toBeLessThan(1e-12);
    expect(Math.abs(x.dot(y))).toBeLessThan(1e-12);
    expect(Math.abs(x.dot(z))).toBeLessThan(1e-12);
    expect(Math.abs(x.dot(up))).toBeLessThan(1e-12);
    expect(x.length()).toBeCloseTo(1, 12);
    // Right-handed: x × y = z.
    expect(new Vector3().crossVectors(x, y).distanceTo(z)).toBeLessThan(1e-12);
  });

  it('falls back to a fixed axis with the sun at the zenith', () => {
    const x = new Vector3();
    const y = new Vector3();
    const z = new Vector3();
    lightFrame(up, up, x, y, z);
    expect(x.length()).toBeCloseTo(1, 12);
    expect(Math.abs(x.dot(z))).toBeLessThan(1e-9);
    expect(Number.isFinite(y.x)).toBe(true);
  });
});

describe('shadow map size and strength', () => {
  it('quantizes the half size in steps of 2^(1/4) with a texel of slack', () => {
    for (const h of [3, 10, 37.5, 120, 999]) {
      const q = quantizeHalfSize(h, 2048);
      expect(q).toBeGreaterThanOrEqual(h + q / 2048);
      const steps = Math.log2(q) * 4;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      // Never more than one step (plus the slack step) above.
      expect(q / h).toBeLessThan(2 ** 0.5 + 1e-9);
    }
    expect(quantizeHalfSize(0.5, 2048)).toBeGreaterThanOrEqual(4);
    // Nearby sizes share a step: small changes of the view do not resize the map.
    expect(quantizeHalfSize(30.1, 2048)).toBe(quantizeHalfSize(31.9, 2048));
  });

  it('fades shadows out as the sun sets', () => {
    expect(sunShadowStrength(Math.sin(1 * DEG))).toBe(0);
    expect(sunShadowStrength(Math.sin(-10 * DEG))).toBe(0);
    expect(sunShadowStrength(Math.sin(15 * DEG))).toBe(1);
    const mid = sunShadowStrength(Math.sin(6 * DEG));
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    let prev = 0;
    for (let a = 0; a <= 12; a += 0.5) {
      const s = sunShadowStrength(Math.sin(a * DEG));
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('gives the corners of the cut frustum', () => {
    const view = viewFrom(local(0, -200, 50), local(0, 0, 10));
    const corners = frustumCorners(view, 500);
    expect(corners).toHaveLength(8);
    const eye = new Vector3().setFromMatrixPosition(view.matrixWorld);
    const dir = new Vector3(0, 0, -1).transformDirection(view.matrixWorld);
    for (let i = 0; i < 4; i++) expect(corners[i].clone().sub(eye).dot(dir)).toBeCloseTo(1, 6);
    for (let i = 4; i < 8; i++) expect(corners[i].clone().sub(eye).dot(dir)).toBeCloseTo(500, 6);
  });
});

describe('fitting the shadow map', () => {
  const sun = sunAt(150, 40);
  const outside = viewFrom(local(-120, -250, 80), local(0, 0, 10));

  it('covers the whole building and its shadow seen from outside', () => {
    const fit = fitSunShadow(sun, anchor, up, [building], outside, OPTIONS)!;
    expect(fit).not.toBeNull();
    const sine = sun.dot(up);
    for (const c of boxCorners(building)) {
      const [x, y, z] = lightCoords(fit, c);
      expect(Math.abs(x - fit.centerX)).toBeLessThanOrEqual(fit.halfSize);
      expect(Math.abs(y - fit.centerY)).toBeLessThanOrEqual(fit.halfSize);
      expect(z).toBeLessThanOrEqual(fit.top);
      // Where the corner's shadow meets the ground (the base plane) is inside the depth range.
      const height = c.clone().sub(anchor).dot(up) - building.min.z;
      const ground = c.clone().addScaledVector(sun, -height / sine);
      const [gx, gy, gz] = lightCoords(fit, ground);
      expect(gx).toBeCloseTo(x, 6);
      expect(gy).toBeCloseTo(y, 6);
      expect(gz).toBeGreaterThanOrEqual(fit.bottom);
    }
    // Tight: the map is not much larger than the building's footprint across the rays.
    expect(fit.halfSize).toBeLessThan(60);
    expect(fit.texel).toBeCloseTo((2 * fit.halfSize) / 2048, 12);
  });

  it('snaps the center to whole texels and stays put for small camera moves', () => {
    const a = fitSunShadow(sun, anchor, up, [building], outside, OPTIONS)!;
    expect(Math.abs(a.centerX / a.texel - Math.round(a.centerX / a.texel))).toBeLessThan(1e-6);
    expect(Math.abs(a.centerY / a.texel - Math.round(a.centerY / a.texel))).toBeLessThan(1e-6);
    const b = fitSunShadow(sun, anchor, up, [building], viewFrom(local(-119, -251, 80.5), local(0.5, 0, 10)), OPTIONS)!;
    expect(sameFit(a, b)).toBe(true);
    expect(sameFit(a, null)).toBe(false);
    expect(sameFit(null, null)).toBe(true);
  });

  it('shrinks to the part around the camera from inside', () => {
    const whole = fitSunShadow(sun, anchor, up, [building], outside, OPTIONS)!;
    // Inside on the third floor, looking along a corridor toward the east wall at 6 m.
    const inside = viewFrom(local(8, 0, 9), local(20, 0, 9), 50, 16 / 9, 0.05);
    const fit = fitSunShadow(sun, anchor, up, [building], inside, { ...OPTIONS, maxDistance: 2000 })!;
    expect(fit).not.toBeNull();
    expect(fit.halfSize).toBeLessThanOrEqual(whole.halfSize);
  });

  it('draws nothing for buildings out of range or behind the camera', () => {
    const far = viewFrom(local(0, -5000, 300), local(0, 0, 10));
    expect(fitSunShadow(sun, anchor, up, [building], far, OPTIONS)).toBeNull();
    const away = viewFrom(local(0, -200, 30), local(0, -400, 30));
    expect(fitSunShadow(sun, anchor, up, [building], away, OPTIONS)).toBeNull();
    expect(fitSunShadow(sun, anchor, up, [], outside, OPTIONS)).toBeNull();
  });

  it('lengthens the depth range as the sun gets lower, capped near the horizon', () => {
    const high = fitSunShadow(sunAt(150, 60), anchor, up, [building], outside, OPTIONS)!;
    const low = fitSunShadow(sunAt(150, 15), anchor, up, [building], outside, OPTIONS)!;
    const grazing = fitSunShadow(sunAt(150, 0.5), anchor, up, [building], outside, OPTIONS)!;
    const depth = (f: ShadowFit) => f.top - f.bottom;
    expect(depth(low)).toBeGreaterThan(depth(high));
    // 21 m + 10 m ground margin over sin 4° at most (plus the box's own extent along the rays).
    expect(depth(grazing)).toBeLessThan(31 / Math.sin(4 * DEG) + 60);
  });

  it('places the shadow camera at the map center, looking down the rays', () => {
    const fit = fitSunShadow(sun, anchor, up, [building], outside, OPTIONS)!;
    const m = shadowCameraMatrix(fit);
    const pos = new Vector3().setFromMatrixPosition(m);
    const [x, y, z] = lightCoords(fit, pos);
    expect(x).toBeCloseTo(fit.centerX, 6);
    expect(y).toBeCloseTo(fit.centerY, 6);
    expect(z).toBeCloseTo(fit.top, 6);
    // The camera looks along -z: away from the sun.
    const look = new Vector3(0, 0, -1).transformDirection(m);
    expect(look.dot(sun)).toBeCloseTo(-1, 12);
  });
});

describe('shadow matrix', () => {
  function frameFor(shadows: SunShadows, sunDir: Vector3) {
    shadows.update({ sun: sunDir, lighting: true, casters: [building], origin: anchor, up, view: viewFrom(local(-120, -250, 80), local(0, 0, 10)) });
    return (shadows as unknown as { matrix: Matrix4; fit: ShadowFit }).matrix;
  }

  for (const [name, coordinateSystem, reversed] of [
    ['WebGPU, reversed depth', WebGPUCoordinateSystem, true],
    ['WebGL, reversed depth', WebGLCoordinateSystem, true],
    ['WebGL', WebGLCoordinateSystem, false],
  ] as const) {
    it(`takes world points into the map (${name})`, () => {
      const renderer = { coordinateSystem, reversedDepthBuffer: reversed } as unknown as WebGPURenderer;
      const shadows = new SunShadows(renderer, { enabled: true, mapSize: 2048 });
      const sunDir = sunAt(150, 40);
      const matrix = frameFor(shadows, sunDir);
      expect(shadows.active).toBe(true);
      expect(shadows.texelSize).toBeGreaterThan(0);
      for (const c of boxCorners(building)) {
        const p = c.clone().applyMatrix4(matrix);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(1);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(1);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThanOrEqual(1);
      }
      // A point nearer the sun is nearer the shadow camera: larger depth with reversed depth.
      const roof = local(0, 0, 21).applyMatrix4(matrix).z;
      const base = local(0, 0, 0).applyMatrix4(matrix).z;
      if (reversed) expect(roof).toBeGreaterThan(base);
      else expect(roof).toBeLessThan(base);
    });
  }

  it('turns off without lighting, with the sun down, or when disabled', () => {
    const renderer = { coordinateSystem: WebGPUCoordinateSystem, reversedDepthBuffer: true } as unknown as WebGPURenderer;
    const shadows = new SunShadows(renderer, { enabled: true, mapSize: 2048 });
    const view = viewFrom(local(-120, -250, 80), local(0, 0, 10));
    shadows.update({ sun: sunAt(150, 40), lighting: false, casters: [building], origin: anchor, up, view });
    expect(shadows.active).toBe(false);
    shadows.update({ sun: sunAt(150, -5), lighting: true, casters: [building], origin: anchor, up, view });
    expect(shadows.active).toBe(false);
    shadows.enabled = false;
    shadows.update({ sun: sunAt(150, 40), lighting: true, casters: [building], origin: anchor, up, view });
    expect(shadows.active).toBe(false);
  });

  it('keeps settings within their ranges', () => {
    const renderer = { coordinateSystem: WebGPUCoordinateSystem, reversedDepthBuffer: true } as unknown as WebGPURenderer;
    let toggles = 0;
    let changes = 0;
    const shadows = new SunShadows(renderer, { enabled: true, mapSize: 2048 }, { intensity: 2, softness: 0, mapSize: 1500 }, (toggled) => (toggled ? toggles++ : changes++));
    expect(shadows.intensity).toBe(1);
    expect(shadows.softness).toBe(0.5);
    // Powers of two: 1500 rounds to the default 2048 (no change).
    expect(shadows.mapSize).toBe(2048);
    expect(changes).toBe(2);
    shadows.mapSize = 100_000;
    expect(shadows.mapSize).toBe(4096);
    shadows.maxDistance = -5;
    expect(shadows.maxDistance).toBe(10);
    shadows.enabled = false;
    shadows.enabled = false;
    expect(toggles).toBe(1);
    expect(changes).toBe(4);
    expect(shadows.options).toEqual({ enabled: false, intensity: 1, softness: 0.5, maxDistance: 10, mapSize: 4096 });
  });
});
