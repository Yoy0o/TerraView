import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { TerraViewError } from '../src/core/errors';
import { DEG2RAD } from '../src/core/math';
import { buildWallGeometry } from '../src/local/RegionWalls';
import {
  boxFootprint,
  convexHull,
  MAX_REGION_VERTICES,
  polygonSignedDistance,
  RegionRelation,
  resolveRegion,
  ringSelfIntersects,
  type ResolvedRegion,
} from '../src/region/region';
import { getHeadingPitch, orientationFromHeadingPitch, rayFromNdc } from '../src/viewer/cameraMath';
import { GlobeCameraController, type CameraBounds } from '../src/viewer/GlobeCameraController';

const E = Ellipsoid.WGS84;
const LON = 116.39;
const LAT = 39.91;

function world(r: ResolvedRegion, x: number, y: number, z = 0): Vector3 {
  return r.toWorld(new Vector3(x, y, z));
}

function invalidCode(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TerraViewError ? e.code : 'other';
  }
}

describe('resolveRegion', () => {
  it('places a circle on the ellipsoid in the ENU frame of its center', () => {
    const r = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 2000 }, E);
    expect(r.kind).toBe('circle');
    expect(r.radius).toBe(2000);
    expect(r.contains(LON, LAT)).toBe(true);
    // ~1.8 km east is inside, ~2.2 km east is not (1 degree of longitude ≈ 85.4 km at this latitude).
    expect(r.contains(LON + 1.8 / 85.4, LAT)).toBe(true);
    expect(r.contains(LON + 2.2 / 85.4, LAT)).toBe(false);
    expect(r.outline.length).toBe(128);
    // The frame origin is the center at its height, x east, y north.
    const c = E.cartesianToCartographic(world(r, 0, 0))!;
    expect(c.longitude / DEG2RAD).toBeCloseTo(LON, 9);
    expect(c.latitude / DEG2RAD).toBeCloseTo(LAT, 9);
    const east = E.cartesianToCartographic(world(r, 1000, 0))!;
    expect(east.longitude / DEG2RAD).toBeGreaterThan(LON);
    expect(east.latitude / DEG2RAD).toBeCloseTo(LAT, 4);
  });

  it('follows the ground height at the center', () => {
    const r = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 500 }, E);
    r.setCenterHeight(1234);
    const c = E.cartesianToCartographic(world(r, 0, 0))!;
    expect(c.height).toBeCloseTo(1234, 6);
    expect(r.containsWorld(E.cartographicToCartesian(LON * DEG2RAD, LAT * DEG2RAD, 1300))).toBe(true);
  });

  it('densifies rectangles so the prism follows the parallels', () => {
    const r = resolveRegion({ type: 'rectangle', west: 116.3, south: 39.85, east: 116.5, north: 39.95 }, E);
    expect(r.kind).toBe('polygon');
    expect(r.vertices.length / 2).toBe(32);
    expect(r.contains(116.4, 39.9)).toBe(true);
    expect(r.contains(116.29, 39.9)).toBe(false);
    expect(r.contains(116.4, 39.96)).toBe(false);
    // The middle of the north edge is still inside just below it.
    expect(r.contains(116.4, 39.9499)).toBe(true);
  });

  it('accepts polygons, dropping a closing vertex', () => {
    const ring: [number, number][] = [
      [116.3, 39.9],
      [116.35, 39.9],
      [116.35, 39.95],
      [116.3, 39.9],
    ];
    const r = resolveRegion({ type: 'polygon', coordinates: ring }, E);
    expect(r.vertices.length / 2).toBe(3);
    expect(r.contains(116.34, 39.91)).toBe(true);
    expect(r.contains(116.31, 39.94)).toBe(false);
  });

  it('simplifies polygons with too many vertices and keeps their shape', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      // A wobbly circle about 3 km across.
      const k = 1 + 0.05 * Math.sin(a * 7);
      ring.push([LON + (Math.cos(a) * 0.017 * k), LAT + (Math.sin(a) * 0.0135 * k)]);
    }
    const r = resolveRegion({ type: 'polygon', coordinates: ring }, E);
    expect(r.vertices.length / 2).toBeLessThanOrEqual(MAX_REGION_VERTICES);
    expect(r.vertices.length / 2).toBeGreaterThan(16);
    expect(r.contains(LON, LAT)).toBe(true);
    expect(r.contains(LON + 0.02, LAT)).toBe(false);
  });

  it('rejects invalid regions with option-invalid', () => {
    expect(invalidCode(() => resolveRegion({ type: 'circle', center: [LON, LAT], radius: 60_000 }, E))).toBe('option-invalid');
    expect(invalidCode(() => resolveRegion({ type: 'circle', center: [LON, LAT], radius: 5 }, E))).toBe('option-invalid');
    expect(invalidCode(() => resolveRegion({ type: 'circle', center: [LON, 89], radius: 500 }, E))).toBe('option-invalid');
    expect(invalidCode(() => resolveRegion({ type: 'rectangle', west: 116.5, south: 39, east: 116.3, north: 40 }, E))).toBe('option-invalid');
    // Much more than 100 km across.
    expect(invalidCode(() => resolveRegion({ type: 'rectangle', west: 116, south: 39, east: 118, north: 40 }, E))).toBe('option-invalid');
    // Crosses the antimeridian.
    const crossing: [number, number][] = [
      [179.9, 0],
      [-179.9, 0],
      [-179.9, 0.1],
    ];
    expect(invalidCode(() => resolveRegion({ type: 'polygon', coordinates: crossing }, E))).toBe('option-invalid');
    // A bow tie.
    const bowTie: [number, number][] = [
      [116.3, 39.9],
      [116.32, 39.92],
      [116.32, 39.9],
      [116.3, 39.92],
    ];
    expect(invalidCode(() => resolveRegion({ type: 'polygon', coordinates: bowTie }, E))).toBe('option-invalid');
    expect(invalidCode(() => resolveRegion({ type: 'polygon', coordinates: [[1, 2]] }, E))).toBe('option-invalid');
    expect(invalidCode(() => resolveRegion({ type: 'hexagon' } as never, E))).toBe('option-invalid');
  });
});

