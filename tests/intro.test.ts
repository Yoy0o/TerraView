import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { angleDelta, DEG2RAD } from '../src/core/math';
import { cameraUp, getHeadingPitch, orientationFromHeadingPitch, rayFromNdc } from '../src/viewer/cameraMath';
import { GlobeCameraController } from '../src/viewer/GlobeCameraController';
import { INTRO_DEFAULTS, introHeightScale, introSpinAngle, introSpinProfile, playIntroSpin } from '../src/viewer/IntroAnimation';
import { hasStartupFlight, parseCloudParams, parseFlag, parseIntroParams, parseNumber } from '../demo/ui/urlOptions';

const E = Ellipsoid.WGS84;

describe('intro spin profile', () => {
  it('uses the defaults and the closed-form total', () => {
    const p = introSpinProfile();
    expect(p.duration).toBe(INTRO_DEFAULTS.duration);
    expect(p.speed).toBe(INTRO_DEFAULTS.speed);
    expect(p.slowdown).toBeCloseTo(INTRO_DEFAULTS.duration * 0.6);
    expect(p.total).toBeCloseTo(p.speed * (p.duration - p.slowdown) + (p.speed * p.slowdown) / 3);
    expect(introSpinAngle(p, p.duration)).toBeCloseTo(p.total, 9);
  });

  it('starts at full speed, never reverses, and comes to rest at the end', () => {
    const p = introSpinProfile({ duration: 5, speed: 30, slowdown: 3 });
    const h = 1e-4;
    expect((introSpinAngle(p, h) - introSpinAngle(p, 0)) / h).toBeCloseTo(30, 3);
    let prev = -Infinity;
    let prevSpeed = Infinity;
    for (let t = 0; t <= 5; t += 0.05) {
      const a = introSpinAngle(p, t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
      const speed = (introSpinAngle(p, t + h) - a) / h;
      // Speed only drops (no jump up at the start of the slow-down).
      expect(speed).toBeLessThanOrEqual(prevSpeed + 1e-6);
      prevSpeed = speed;
    }
    expect((introSpinAngle(p, 5) - introSpinAngle(p, 5 - h)) / h).toBeLessThan(1e-3);
    // Clamped outside [0, duration].
    expect(introSpinAngle(p, -1)).toBe(0);
    expect(introSpinAngle(p, 99)).toBeCloseTo(p.total, 9);
  });

  it('handles all-cruise, all-slowdown and reversed spins; ignores invalid numbers', () => {
    const cruise = introSpinProfile({ duration: 4, speed: 10, slowdown: 0 });
    expect(cruise.total).toBeCloseTo(40);
    const ease = introSpinProfile({ duration: 4, speed: 30, slowdown: 99 });
    expect(ease.slowdown).toBe(4);
    expect(ease.total).toBeCloseTo(40);
    const reverse = introSpinProfile({ speed: -20 });
    expect(reverse.total).toBeLessThan(0);
    const bad = introSpinProfile({ duration: NaN, speed: Infinity, slowdown: -1 });
    expect(bad.duration).toBe(INTRO_DEFAULTS.duration);
    expect(bad.speed).toBe(INTRO_DEFAULTS.speed);
  });

  it('descends from zoomFrom to the view height', () => {
    const p = introSpinProfile({ duration: 6 });
    expect(introHeightScale(p, 1.5, 0)).toBeCloseTo(1.5);
    expect(introHeightScale(p, 1.5, 6)).toBeCloseTo(1);
    expect(introHeightScale(p, 1.5, 3)).toBeGreaterThan(1);
    expect(introHeightScale(p, 1, 3)).toBe(1);
  });
});

/** Minimal controller stand-in that records the animation step. */
function fakeController() {
  let step: ((dt: number, camera: PerspectiveCamera) => boolean) | null = null;
  return {
    playAnimation(s: (dt: number, camera: PerspectiveCamera) => boolean) {
      step = s;
      return Promise.resolve(true);
    },
    run(camera: PerspectiveCamera, dt: number, frames: number, each?: () => void): boolean {
      let running = true;
      for (let i = 0; i < frames && running; i++) {
        running = step!(dt, camera);
        each?.();
      }
      return running;
    },
  };
}

function cameraAt(lon: number, lat: number, height: number, heading: number, pitch: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 1e8);
  E.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, height, camera.position);
  orientationFromHeadingPitch(E, camera.position, heading * DEG2RAD, pitch * DEG2RAD, camera.quaternion);
  return camera;
}

