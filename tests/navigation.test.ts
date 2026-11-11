import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { angleDelta, DEG2RAD } from '../src/core/math';
import { getHeadingPitch, orientationFromHeadingPitch, rayFromNdc } from '../src/viewer/cameraMath';
import type { GeoViewer } from '../src/viewer/GeoViewer';
import { GlobeCameraController } from '../src/viewer/GlobeCameraController';
import { AUTO_ROTATE_DEFAULTS, classifyAutoRotate, globeSpinRate, NavigationControls } from '../src/viewer/NavigationControls';

const E = Ellipsoid.WGS84;
const S = AUTO_ROTATE_DEFAULTS;

describe('classifyAutoRotate', () => {
  it('spins the globe from a global view', () => {
    expect(classifyAutoRotate({ height: 1.75e7, pitch: -90, pivotDistance: 1.75e7 }, S)).toBe('globe');
    // Tilted at a global height: still the globe (orbiting a far point would swing the planet).
    expect(classifyAutoRotate({ height: 5e6, pitch: -40, pivotDistance: 6e6 }, S)).toBe('globe');
    // High above with the screen center off the globe: the spin needs no pivot.
    expect(classifyAutoRotate({ height: 5e5, pitch: -10, pivotDistance: null }, S)).toBe('globe');
  });

  it('orbits near the ground when tilted, tilts first when looking straight down', () => {
    expect(classifyAutoRotate({ height: 2000, pitch: -45, pivotDistance: 2800 }, S)).toBe('orbit');
    expect(classifyAutoRotate({ height: 2000, pitch: -90, pivotDistance: 2000 }, S)).toBe('tilt-orbit');
    expect(classifyAutoRotate({ height: 2000, pitch: -76, pivotDistance: 2100 }, S)).toBe('tilt-orbit');
    expect(classifyAutoRotate({ height: 2000, pitch: -90, pivotDistance: 2000 }, { ...S, tiltBeforeOrbit: null })).toBe('orbit');
  });

  it('judges the scale by the pivot distance, not the height', () => {
    // Low, but looking at a horizon 300 km away: no orbit, and too low for a globe spin.
    expect(classifyAutoRotate({ height: 2000, pitch: -3, pivotDistance: 300_000 }, S)).toBe('none');
    // Looking at the sky from low down.
    expect(classifyAutoRotate({ height: 2000, pitch: 10, pivotDistance: null }, S)).toBe('none');
    // A small orbit limit does not turn a low view into a globe spin (globeMinHeight).
    expect(classifyAutoRotate({ height: 3000, pitch: -45, pivotDistance: 4200 }, { ...S, orbitMaxDistance: 1000 })).toBe('none');
    // Exactly at the limit still orbits.
    expect(classifyAutoRotate({ height: 150_000, pitch: -60, pivotDistance: S.orbitMaxDistance }, S)).toBe('orbit');
  });
});

// ---------------------------------------------------------------------------
// NavigationControls against a real controller

const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
let savedWindow: unknown;
beforeAll(() => {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = listeners;
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
});

function setup(lon: number, lat: number, height: number, heading: number, pitch: number) {
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 1e8);
  E.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, height, camera.position);
  orientationFromHeadingPitch(E, camera.position, heading * DEG2RAD, pitch * DEG2RAD, camera.quaternion);
  const surface = (ndc: Vector2) => {
    const ray = rayFromNdc(camera, ndc);
    const t = E.intersectRay(ray);
    return t === null ? null : ray.at(t, new Vector3());
  };
  const dom = {
    ...listeners,
    style: {} as Record<string, string>,
    clientWidth: 1600,
    clientHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
  };
  const controller = new GlobeCameraController({ camera, ellipsoid: E, domElement: dom as unknown as HTMLElement, pick: surface, groundHeight: () => 0 });
  // The parts of GeoViewer that NavigationControls uses (startAutoOrbit mirrors GeoViewer's rule).
  const viewer = {
    camera,
    ellipsoid: E,
    controller,
    getView: () => {
      const c = E.cartesianToCartographic(camera.position)!;
      const hp = getHeadingPitch(E, camera.position, camera.quaternion);
      return { longitude: c.longitude / DEG2RAD, latitude: c.latitude / DEG2RAD, height: c.height, heading: hp.heading / DEG2RAD, pitch: hp.pitch / DEG2RAD };
    },
    pick: (ndc: Vector2) => {
      const p = surface(ndc);
      return p ? { point: p } : null;
    },
    pickReferenceSurface: () => null,
    startAutoOrbit: (options: { pivot?: Vector3; degreesPerSecond?: number } = {}) => {
      const pivot = nav.orbitPivot(options.pivot);
      return pivot ? controller.startAutoOrbit({ ...options, pivot }) : Promise.resolve();
    },
    stopAutoOrbit: () => controller.stopAutoOrbit(),
  };
  const nav = new NavigationControls(viewer as unknown as GeoViewer, {} as HTMLElement, { longitude: 0, latitude: 0, height: 1e7 });
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) controller.update(1 / 60);
  };
  return { camera, controller, nav, viewer, run };
}