describe('region queries', () => {
  const square = resolveRegion(
    {
      type: 'polygon',
      coordinates: [
        [LON - 0.01, LAT - 0.01],
        [LON + 0.01, LAT - 0.01],
        [LON + 0.01, LAT + 0.01],
        [LON - 0.01, LAT + 0.01],
      ],
    },
    E,
  );

  it('measures signed distances to the boundary', () => {
    const v = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(polygonSignedDistance(v, 5, 5)).toBeCloseTo(5);
    expect(polygonSignedDistance(v, 5, 1)).toBeCloseTo(1);
    expect(polygonSignedDistance(v, 5, -3)).toBeCloseTo(-3);
    expect(polygonSignedDistance(v, 13, 14)).toBeCloseTo(-5);
  });

  it('classifies spheres as outside, crossing or inside', () => {
    const c = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 1000 }, E);
    expect(c.relateSphere(world(c, 0, 0), 500)).toBe(RegionRelation.INSIDE);
    expect(c.relateSphere(world(c, 900, 0), 500)).toBe(RegionRelation.CROSSING);
    expect(c.relateSphere(world(c, 3000, 0), 500)).toBe(RegionRelation.OUTSIDE);
    // A sphere around the whole region (a coarse tile) crosses it.
    expect(c.relateSphere(world(c, 0, 0), 50_000)).toBe(RegionRelation.CROSSING);
    // The far side of the planet projects into the prism, but is outside its height band.
    expect(c.relateSphere(world(c, 0, 0).negate(), 1000)).toBe(RegionRelation.OUTSIDE);
    // Too high up.
    expect(c.relateSphere(world(c, 0, 0, 100_000), 1000)).toBe(RegionRelation.OUTSIDE);
  });

  it('clamps points back inside, widened by a margin', () => {
    const c = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 1000 }, E);
    const out = { x: 0, y: 0 };
    expect(c.clampXY(100, 200, 50, out)).toBe(false);
    expect(out).toEqual({ x: 100, y: 200 });
    expect(c.clampXY(3000, 4000, 50, out)).toBe(true);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1050);
    expect(out.y / out.x).toBeCloseTo(4 / 3);
    const half = square.vertices[2];
    expect(square.clampXY(half + 500, 0, 100, out)).toBe(true);
    expect(out.x).toBeCloseTo(half + 100, 0);
    expect(out.y).toBeCloseTo(0, 0);
  });

  it('samples the boundary as a closed loop with every vertex', () => {
    const pts = square.boundaryPoints(100);
    const n = pts.length / 2;
    // About 1.7 km per side at this latitude: at least 17 points per side.
    expect(n).toBeGreaterThanOrEqual(4 * 17);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      expect(Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1])).toBeLessThanOrEqual(100.0001 + 25);
      expect(Math.abs(square.signedDistance(pts[i * 2], pts[i * 2 + 1]))).toBeLessThan(1e-6);
    }
    const c = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 1000 }, E);
    expect(c.boundaryPoints(10).length / 2).toBeGreaterThanOrEqual(628);
  });

  it('finds self-intersections and convex hulls', () => {
    expect(ringSelfIntersects(new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]))).toBe(false);
    expect(ringSelfIntersects(new Float64Array([0, 0, 10, 10, 10, 0, 0, 10]))).toBe(true);
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
    ]);
    expect(hull).toHaveLength(4);
  });

  it('turns a box into its ground footprint', () => {
    const r = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 1000 }, E);
    const corners: Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(world(r, i & 1 ? 300 : -300, i & 2 ? 200 : -200, i & 4 ? 80 : 0));
    const ring = boxFootprint(corners, E);
    expect(ring).toHaveLength(4);
    const fp = resolveRegion({ type: 'polygon', coordinates: ring }, E);
    expect(fp.contains(LON, LAT)).toBe(true);
    expect(fp.radius).toBeCloseTo(Math.hypot(300, 200), -1);
  });
});