describe('playIntroSpin', () => {
  it('spins west along the latitude and ends exactly on the starting view, with heading and pitch held', async () => {
    const camera = cameraAt(112, 26, 1.75e7, 20, -80);
    const end = camera.position.clone();
    const controller = fakeController();
    const host = { ellipsoid: E, camera, controller: controller as unknown as GlobeCameraController };
    const options = { duration: 3, speed: 40, zoomFrom: 1.4 };
    const played = playIntroSpin(host, options);
    const profile = introSpinProfile(options);

    // Start pose: east of the view by the total angle, higher by zoomFrom.
    const c0 = E.cartesianToCartographic(camera.position)!;
    expect(angleDelta(c0.longitude, (112 + profile.total) * DEG2RAD)).toBeCloseTo(0, 9);
    expect(c0.latitude / DEG2RAD).toBeCloseTo(26, 6);
    expect(c0.height).toBeCloseTo(1.75e7 * 1.4, 0);

    let lastLon = c0.longitude;
    const finishedEarly = controller.run(camera, 1 / 60, 3 * 60 + 5, () => {
      const c = E.cartesianToCartographic(camera.position)!;
      // Moves west (or stays) every frame; latitude is held.
      expect(angleDelta(lastLon, c.longitude)).toBeLessThanOrEqual(1e-12);
      lastLon = c.longitude;
      expect(c.latitude / DEG2RAD).toBeCloseTo(26, 6);
      const hp = getHeadingPitch(E, camera.position, camera.quaternion);
      expect(angleDelta(hp.heading, 20 * DEG2RAD)).toBeCloseTo(0, 6);
      expect(hp.pitch / DEG2RAD).toBeCloseTo(-80, 6);
      // Zero roll: the camera's right axis stays horizontal.
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      expect(Math.abs(right.dot(E.geodeticNormal(camera.position, new Vector3())))).toBeLessThan(1e-9);
    });
    expect(finishedEarly).toBe(false);
    expect(camera.position.distanceTo(end)).toBeLessThan(1e-3);
    await expect(played).resolves.toBe(true);
  });

  it('skips close-up views unless forced', async () => {
    const camera = cameraAt(116, 40, 5000, 0, -45);
    const before = camera.position.clone();
    const controller = fakeController();
    const host = { ellipsoid: E, camera, controller: controller as unknown as GlobeCameraController };
    await expect(playIntroSpin(host)).resolves.toBe(false);
    expect(camera.position.equals(before)).toBe(true);
    void playIntroSpin(host, { force: true, duration: 1 });
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Controller: scripted animations, zoomBy, orbitBy

const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
let savedWindow: unknown;

beforeAll(() => {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = listeners;
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
});

function makeController(camera: PerspectiveCamera): GlobeCameraController {
  const dom = {
    ...listeners,
    style: {} as Record<string, string>,
    clientWidth: 1600,
    clientHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
  };
  return new GlobeCameraController({
    camera,
    ellipsoid: E,
    domElement: dom as unknown as HTMLElement,
    pick: (ndc: Vector2) => {
      const ray = rayFromNdc(camera, ndc);
      const t = E.intersectRay(ray);
      return t === null ? null : ray.at(t, new Vector3());
    },
    groundHeight: () => 0,
  });
}

function centerPoint(camera: PerspectiveCamera): Vector3 {
  const ray = rayFromNdc(camera, new Vector2(0, 0));
  return ray.at(E.intersectRay(ray)!, new Vector3());
}

function run(controller: GlobeCameraController, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) controller.update(1 / 60);
}

describe('controller animations', () => {
  it('playAnimation runs to the end, or resolves false when a gesture or another motion interrupts it', async () => {
    const camera = cameraAt(0, 0, 2e7, 0, -90);
    const controller = makeController(camera);
    let frames = 0;
    const done = controller.playAnimation(() => ++frames < 5);
    expect(controller.isAnimating).toBe(true);
    run(controller, 0.2);
    expect(frames).toBe(5);
    expect(controller.isAnimating).toBe(false);
    await expect(done).resolves.toBe(true);

    const interrupted = controller.playAnimation(() => true);
    controller.zoomBy(Math.log(2));
    expect(controller.isAnimating).toBe(false);
    await expect(interrupted).resolves.toBe(false);

    const replaced = controller.playAnimation(() => true);
    void controller.flyTo({ position: camera.position.clone(), heading: 0, pitch: -Math.PI / 2 }, 0.1);
    await expect(replaced).resolves.toBe(false);
  });

  it('zoomBy halves / doubles the distance from a top-down global view', () => {
    const camera = cameraAt(30, 45, 3e6, 0, -90);
    const controller = makeController(camera);
    const target = centerPoint(camera);
    const d0 = camera.position.distanceTo(target);
    controller.zoomBy(Math.log(2));
    run(controller, 2);
    expect(camera.position.distanceTo(target) / d0).toBeCloseTo(0.5, 3);
    expect(getHeadingPitch(E, camera.position, camera.quaternion).pitch / DEG2RAD).toBeCloseTo(-90, 4);
    controller.zoomBy(-Math.log(2));
    run(controller, 2);
    expect(camera.position.distanceTo(target) / d0).toBeCloseTo(1, 3);
  });

  it('zoomBy on a tilted view keeps heading, pitch and the center point on screen', () => {
    // Low enough that turning about the earth's center (to keep the point under the center) barely changes the distance.
    const camera = cameraAt(30, 45, 20_000, 25, -60);
    const controller = makeController(camera);
    const target = centerPoint(camera);
    const d0 = camera.position.distanceTo(target);
    const hp0 = getHeadingPitch(E, camera.position, camera.quaternion);
    controller.zoomBy(Math.log(2));
    run(controller, 2);
    expect(camera.position.distanceTo(target) / d0).toBeCloseTo(0.5, 2);
    const hp1 = getHeadingPitch(E, camera.position, camera.quaternion);
    expect(angleDelta(hp1.heading, hp0.heading)).toBeCloseTo(0, 6);
    expect(hp1.pitch).toBeCloseTo(hp0.pitch, 6);
    // The zoom target stays at the screen center.
    const ndc = target.clone().project(camera);
    expect(Math.hypot(ndc.x, ndc.y)).toBeLessThan(1e-4);

    controller.zoomBy(-Math.log(2));
    run(controller, 2);
    expect(camera.position.distanceTo(target) / d0).toBeCloseTo(1, 2);
  });

  it('orbitBy turns the heading around the center point, which stays on screen', async () => {
    const camera = cameraAt(116, 40, 2000, 10, -45);
    const controller = makeController(camera);
    const pivot = centerPoint(camera);
    const done = controller.orbitBy(45 * DEG2RAD, 0, 0.5);
    run(controller, 0.7);
    await done;
    const hp = getHeadingPitch(E, camera.position, camera.quaternion);
    // Turning about the pivot's vertical, a few km away, differs from the camera's own vertical by ~0.01°.
    expect(Math.abs(angleDelta(hp.heading, 55 * DEG2RAD) / DEG2RAD)).toBeLessThan(0.05);
    const ndc = pivot.clone().project(camera);
    expect(Math.hypot(ndc.x, ndc.y)).toBeLessThan(1e-6);
  });

  it('orbitBy tilting up stops at top-down without passing over the pivot or rolling', () => {
    const camera = cameraAt(116, 40, 2000, 30, -45);
    const controller = makeController(camera);
    void controller.orbitBy(0, 120 * DEG2RAD, 0.5);
    run(controller, 0.7);
    const hp = getHeadingPitch(E, camera.position, camera.quaternion);
    expect(hp.pitch / DEG2RAD).toBeLessThan(-89.9);
    expect(angleDelta(hp.heading, 30 * DEG2RAD) / DEG2RAD).toBeCloseTo(0, 1);
    const up = cameraUp(camera.quaternion);
    const north = new Vector3();
    E.eastNorthUp(camera.position, new Vector3(), north, new Vector3());
    // Top-down with heading 30°: screen-up still points roughly along the heading, not flipped.
    expect(up.dot(north)).toBeGreaterThan(0.8);
  });

  it('orbitBy tilting down respects the pitch range', () => {
    const camera = cameraAt(116, 40, 2000, 0, -90);
    const controller = makeController(camera);
    controller.pitchRangeDeg = [-90, -30];
    void controller.orbitBy(0, -80 * DEG2RAD, 0.5);
    run(controller, 0.7);
    const hp = getHeadingPitch(E, camera.position, camera.quaternion);
    // Pitch is the elevation above the pivot's horizon, plus the earth curvature over the short distance.
    expect(hp.pitch / DEG2RAD).toBeGreaterThan(-31);
    expect(hp.pitch / DEG2RAD).toBeLessThan(-29);
  });
});

// ---------------------------------------------------------------------------
// URL parameters (demo app)

describe('URL options', () => {
  const q = (s: string) => new URLSearchParams(s);

  it('parses flags', () => {
    expect(parseFlag(q('intro'), 'intro')).toBe(true);
    expect(parseFlag(q('intro=1'), 'intro')).toBe(true);
    expect(parseFlag(q('intro=on'), 'intro')).toBe(true);
    expect(parseFlag(q('intro=0'), 'intro')).toBe(false);
    expect(parseFlag(q('intro=false'), 'intro')).toBe(false);
    expect(parseFlag(q('intro=maybe'), 'intro')).toBeUndefined();
    expect(parseFlag(q(''), 'intro')).toBeUndefined();
  });

  it('parses numbers within range only', () => {
    expect(parseNumber(q('x=2.5'), 'x', 0, 10)).toBe(2.5);
    expect(parseNumber(q('x=-1'), 'x', 0, 10)).toBeUndefined();
    expect(parseNumber(q('x=abc'), 'x')).toBeUndefined();
    expect(parseNumber(q('x='), 'x')).toBeUndefined();
    expect(parseNumber(q(''), 'x')).toBeUndefined();
  });

  it('builds intro options', () => {
    expect(parseIntroParams(q('intro=0'))).toEqual({ enabled: false, options: {} });
    expect(parseIntroParams(q('introDuration=8&introSpeed=-30&introZoom=1.5'))).toEqual({
      enabled: undefined,
      options: { duration: 8, speed: -30, zoomFrom: 1.5 },
    });
    // Out of range values are dropped.
    expect(parseIntroParams(q('introDuration=0&introZoom=0.5')).options).toEqual({});
  });

  it('builds cloud options', () => {
    const p = parseCloudParams(q('clouds=1&cloudCoverage=0.7&cloudOpacity=0.6&cloudSpeed=2&cloudHeight=12000&cloudTexture=/data/clouds.jpg'));
    expect(p.visible).toBe(true);
    expect(p.options).toEqual({ coverage: 0.7, opacity: 0.6, speed: 2, height: 12000, textureUrl: '/data/clouds.jpg' });
    expect(parseCloudParams(q('clouds=0&cloudCoverage=3')).options).toEqual({});
    expect(parseCloudParams(q('clouds=0')).visible).toBe(false);
    // Only http(s), relative and data:image URLs are accepted.
    expect(parseCloudParams(q('cloudTexture=javascript:alert(1)')).options.textureUrl).toBeUndefined();
    expect(parseCloudParams(q('cloudTexture=https://example.com/c.png')).options.textureUrl).toBe('https://example.com/c.png');
  });

  it('detects startup data that flies the camera', () => {
    expect(hasStartupFlight(q('demo'))).toBe(true);
    expect(hasStartupFlight(q('tileset=https://x/tileset.json'))).toBe(true);
    expect(hasStartupFlight(q('imagery=osm&clouds=1'))).toBe(false);
  });
});

