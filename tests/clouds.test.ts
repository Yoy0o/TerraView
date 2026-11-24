import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CLOUD_DEFAULTS, CloudLayer, cloudFade, createShellGeometry, normalizeCloudOptions, octaveWeight } from '../src/clouds/CloudLayer';
import { Ellipsoid } from '../src/core/Ellipsoid';

const E = Ellipsoid.WGS84;

describe('cloud options', () => {
  it('clamps values and drops invalid ones', () => {
    expect(normalizeCloudOptions({ coverage: 2, opacity: -1, speed: 500, height: -5 })).toEqual({ coverage: 1, opacity: 0, speed: 90, height: 0 });
    expect(normalizeCloudOptions({ coverage: NaN, fadeHeights: [5, 1], textureUrl: '  ' })).toEqual({});
    expect(normalizeCloudOptions({ fadeHeights: [1000, 2000], textureUrl: null, visible: true })).toEqual({
      fadeHeights: [1000, 2000],
      textureUrl: null,
      visible: true,
    });
  });

  it('fades out on the way down', () => {
    const f = CLOUD_DEFAULTS.fadeHeights;
    expect(cloudFade(0, f)).toBe(0);
    expect(cloudFade(f[0], f)).toBe(0);
    expect(cloudFade(f[1], f)).toBe(1);
    expect(cloudFade(2e7, f)).toBe(1);
    const mid = cloudFade((f[0] + f[1]) / 2, f);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('cloud shell geometry', () => {
  it('is a unit sphere with outward faces and an equirectangular uv', () => {
    const g = createShellGeometry(16, 8);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const index = g.getIndex()!;
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    let checked = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i));
      b.fromBufferAttribute(pos, index.getX(i + 1));
      c.fromBufferAttribute(pos, index.getX(i + 2));
      const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
      if (n.lengthSq() < 1e-12) continue; // collapsed triangles at the poles
      const centroid = a.clone().add(b).add(c).divideScalar(3);
      expect(n.dot(centroid)).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(16 * 8);
    for (let i = 0; i < pos.count; i++) expect(a.fromBufferAttribute(pos, i).length()).toBeCloseTo(1, 6);
    // u = 0 at longitude -180°, v = 1 at the north pole.
    expect(uv.getX(0)).toBe(0);
    expect(a.fromBufferAttribute(pos, 0).x).toBeCloseTo(0, 6); // south pole
    const mid = 4 * 17 + 8; // equator, middle column = longitude 0
    expect(a.fromBufferAttribute(pos, mid).x).toBeCloseTo(1, 6);
    expect(uv.getX(mid)).toBeCloseTo(0.5, 6);
    expect(uv.getY(pos.count - 1)).toBe(1);
  });
});

describe('CloudLayer', () => {
  it('sits at its height above the ellipsoid and hides when invisible or faded out', () => {
    const clouds = new CloudLayer(E);
    expect(clouds.visible).toBe(false);
    clouds.update(1 / 60, 2e7);
    expect(clouds.mesh.visible).toBe(false);

    clouds.set({ visible: true, height: 12_000 });
    expect(clouds.mesh.scale.x).toBeCloseTo(E.radii.x + 12_000);
    expect(clouds.mesh.scale.z).toBeCloseTo(E.radii.z + 12_000);
    clouds.update(1 / 60, 2e7);
    expect(clouds.mesh.visible).toBe(true);
    clouds.update(1 / 60, 10_000);
    expect(clouds.mesh.visible).toBe(false);
    clouds.set({ opacity: 0 });
    clouds.update(1 / 60, 2e7);
    expect(clouds.mesh.visible).toBe(false);
    clouds.dispose();
  });

  it('keeps settings across updates and ignores invalid ones', () => {
    const clouds = new CloudLayer(E);
    clouds.set({ coverage: 0.8, speed: -2, fadeHeights: [1, 2] });
    clouds.set({ coverage: NaN, speed: Infinity });
    const o = clouds.getOptions();
    expect(o.coverage).toBe(0.8);
    expect(o.speed).toBe(-2);
    expect(o.fadeHeights).toEqual([1, 2]);
    // Many frames of drift stay finite (the angle wraps on the CPU).
    clouds.visible = true;
    for (let i = 0; i < 10_000; i++) clouds.update(0.1, 2e7);
    expect(clouds.mesh.visible).toBe(true);
    clouds.dispose();
  });

  it('tells its owner when the options change (the viewer leaves the idle frame rate)', () => {
    const clouds = new CloudLayer(E);
    let changes = 0;
    clouds.onChange = () => changes++;
    clouds.visible = true;
    clouds.set({ coverage: 0.7 });
    expect(changes).toBe(2);
    // Drift is the viewer's own business (it asks for a frame rate from the speed).
    clouds.update(0.1, 2e7);
    expect(changes).toBe(2);
    clouds.dispose();
  });
});

describe('cloud noise band limit', () => {
  it('keeps octaves of 4+ px per cycle, drops those at the Nyquist limit, fades in between', () => {
    expect(octaveWeight(0.1)).toBe(1);
    expect(octaveWeight(0.25)).toBe(1);
    expect(octaveWeight(0.5)).toBe(0);
    expect(octaveWeight(2)).toBe(0);
    let prev = 1;
    for (let c = 0.25; c <= 0.5; c += 0.01) {
      const w = octaveWeight(c);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
  });
});