/** Lets awaited promises inside startAutoRotate continue. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('globeSpinRate', () => {
  it('keeps full speed from 10,000 km up and slows proportionally below', () => {
    expect(globeSpinRate(6, 1.75e7)).toBe(6);
    expect(globeSpinRate(6, 1e7)).toBe(6);
    expect(globeSpinRate(6, 5e6)).toBeCloseTo(3);
    expect(globeSpinRate(6, 1000)).toBeCloseTo(0.06);
  });
});

describe('auto rotate', () => {
  it('spins the globe from a global view, keeping latitude, heading and pitch', () => {
    const { nav, controller, viewer, run } = setup(112, 26, 1.75e7, 0, -90);
    expect(nav.autoRotateMode).toBe('globe');
    void nav.startAutoRotate();
    expect(nav.isAutoRotating).toBe(true);
    run(2);
    const v = viewer.getView();
    // 6°/s for 2 s, moving west (the globe turns east).
    expect(angleDelta(112 * DEG2RAD, v.longitude * DEG2RAD) / DEG2RAD).toBeCloseTo(-12, 0);
    expect(v.latitude).toBeCloseTo(26, 6);
    expect(v.pitch).toBeCloseTo(-90, 3);
    expect(controller.isAutoOrbiting).toBe(false);
    nav.stopAutoRotate();
    expect(nav.isAutoRotating).toBe(false);
    expect(controller.isAnimating).toBe(false);
  });

  it('tilts a top-down ground view to -45° first, then orbits', async () => {
    const { nav, controller, viewer, run } = setup(116.39, 39.9, 3000, 0, -90);
    expect(nav.autoRotateMode).toBe('tilt-orbit');
    const done = nav.startAutoRotate();
    expect(nav.isAutoRotating).toBe(true);
    run(1);
    await flush();
    expect(viewer.getView().pitch).toBeGreaterThan(-50);
    expect(viewer.getView().pitch).toBeLessThan(-40);
    expect(controller.isAutoOrbiting).toBe(true);
    const h0 = viewer.getView().heading;
    run(1);
    expect(Math.abs(angleDelta(viewer.getView().heading * DEG2RAD, h0 * DEG2RAD) / DEG2RAD)).toBeGreaterThan(8);
    nav.toggleAutoRotate();
    expect(nav.isAutoRotating).toBe(false);
    await done;
  });

  it('a gesture during the tilt cancels the orbit that would follow', async () => {
    const { nav, controller, run } = setup(116.39, 39.9, 3000, 0, -90);
    const done = nav.startAutoRotate();
    run(0.2);
    controller.events.emit('interactionstart', undefined);
    controller.stopAutoOrbit();
    run(1);
    await flush();
    await done;
    expect(controller.isAutoOrbiting).toBe(false);
    expect(nav.isAutoRotating).toBe(false);
  });

  it('orbits a tilted ground view directly, and refuses far pivots', () => {
    const { nav, controller } = setup(116.39, 39.9, 3000, 0, -45);
    expect(nav.autoRotateMode).toBe('orbit');
    void nav.startAutoRotate();
    expect(controller.isAutoOrbiting).toBe(true);
    nav.stopAutoRotate();
    const far = E.cartographicToCartesian(120 * DEG2RAD, 30 * DEG2RAD, 0);
    expect(nav.orbitPivot(far)).toBeNull();
  });

  it('honors the filter and the distance limit', () => {
    const { nav } = setup(116.39, 39.9, 3000, 0, -45);
    nav.autoRotate = { ...nav.autoRotate, filter: (ctx) => ctx.mode !== 'orbit' };
    expect(nav.autoRotateMode).toBe('none');
    nav.autoRotate = { ...AUTO_ROTATE_DEFAULTS, orbitMaxDistance: 1000 };
    // Pivot ~4.2 km away, height 3 km (too low for a globe spin as well): nothing to do.
    expect(nav.autoRotateMode).toBe('none');
  });
});