describe('buildWallGeometry', () => {
  function columns(xy: number[]) {
    const n = xy.length / 2;
    return {
      xy: new Float64Array(xy),
      top: new Float32Array(n).fill(10),
      bottom: new Float32Array(n).fill(-40),
      topHeight: new Float32Array(n).fill(110),
      baseHeight: 60,
    };
  }

  it('builds one quad per segment, facing out, either way round', () => {
    for (const xy of [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [0, 0, 0, 100, 100, 100, 100, 0],
    ]) {
      const g = buildWallGeometry(columns(xy));
      expect(g.getAttribute('position').count).toBe(16);
      expect(g.getIndex()!.count).toBe(24);
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      // Each quad's normal points away from the square's center.
      for (let q = 0; q < 4; q++) {
        const cx = (pos.getX(q * 4) + pos.getX(q * 4 + 2)) / 2 - 50;
        const cy = (pos.getY(q * 4) + pos.getY(q * 4 + 2)) / 2 - 50;
        expect(nor.getX(q * 4) * cx + nor.getY(q * 4) * cy).toBeGreaterThan(0);
      }
      // Triangle winding agrees with the normals (front faces outside).
      const idx = g.getIndex()!;
      const a = new Vector3().fromBufferAttribute(pos, idx.getX(0));
      const b = new Vector3().fromBufferAttribute(pos, idx.getX(1));
      const c = new Vector3().fromBufferAttribute(pos, idx.getX(2));
      const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
      expect(n.x * nor.getX(idx.getX(0)) + n.y * nor.getY(idx.getX(0))).toBeCloseTo(1, 5);
      expect(g.getAttribute('wallDepth').getX(1)).toBe(50);
      expect(g.getAttribute('wallHeight').getX(0)).toBe(110);
    }
  });
});

// ---------------------------------------------------------------------------
// Camera bounds against a real controller

const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
let savedWindow: unknown;
beforeAll(() => {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = listeners;
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
});

