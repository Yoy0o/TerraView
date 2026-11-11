/**
 * M2.3 contribution culling: exact screen extents of a sphere, hysteresis,
 * and the culler on a building (opt-in, structure never culled, user
 * visibility kept apart, batched and per-mesh devices).
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import type { BimEntity } from '../src/indoor/BimEntity';
import type { Building } from '../src/indoor/Building';
import { isCullable, nextCulled, screenFraction, sphereScreenExtents } from '../src/indoor/ContributionCulling';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { parseCullingParams } from '../demo/ui/urlOptions';

const E = Ellipsoid.WGS84;

describe('sphereScreenExtents', () => {
  const camera = new PerspectiveCamera(50, 1.6, 0.1, 1e4);
  camera.updateProjectionMatrix();
  const p = camera.projectionMatrix.elements;

  /** NDC bounds of points sampled on the sphere surface (brute force). */
  function sampled(c: Vector3, r: number) {
    const out = { left: Infinity, bottom: Infinity, right: -Infinity, top: -Infinity };
    const v = new Vector3();
    const n = 400;
    for (let i = 0; i <= n; i++) {
      const theta = (Math.PI * i) / n;
      for (let j = 0; j < 2 * n; j++) {
        const phi = (Math.PI * j) / n;
        v.set(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)).multiplyScalar(r).add(c);
        v.applyMatrix4(camera.projectionMatrix);
        out.left = Math.min(out.left, v.x);
        out.right = Math.max(out.right, v.x);
        out.bottom = Math.min(out.bottom, v.y);
        out.top = Math.max(out.top, v.y);
      }
    }
    return out;
  }

  it('matches the projected silhouette for off-center spheres', () => {
    for (const [x, y, z, r] of [
      [0, 0, -10, 1],
      [3, -2, -12, 0.8],
      [-6, 4, -9, 2],
      [0.2, 0.1, -500, 0.25],
    ]) {
      const e = sphereScreenExtents(x, y, z, r, p[0], p[5]);
      const s = sampled(new Vector3(x, y, z), r);
      expect(e.left).toBeCloseTo(s.left, 3);
      expect(e.right).toBeCloseTo(s.right, 3);
      expect(e.bottom).toBeCloseTo(s.bottom, 3);
      expect(e.top).toBeCloseTo(s.top, 3);
    }
  });

  it('gives the exact half height of a centered sphere', () => {
    const d = 20;
    const r = 1.5;
    const e = sphereScreenExtents(0, 0, -d, r, p[0], p[5]);
    // Tangent half-angle: sin a = r / d, NDC = p5 · tan a.
    expect(e.top).toBeCloseTo((p[5] * r) / Math.sqrt(d * d - r * r), 12);
    expect(e.bottom).toBeCloseTo(-e.top, 12);
    expect(screenFraction(e)).toBeCloseTo(Math.max(e.right - e.left, e.top - e.bottom) / 2, 12);
  });

  it('treats spheres around or behind the eye as full screen', () => {
    expect(sphereScreenExtents(0, 0, -0.5, 1, p[0], p[5])).toEqual({ left: -1, bottom: -1, right: 1, top: 1 });
    expect(sphereScreenExtents(1, 2, 30, 1, p[0], p[5])).toEqual({ left: -1, bottom: -1, right: 1, top: 1 });
  });

  it('shrinks with distance', () => {
    const near = screenFraction(sphereScreenExtents(0, 0, -10, 1, p[0], p[5]));
    const far = screenFraction(sphereScreenExtents(0, 0, -100, 1, p[0], p[5]));
    expect(far).toBeLessThan(near);
    expect(far).toBeCloseTo(near / 10, 2);
  });
});

