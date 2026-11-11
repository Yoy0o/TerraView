/**
 * M2.2 marker occlusion: proxy slot pool (capacity, recycling), mode rules
 * (important markers only fade), debouncing, and MarkerManager hiding /
 * fading markers from occlusion results (fake DOM, fake occlusion source).
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { MarkerManager, type Marker, type MarkerOptions } from '../src/markers/MarkerManager';
import { effectiveOcclusion, OCCLUSION_CONFIRM_READS, OcclusionState, ProxySlots, proxyRadius, type MarkerOcclusion } from '../src/markers/occlusion';

describe('proxy slots', () => {
  it('hands out at most `capacity` slots and recycles released ones', () => {
    const slots = new ProxySlots(3);
    expect([slots.acquire(), slots.acquire(), slots.acquire()]).toEqual([0, 1, 2]);
    expect(slots.acquire()).toBe(-1);
    expect(slots.size).toBe(3);
    slots.release(1);
    expect(slots.isUsed(1)).toBe(false);
    expect(slots.size).toBe(2);
    expect(slots.acquire()).toBe(1);
    expect(slots.acquire()).toBe(-1);
    // Releasing twice, or out of range, changes nothing.
    slots.release(2);
    slots.release(2);
    slots.release(7);
    slots.release(-1);
    expect(slots.size).toBe(2);
    expect(slots.acquire()).toBe(2);
    expect(slots.acquire()).toBe(-1);
  });
});

describe('occlusion rules', () => {
  it('never hides important markers, only fades them', () => {
    expect(effectiveOcclusion(undefined, true)).toBe('none');
    expect(effectiveOcclusion('none', true)).toBe('none');
    expect(effectiveOcclusion('hide', true)).toBe('hide');
    expect(effectiveOcclusion('hide', false)).toBe('fade');
    expect(effectiveOcclusion('hide', undefined)).toBe('fade');
    expect(effectiveOcclusion('fade', true)).toBe('fade');
  });

  it('switches state only after repeated equal reads', () => {
    const s = new OcclusionState();
    for (let i = 1; i < OCCLUSION_CONFIRM_READS; i++) expect(s.read(true)).toBe(false);
    expect(s.read(true)).toBe(true);
    // A single flicker back does not count.
    expect(s.read(false)).toBe(true);
    expect(s.read(true)).toBe(true);
    for (let i = 1; i < OCCLUSION_CONFIRM_READS; i++) expect(s.read(false)).toBe(true);
    expect(s.read(false)).toBe(false);
    s.read(true);
    s.reset();
    expect(s.occluded).toBe(false);
  });

  it('sizes proxies to a few pixels at any distance', () => {
    // 60° field of view, 1000 px high: one pixel is 2·d·tan(30°)/1000.
    expect(proxyRadius(1000, 60, 1000)).toBeCloseTo((2 * 2 * 1000 * Math.tan(Math.PI / 6)) / 1000, 9);
    expect(proxyRadius(10, 60, 1000, 3)).toBeCloseTo(proxyRadius(1000, 60, 1000, 3) / 100, 9);
  });
});

// ---------------------------------------------------------------------------
// MarkerManager with a minimal DOM

class FakeElement {
  className = '';
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  offsetWidth = 80;
  offsetHeight = 20;
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

let savedDocument: unknown;
beforeAll(() => {
  savedDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { createElement: () => new FakeElement() };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = savedDocument;
});

/** Occlusion source whose results the test sets per slot. */
class FakeOcclusion implements MarkerOcclusion {
  readonly slots: ProxySlots;
  readonly hidden = new Set<number>();
  readonly placed = new Map<number, number>();
  constructor(capacity: number) {
    this.slots = new ProxySlots(capacity);
  }
  acquire(): number {
    return this.slots.acquire();
  }
  release(slot: number): void {
    this.slots.release(slot);
    this.hidden.delete(slot);
  }
  place(slot: number, _x: number, _y: number, _z: number, radius: number): void {
    this.placed.set(slot, radius);
  }
  occluded(slot: number): boolean {
    return this.hidden.has(slot);
  }
}

const E = Ellipsoid.WGS84;
const W = 1200;
const H = 800;

