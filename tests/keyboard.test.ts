/**
 * Camera keys are read from the viewer, not from `window`: two viewers on a
 * page stay independent and the host's own shortcuts are left alone.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { DEG2RAD } from '../src/core/math';
import { orientationFromHeadingPitch } from '../src/viewer/cameraMath';
import { GlobeCameraController } from '../src/viewer/GlobeCameraController';

const E = Ellipsoid.WGS84;

type Handler = (e: unknown) => void;

/** Minimal element: records listeners so the test can fire events at them. */
function fakeElement() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    style: {} as Record<string, string>,
    clientWidth: 1600,
    clientHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    addEventListener: (type: string, fn: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Handler) => void handlers.get(type)?.delete(fn),
    contains: (node: unknown) => node === 'inside',
    count: (type: string) => handlers.get(type)?.size ?? 0,
    fire: (type: string, event: Record<string, unknown>) => handlers.get(type)?.forEach((fn) => fn(event)),
  };
}

function setup(withKeyboardTarget: boolean) {
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 1e8);
  E.cartographicToCartesian(110 * DEG2RAD, 30 * DEG2RAD, 5000, camera.position);
  orientationFromHeadingPitch(E, camera.position, 0, -45 * DEG2RAD, camera.quaternion);
  const canvas = fakeElement();
  const container = fakeElement();
  const controller = new GlobeCameraController({
    camera,
    ellipsoid: E,
    domElement: canvas as unknown as HTMLElement,
    keyboardTarget: withKeyboardTarget ? (container as unknown as HTMLElement) : undefined,
    pick: () => null,
    groundHeight: () => 0,
  });
  let prevented = 0;
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: null, preventDefault: () => prevented++, ...extra });
  return { camera, canvas, container, controller, key, prevented: () => prevented };
}

describe('camera keyboard', () => {
  it('listens on the keyboard target and never on window', () => {
    // No `window` exists in this environment: touching it would throw.
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const { canvas, container, controller } = setup(true);
    expect(container.count('keydown')).toBe(1);
    expect(container.count('keyup')).toBe(1);
    expect(container.count('focusout')).toBe(1);
    expect(canvas.count('keydown')).toBe(0);
    controller.dispose();
    expect(container.count('keydown') + container.count('keyup') + container.count('focusout')).toBe(0);
  });

  it('falls back to the canvas without a keyboard target', () => {
    const { canvas } = setup(false);
    expect(canvas.count('keydown')).toBe(1);
  });

  it('moves while a key is held and stops on key-up', () => {
    const { camera, container, controller, key, prevented } = setup(true);
    const start = camera.position.clone();
    container.fire('keydown', key('w'));
    expect(prevented()).toBe(1);
    for (let i = 0; i < 30; i++) controller.update(1 / 60);
    const moved = camera.position.distanceTo(start);
    expect(moved).toBeGreaterThan(100);

    container.fire('keyup', key('w'));
    const held = camera.position.clone();
    for (let i = 0; i < 30; i++) controller.update(1 / 60);
    expect(camera.position.distanceTo(held)).toBeLessThan(1e-6);
  });

  it('releases held keys when the focus leaves the viewer, not when it moves inside it', () => {
    const { camera, container, controller, key } = setup(true);
    const at = new Vector3();
    container.fire('keydown', key('d'));
    container.fire('focusout', { relatedTarget: 'inside' });
    at.copy(camera.position);
    controller.update(1 / 60);
    expect(camera.position.distanceTo(at)).toBeGreaterThan(0);

    container.fire('focusout', { relatedTarget: null });
    at.copy(camera.position);
    for (let i = 0; i < 10; i++) controller.update(1 / 60);
    expect(camera.position.distanceTo(at)).toBeLessThan(1e-6);
  });

  it('ignores keys typed into a form field, keys with modifiers and a disabled keyboard', () => {
    const { camera, container, controller, key, prevented } = setup(true);
    const start = camera.position.clone();
    container.fire('keydown', key('w', { target: { tagName: 'INPUT' } }));
    controller.update(1 / 60);
    expect(camera.position.distanceTo(start)).toBe(0);

    // Ctrl+R and the like stay with the browser (not prevented).
    container.fire('keydown', key('r', { ctrlKey: true }));
    expect(prevented()).toBe(0);
    container.fire('keyup', key('r'));

    controller.enableKeyboard = false;
    container.fire('keydown', key('w'));
    controller.update(1 / 60);
    expect(camera.position.distanceTo(start)).toBe(0);
  });
});