describe('nextCulled', () => {
  it('culls below the threshold and restores only above threshold × (1 + hysteresis)', () => {
    expect(nextCulled(false, 0.0049, 0.005, 0.1)).toBe(true);
    expect(nextCulled(false, 0.0051, 0.005, 0.1)).toBe(false);
    // Inside the band the state holds either way.
    expect(nextCulled(true, 0.0052, 0.005, 0.1)).toBe(true);
    expect(nextCulled(false, 0.0052, 0.005, 0.1)).toBe(false);
    expect(nextCulled(true, 0.00551, 0.005, 0.1)).toBe(false);
  });

  it('does not flicker for sizes jittering around the threshold', () => {
    let culled = false;
    let flips = 0;
    for (let i = 0; i < 200; i++) {
      const f = 0.005 * (1 + 0.04 * Math.sin(i * 1.7));
      const next = nextCulled(culled, f, 0.005, 0.1);
      if (next !== culled) flips++;
      culled = next;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('never culls with a threshold of 0', () => {
    expect(nextCulled(false, 0, 0, 0.1)).toBe(false);
    expect(nextCulled(true, 0, 0, 0.1)).toBe(false);
  });
});

const DOC = {
  format: 'three-geo-building',
  version: '1.0',
  id: 'b1',
  anchor: { longitude: 116.39, latitude: 39.9, height: 50 },
  floors: [
    {
      id: 'f1',
      index: 0,
      elevation: 0,
      height: 4,
      rooms: [{ id: 'r1', footprint: [[0, 0], [20, 0], [20, 10], [0, 10]] }],
      things: [
        { id: 'cam', category: 'camera', position: [5, 5, 3], size: [0.3, 0.3, 0.3] },
        { id: 'sensor', category: 'sensor', position: [8, 5, 1], size: [0.2, 0.2, 0.2] },
        { id: 'rack', category: 'rack', position: [12, 5, 0], size: [0.6, 1, 2] },
      ],
      elements: [
        { id: 'w1', kind: 'wall', path: [[0, 0], [20, 0]] },
        { id: 's1', kind: 'slab', path: [[0, 0], [2, 0], [2, 2]] },
        { id: 'c1', kind: 'column', position: [10, 10, 0], size: [0.3, 0.3, 4] },
        { id: 'd1', kind: 'door', position: [3, 0, 0], size: [0.9, 0.1, 2] },
      ],
    },
  ],
};

function host(camera: PerspectiveCamera): IndoorHost {
  return {
    ellipsoid: E,
    camera,
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => null,
    flyToView: () => Promise.resolve(),
    getCameraPose: () => ({ position: camera.position.clone(), heading: 0, pitch: -30 }),
    flyToPose: () => Promise.resolve(),
    setTilesetsVisible: () => undefined,
    loadModel: null,
    createLabelElement: () => ({}) as HTMLElement,
  };
}

function setup(batching = true) {
  const camera = new PerspectiveCamera(50, 1.6, 0.1, 1e8);
  const indoor = new IndoorManager(host(camera));
  indoor.batchDevices = batching;
  const b = indoor.add(DOC);
  for (const f of b.floors) f.visible = true;
  const get = (id: string) => indoor.getById(id)!;
  const center = b.worldBounds()!.center.clone();
  const up = center.clone().normalize();
  /** Puts the camera `distance` meters above the building, looking down at it. */
  const lookFrom = (distance: number) => {
    camera.position.copy(center).addScaledVector(up, distance);
    camera.up.set(0, 0, 1);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  /** Forces a culling pass now. */
  const pass = () => {
    indoor.culling.invalidate();
    return indoor.update(0);
  };
  return { indoor, b, get, lookFrom, pass };
}

/** Whether a device is drawn: its meshes are visible, or its instances sit in a batch. */
function drawn(b: Building, e: BimEntity): boolean {
  if (e.meshes.length > 0) return e.meshes.every((m) => m.visible) && e.effectivelyVisible;
  return b.batchMeshes.some((m) => m.slots.slice(0, m.count).some((s) => s.entity === e));
}

describe('ContributionCuller', () => {
  it('is off by default', () => {
    const { indoor, get, lookFrom, pass } = setup();
    lookFrom(5000);
    expect(indoor.culling.enabled).toBe(false);
    pass();
    expect(get('cam').culled).toBe(false);
  });

  it('only things and non-structural elements take part', () => {
    const { get } = setup();
    expect(isCullable(get('cam'))).toBe(true);
    expect(isCullable(get('d1'))).toBe(true);
    for (const id of ['w1', 's1', 'c1', 'f1', 'r1', 'b1']) expect(isCullable(get(id))).toBe(false);
  });

  for (const batching of [true, false]) {
    describe(batching ? 'batched devices' : 'per-mesh devices', () => {
      it('hides small devices from afar and restores them up close', () => {
        const { indoor, b, get, lookFrom, pass } = setup(batching);
        indoor.culling.configure({ enabled: true });
        lookFrom(2000);
        expect(pass()).toBe(true);
        for (const id of ['cam', 'sensor', 'rack', 'd1']) {
          expect(get(id).culled).toBe(true);
          expect(drawn(b, get(id))).toBe(false);
          // User visibility is untouched.
          expect(get(id).visible).toBe(true);
        }
        lookFrom(30);
        expect(pass()).toBe(true);
        for (const id of ['cam', 'sensor', 'rack', 'd1']) {
          expect(get(id).culled).toBe(false);
          expect(drawn(b, get(id))).toBe(true);
        }
      });

      it('never culls structure and slabs, whatever the threshold', () => {
        const { indoor, b, get, lookFrom, pass } = setup(batching);
        indoor.culling.configure({ enabled: true, threshold: 2, selector: null, rules: [{ selector: '.element', threshold: 5 }] });
        lookFrom(10);
        pass();
        expect(get('cam').culled).toBe(true);
        for (const id of ['w1', 's1', 'c1', 'f1', 'r1', 'b1']) {
          expect(get(id).culled).toBe(false);
          for (const m of get(id).meshes) expect(m.visible).toBe(true);
        }
        // Floor slab (a floor mesh) stays.
        expect(b.floors[0].meshes.every((m) => m.visible)).toBe(true);
      });

      it('keeps user visibility apart from culling', () => {
        const { indoor, b, get, lookFrom, pass } = setup(batching);
        indoor.culling.configure({ enabled: true });
        const cam = get('cam');
        cam.visible = false;
        lookFrom(30);
        pass();
        expect(drawn(b, cam)).toBe(false);
        // Hidden entities keep their state; shown far away, the next pass culls them.
        lookFrom(2000);
        pass();
        expect(cam.culled).toBe(false);
        cam.visible = true;
        pass();
        expect(cam.culled).toBe(true);
        expect(drawn(b, cam)).toBe(false);
        // Showing a culled entity does not bring it back before the culler does.
        cam.visible = false;
        cam.visible = true;
        expect(drawn(b, cam)).toBe(false);
        lookFrom(30);
        pass();
        expect(drawn(b, cam)).toBe(true);
      });
    });
  }

  it('restores everything when disabled', () => {
    const { indoor, b, get, lookFrom, pass } = setup();
    indoor.culling.configure({ enabled: true });
    lookFrom(2000);
    pass();
    expect(indoor.culling.stats.culled).toBe(4);
    indoor.culling.enabled = false;
    expect(get('cam').culled).toBe(false);
    expect(drawn(b, get('cam'))).toBe(true);
    expect(indoor.culling.stats.culled).toBe(0);
    expect(pass()).toBe(false);
  });

  it('narrows the candidates with a selector and per-category thresholds', () => {
    const { indoor, get, lookFrom, pass } = setup();
    indoor.culling.configure({ enabled: true, selector: '.thing' });
    lookFrom(2000);
    pass();
    expect(get('cam').culled).toBe(true);
    expect(get('d1').culled).toBe(false);
    // A rule with threshold 0 keeps cameras; a large one culls racks from nearby.
    indoor.culling.configure({
      rules: [
        { selector: '[category=camera]', threshold: 0 },
        { selector: '[category=rack]', threshold: 0.5 },
      ],
    });
    pass();
    expect(get('cam').culled).toBe(false);
    expect(get('sensor').culled).toBe(true);
    lookFrom(30);
    pass();
    expect(get('rack').culled).toBe(true);
    expect(get('sensor').culled).toBe(false);
    // Leaving the selection restores what was culled.
    indoor.culling.configure({ selector: '[category=camera]', rules: [] });
    lookFrom(2000);
    pass();
    expect(get('rack').culled).toBe(false);
    expect(get('cam').culled).toBe(true);
  });

  it('rejects a malformed selector and keeps the previous options', () => {
    const { indoor } = setup();
    indoor.culling.configure({ enabled: true, threshold: 0.01 });
    expect(() => indoor.culling.configure({ selector: '[category=' })).toThrow();
    expect(indoor.culling.options.threshold).toBe(0.01);
    expect(indoor.culling.options.selector).toBe(null);
  });

  it('never culls the selection', () => {
    const { indoor, get, lookFrom, pass } = setup();
    indoor.culling.configure({ enabled: true });
    indoor.select(get('cam'));
    lookFrom(2000);
    pass();
    expect(get('cam').culled).toBe(false);
    expect(get('sensor').culled).toBe(true);
    indoor.select(null);
    pass();
    expect(get('cam').culled).toBe(true);
  });

  it('evaluates only every `interval` frames unless invalidated', () => {
    const { indoor, get, lookFrom } = setup();
    indoor.culling.configure({ enabled: true, interval: 4 });
    lookFrom(2000);
    indoor.update(0); // the configure forces the first pass
    expect(get('cam').culled).toBe(true);
    lookFrom(30);
    let frames = 0;
    while (get('cam').culled && frames < 10) {
      indoor.update(0);
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThanOrEqual(4);
  });

  it('reads the URL parameters (off unless ?cull=1; invalid values ignored)', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(parseCullingParams(q(''))).toEqual({ enabled: undefined, options: {} });
    expect(parseCullingParams(q('cull=1&cullThreshold=0.01&cullHysteresis=0.2&cullInterval=3.4&cullSelector=.thing'))).toEqual({
      enabled: true,
      options: { threshold: 0.01, hysteresis: 0.2, interval: 3, selector: '.thing' },
    });
    expect(parseCullingParams(q('cull=0&cullThreshold=2&cullInterval=0&cullSelector=[category='))).toEqual({ enabled: false, options: {} });
  });

  it('forgets the entities of a removed building', () => {
    const { indoor, b, lookFrom, pass } = setup();
    indoor.culling.configure({ enabled: true });
    lookFrom(2000);
    pass();
    expect(indoor.culling.stats.culled).toBeGreaterThan(0);
    indoor.remove(b);
    indoor.update(0);
    expect(indoor.culling.stats).toEqual({ candidates: 0, culled: 0 });
  });
});