/** Camera 300 m above a ground point, looking down; markers on the ground near it. */
function scene(capacity = 8) {
  const ground = E.cartographicToCartesian((116.39 * Math.PI) / 180, (39.9 * Math.PI) / 180, 50);
  const up = E.geodeticNormal(ground, new Vector3());
  const east = new Vector3(0, 0, 1).cross(up).normalize();
  const camera = new PerspectiveCamera(60, W / H, 1, 1e7);
  camera.position.copy(ground).addScaledVector(up, 300);
  camera.up.set(0, 0, 1);
  camera.lookAt(ground);
  camera.updateMatrixWorld();
  const markers = new MarkerManager(new FakeElement() as unknown as HTMLElement);
  const occlusion = new FakeOcclusion(capacity);
  markers.occlusion = occlusion;
  const at = (eastMeters: number) => ground.clone().addScaledVector(east, eastMeters);
  const add = (options: Partial<MarkerOptions>, eastMeters = 0): Marker =>
    markers.add({ element: new FakeElement() as unknown as HTMLElement, position: at(eastMeters), ...options });
  const frames = (n = OCCLUSION_CONFIRM_READS) => {
    for (let i = 0; i < n; i++) markers.update(camera, W, H);
  };
  return { markers, occlusion, add, frames, camera, at };
}

const display = (m: Marker) => (m.root as unknown as FakeElement).style.display;
const faded = (m: Marker) => (m.root as unknown as FakeElement).classList.contains('tv-occluded');

describe('marker occlusion', () => {
  it('hides occluded markers with occlusion "hide" and shows them again', () => {
    const { markers, occlusion, add, frames } = scene();
    const m = add({ occlusion: 'hide', declutter: true });
    frames();
    expect(m.shown).toBe(true);
    expect(m.proxy).toBeGreaterThanOrEqual(0);
    expect(occlusion.placed.get(m.proxy)).toBeGreaterThan(0);
    occlusion.hidden.add(m.proxy);
    frames();
    expect(m.occluded).toBe(true);
    expect(m.shown).toBe(false);
    expect(display(m)).toBe('none');
    expect(markers.stats.occluded).toBe(1);
    occlusion.hidden.clear();
    frames();
    expect(m.shown).toBe(true);
    expect(markers.stats.occluded).toBe(0);
  });

  it('fades occluded markers with occlusion "fade" but keeps them shown', () => {
    const { occlusion, add, frames } = scene();
    const m = add({ occlusion: 'fade', declutter: true });
    frames();
    occlusion.hidden.add(m.proxy);
    frames();
    expect(m.shown).toBe(true);
    expect(faded(m)).toBe(true);
    occlusion.hidden.clear();
    frames();
    expect(faded(m)).toBe(false);
  });

  it('never hides important (not decluttered) markers such as alarm cards', () => {
    const { occlusion, add, frames } = scene();
    const alarm = add({ occlusion: 'hide' }); // declutter unset: an obstacle / card
    frames();
    occlusion.hidden.add(alarm.proxy);
    frames(4);
    expect(alarm.occluded).toBe(true);
    expect(alarm.shown).toBe(true);
    expect(display(alarm)).not.toBe('none');
    expect(faded(alarm)).toBe(true);
  });

  it('asks for no proxy without an occlusion mode, and none at all without a source', () => {
    const { markers, occlusion, add, frames } = scene();
    const plain = add({});
    frames();
    expect(plain.proxy).toBe(-1);
    expect(occlusion.slots.size).toBe(0);
    markers.occlusion = null;
    const m = add({ occlusion: 'hide', declutter: true }, 80);
    frames();
    expect(m.proxy).toBe(-1);
    expect(m.shown).toBe(true);
  });

  it('gives proxies back when markers leave the screen or are removed, and treats markers without a slot as visible', () => {
    const { occlusion, add, frames } = scene(2);
    // 100 m apart at 300 m: about 230 px, clear of each other (no decluttering).
    const a = add({ occlusion: 'hide', declutter: true }, -100);
    const b = add({ occlusion: 'hide', declutter: true }, 0);
    const c = add({ occlusion: 'hide', declutter: true }, 100);
    frames();
    // Pool of 2: the third marker has no proxy and stays visible.
    expect([a.proxy, b.proxy, c.proxy].filter((p) => p >= 0)).toHaveLength(2);
    const without = [a, b, c].find((m) => m.proxy < 0)!;
    for (const m of [a, b, c]) if (m.proxy >= 0) occlusion.hidden.add(m.proxy);
    frames();
    expect(without.shown).toBe(true);
    // Hide one marker by its own visibility: its slot goes back to the pool and the third picks it up.
    const first = [a, b, c].find((m) => m.proxy >= 0)!;
    first.options.visible = false;
    frames(1);
    expect(first.proxy).toBe(-1);
    expect(first.occluded).toBe(false);
    frames(1);
    expect(without.proxy).toBeGreaterThanOrEqual(0);
    expect(occlusion.slots.size).toBe(2);
    // Removing a marker releases its slot.
    without.remove();
    expect(occlusion.slots.size).toBe(1);
  });
});