describe('camera bounds', () => {
  const region = resolveRegion({ type: 'circle', center: [LON, LAT], radius: 2000 }, E);

  function setup(x: number, y: number, height: number, heading: number, pitch: number) {
    const camera = new PerspectiveCamera(50, 16 / 9, 1, 1e8);
    camera.position.copy(world(region, x, y, height));
    orientationFromHeadingPitch(E, camera.position, heading * DEG2RAD, pitch * DEG2RAD, camera.quaternion);
    camera.updateMatrixWorld();
    // Only the area is there to hit (a floating local scene).
    const pick = (ndc: Vector2) => {
      camera.updateMatrixWorld();
      const ray = rayFromNdc(camera, ndc);
      const t = E.intersectRay(ray);
      const p = t === null ? null : ray.at(t, new Vector3());
      return p && region.containsWorld(p) ? p : null;
    };
    const dom = {
      ...listeners,
      style: {} as Record<string, string>,
      clientWidth: 1600,
      clientHeight: 900,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    };
    const controller = new GlobeCameraController({ camera, ellipsoid: E, domElement: dom as unknown as HTMLElement, pick, groundHeight: () => 0 });
    const margin = 500;
    const bounds: CameraBounds = {
      center: world(region, 0, 0),
      referenceHeight: 0,
      maxRange: 12_000,
      clampFocus: (p, out) => {
        const q = region.toRegion(p);
        const xy = { x: 0, y: 0 };
        if (!region.clampXY(q.x, q.y, margin, xy)) return false;
        region.toWorld(new Vector3(xy.x, xy.y, q.z), out);
        return true;
      },
    };
    controller.bounds = bounds;
    return { camera, controller, bounds };
  }

  /** Horizontal distance (region frame) from the area center to the line of sight down to the ground. */
  function sightDistance(camera: PerspectiveCamera): number {
    camera.updateMatrixWorld();
    const ray = rayFromNdc(camera, new Vector2(0, 0));
    const a = region.toRegion(camera.position);
    const b = region.toRegion(ray.at(E.intersectRay(ray)!, new Vector3()));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy)));
    return Math.hypot(a.x + dx * t, a.y + dy * t);
  }

  it('pulls the line of sight back over the area and keeps heading, pitch and zero roll', () => {
    // 6 km east of the center, looking away from it.
    const { camera, controller } = setup(6000, 0, 3000, 30, -70);
    const before = getHeadingPitch(E, camera.position, camera.quaternion);
    expect(sightDistance(camera)).toBeGreaterThan(5000);
    controller.update(1 / 60);
    expect(sightDistance(camera)).toBeLessThanOrEqual(2500 + 15);
    const after = getHeadingPitch(E, camera.position, camera.quaternion);
    expect(after.heading).toBeCloseTo(before.heading, 6);
    expect(after.pitch).toBeCloseTo(before.pitch, 6);
    // Zero roll: the camera's right vector is horizontal.
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = E.geodeticNormal(camera.position);
    expect(Math.abs(right.dot(up))).toBeLessThan(1e-9);
  });

  it('leaves a view inside the area alone', () => {
    const { camera, controller } = setup(500, -300, 2000, 0, -60);
    const p = camera.position.clone();
    controller.update(1 / 60);
    expect(camera.position.distanceTo(p)).toBe(0);
  });

  it('lets a low view look across the area to the horizon', () => {
    // Inside the area, 200 m up, looking north almost level: the ground at the screen center is
    // far beyond the boundary, but the line of sight passes over the area.
    const { camera, controller } = setup(0, -1500, 200, 0, -3);
    const p = camera.position.clone();
    controller.update(1 / 60);
    expect(camera.position.distanceTo(p)).toBe(0);
  });

  it('stops zooming out at the maximum range', () => {
    const { camera, controller, bounds } = setup(0, -3000, 4000, 0, -50);
    for (let i = 0; i < 40; i++) {
      controller.zoomBy(-1);
      for (let k = 0; k < 10; k++) controller.update(1 / 60);
    }
    expect(camera.position.distanceTo(bounds.center)).toBeLessThanOrEqual(bounds.maxRange * 1.001);
  });

  it('keeps the camera height while a drag pushes past the edge, towards the horizon and beyond', () => {
    const { camera, controller, bounds } = setup(0, -3000, 2300, 0, -35);
    const height = () => E.cartesianToCartographic(camera.position)!.height;
    const h0 = height();
    const ndc = (x: number, y: number) => new Vector2((x / 1600) * 2 - 1, -(y / 900) * 2 + 1);
    // Drives the pan gesture directly (no DOM events in this test).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = controller as any;
    c.beginPan(ndc(500, 450));
    for (let i = 0; i < 80; i++) {
      c.dragTo(ndc(500 - i * 15, 450 - i * 15));
      controller.update(1 / 60);
    }
    expect(Math.abs(height() - h0)).toBeLessThan(1);
    expect(sightDistance(camera)).toBeLessThanOrEqual(2500 + 15);
    expect(camera.position.distanceTo(bounds.center)).toBeLessThanOrEqual(bounds.maxRange * 1.01);
  });

  it('orbits the area center when the screen center is over empty space', async () => {
    // Looking towards the horizon over the area: the screen center misses it.
    const { camera, controller, bounds } = setup(0, -2500, 300, 0, -2);
    expect(controller.bounds).toBe(bounds);
    const d0 = camera.position.distanceTo(bounds.center);
    const done = controller.orbitBy(Math.PI / 2, 0, 0.2);
    for (let i = 0; i < 30; i++) controller.update(1 / 60);
    await done;
    // Orbiting the center keeps the distance to it; turning in place would not move the camera.
    expect(camera.position.distanceTo(bounds.center)).toBeCloseTo(d0, -1);
    const q = region.toRegion(camera.position);
    expect(q.x).toBeLessThan(-1000);
  });
});
