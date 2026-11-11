/**
 * Contribution culling (M2.3): devices and non-structural components whose
 * bounding sphere covers less than a fraction of the viewport are not drawn.
 * Off by default; turned on and tuned through `indoor.culling.configure()`
 * (or the viewer option `contributionCulling`). Culling never touches
 * `entity.visible` (user and level visibility): it sets `entity.culled`,
 * which hides the entity's own meshes and batched instances on top of it.
 * Walls, slabs, columns (tag `structure`), floors, rooms and buildings never
 * take part. See docs/agents/indoor-bim.md §5.3.
 *
 * `sphereScreenExtents` is ported from the t3d.js example
 * `examples/renderer_culling_contribution.html` (https://github.com/uinosoft/t3d.js,
 * commit 1f2c3c8, BSD-3-Clause, Copyright (c) 2021-present, uino; see
 * THIRD_PARTY_NOTICES.md). Changes: three.js view space (camera looks down -Z),
 * spheres behind the camera count as full screen, plain numbers in and out.
 */
import { Box3, Matrix4, Sphere, Vector3, type Camera, type Mesh } from 'three';
import { selectorPredicate, STRUCTURE_TAG, type BimEntity, type EntitySelector } from './BimEntity';

/** Projected extents of a sphere in normalized device coordinates (-1..1 spans the viewport). */
export interface ScreenExtents {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/**
 * Exact screen extents (NDC) of a sphere seen by a perspective camera: the
 * tangent lines from the eye, projected separately on the horizontal and
 * vertical planes. `x`, `y`, `z` is the sphere center in view space (meters,
 * camera looking down -Z); `p0`, `p5` are elements 0 and 5 of the projection
 * matrix. A sphere around or behind the eye returns the whole viewport.
 */
export function sphereScreenExtents(x: number, y: number, z: number, radius: number, p0: number, p5: number, out: ScreenExtents = { left: 0, bottom: 0, right: 0, top: 0 }): ScreenExtents {
  const d = -z;
  if (d <= radius) return full(out);
  const r2 = radius * radius;
  // d > radius keeps both discriminants positive and the denominators non-zero.
  const h = Math.sqrt(x * x + d * d - r2);
  out.left = ((x * h - d * radius) * p0) / (d * h + x * radius);
  out.right = ((x * h + d * radius) * p0) / (d * h - x * radius);
  const v = Math.sqrt(y * y + d * d - r2);
  out.bottom = ((y * v - d * radius) * p5) / (d * v + y * radius);
  out.top = ((y * v + d * radius) * p5) / (d * v - y * radius);
  return out;
}

function full(out: ScreenExtents): ScreenExtents {
  out.left = -1;
  out.bottom = -1;
  out.right = 1;
  out.top = 1;
  return out;
}

/** Share of the viewport covered by extents along their larger side (1 = the full width or height). */
export function screenFraction(e: ScreenExtents): number {
  return Math.max(e.right - e.left, e.top - e.bottom) / 2;
}

/**
 * Next culled state with hysteresis: cull below `threshold`, show again only
 * above `threshold × (1 + hysteresis)`, so sizes near the threshold do not
 * flicker. A threshold of 0 or less never culls.
 */
export function nextCulled(culled: boolean, fraction: number, threshold: number, hysteresis: number): boolean {
  if (!(threshold > 0)) return false;
  return fraction < (culled ? threshold * (1 + Math.max(0, hysteresis)) : threshold);
}

/** Things (devices) and non-structural elements (doors, windows, pipes…) can be culled; structure, floors, rooms and buildings never. */
export function isCullable(e: BimEntity): boolean {
  return (e.type === 'thing' || e.type === 'element') && !e.tags.has(STRUCTURE_TAG);
}

/** A threshold for the entities matching a selector (first matching rule wins). */
export interface CullingRule {
  selector: EntitySelector;
  /** Viewport fraction for these entities; 0 never culls them. */
  threshold: number;
}

export interface ContributionCullingOptions {
  /** Default false: nothing is culled until enabled. */
  enabled?: boolean;
  /**
   * Smallest share of the viewport (along its larger side, 0..1) an entity
   * must cover to be drawn. Default 0.005 (0.5 %, about 5 px on a 1000 px view).
   */
  threshold?: number;
  /** Culled entities come back above `threshold × (1 + hysteresis)`. Default 0.1. */
  hysteresis?: number;
  /** Re-evaluate every this many frames (≥ 1). Default 5. */
  interval?: number;
  /**
   * Narrows which entities take part (on top of `isCullable`: structure is
   * never culled), e.g. `'.thing'` or `'.thing && ![category=camera]'`. Null = every cullable entity.
   */
  selector?: EntitySelector | null;
  /** Per-category thresholds, e.g. `[{ selector: '[category=sensor]', threshold: 0.01 }]`. */
  rules?: CullingRule[];
}

export type ResolvedCullingOptions = Required<ContributionCullingOptions>;

export const DEFAULT_CULLING: Readonly<ResolvedCullingOptions> = Object.freeze({
  enabled: false,
  threshold: 0.005,
  hysteresis: 0.1,
  interval: 5,
  selector: null,
  rules: [],
});

/** Bounding sphere in the entity's own frame, keyed by how many meshes / instances it covered. */
interface LocalBounds {
  center: Vector3;
  /** Negative when the entity has no content. */
  radius: number;
  parts: number;
}

const _box = new Box3();
const _part = new Box3();
const _inv = new Matrix4();
const _m = new Matrix4();
const _sphere = new Sphere();
const _view = new Vector3();
const _extents: ScreenExtents = { left: 0, bottom: 0, right: 0, top: 0 };

/**
 * Culls entities that are too small on screen, every `interval` frames.
 * Owned by `IndoorManager` (`indoor.culling`).
 */
export class ContributionCuller {
  /**
   * Last pass: `candidates` evaluated (shown, cullable, matching the
   * selector) and how many of them are culled. Entities under hidden floors
   * keep their state but are not counted.
   */
  readonly stats = { candidates: 0, culled: 0 };
  private opts: ResolvedCullingOptions = { ...DEFAULT_CULLING, rules: [] };
  private test: ((e: BimEntity) => boolean) | null = null;
  private ruleTests: { test: (e: BimEntity) => boolean; threshold: number }[] = [];
  private readonly culled = new Set<BimEntity>();
  private readonly bounds = new WeakMap<BimEntity, LocalBounds>();
  private frame = 0;
  private dirty = true;

  constructor(
    private readonly camera: Camera,
    /** Roots to walk (the buildings). */
    private readonly roots: () => Iterable<BimEntity>,
    /** Entities never culled right now (the entered level, the selection). */
    private readonly exempt: (e: BimEntity) => boolean = () => false,
  ) {}

  get options(): Readonly<ResolvedCullingOptions> {
    return this.opts;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  set enabled(v: boolean) {
    this.configure({ enabled: v });
  }

  /**
   * Changes some options (the others keep their values). Disabling shows
   * everything again at once; other changes apply on the next frame.
   * Throws on a malformed selector, leaving the options unchanged.
   */
  configure(options: ContributionCullingOptions): void {
    const next: ResolvedCullingOptions = { ...this.opts };
    for (const key of Object.keys(options) as (keyof ContributionCullingOptions)[]) {
      if (options[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = options[key];
    }
    next.interval = Math.max(1, Math.round(next.interval));
    const test = next.selector === null ? null : selectorPredicate(next.selector);
    const ruleTests = next.rules.map((r) => ({ test: selectorPredicate(r.selector), threshold: r.threshold }));
    this.opts = { ...next, rules: [...next.rules] };
    this.test = test;
    this.ruleTests = ruleTests;
    this.dirty = true;
    if (!next.enabled) this.restoreAll();
  }

  /** Evaluates on the next `update` instead of waiting for the interval (content moved, level changed). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Shows every culled entity again; returns true when there was one. */
  restoreAll(): boolean {
    const any = this.culled.size > 0;
    for (const e of this.culled) e.culled = false;
    this.culled.clear();
    this.stats.culled = 0;
    return any;
  }

  /** Drops the entities of a removed building (the stats follow on the next pass). */
  forget(root: BimEntity): void {
    for (const e of this.culled) if (e === root || e.isDescendantOf(root)) this.culled.delete(e);
    this.dirty = true;
  }

  /**
   * Runs a pass when due (camera matrices must be current); returns true
   * when an entity was culled or restored (the pick buffer is then stale).
   */
  update(): boolean {
    if (!this.opts.enabled) return false;
    this.frame++;
    if (!this.dirty && this.frame % this.opts.interval !== 0) return false;
    this.dirty = false;
    let changed = false;
    let candidates = 0;
    let culledShown = 0;
    const p = this.camera.projectionMatrix.elements;
    const view = this.camera.matrixWorldInverse;
    const visit = (e: BimEntity): void => {
      // Hidden subtrees (other floors, a hidden device) keep their state until shown.
      if (!e.visible) return;
      if (isCullable(e) && (!this.test || this.test(e))) {
        candidates++;
        let next = false;
        if (!this.exempt(e)) {
          const s = this.worldSphere(e);
          if (s) {
            _view.copy(s.center).applyMatrix4(view);
            const f = screenFraction(sphereScreenExtents(_view.x, _view.y, _view.z, s.radius, p[0], p[5], _extents));
            next = nextCulled(e.culled, f, this.thresholdOf(e), this.opts.hysteresis);
          }
        }
        if (next !== e.culled) {
          e.culled = next;
          if (next) this.culled.add(e);
          else this.culled.delete(e);
          changed = true;
        }
        if (next) culledShown++;
      } else if (e.culled) {
        // Left the selection after a configure.
        e.culled = false;
        this.culled.delete(e);
        changed = true;
      }
      for (const c of e.children) visit(c);
    };
    for (const root of this.roots()) visit(root);
    this.stats.candidates = candidates;
    this.stats.culled = culledShown;
    return changed;
  }

  private thresholdOf(e: BimEntity): number {
    for (const r of this.ruleTests) if (r.test(e)) return r.threshold;
    return this.opts.threshold;
  }

  /** World (ECEF) bounding sphere of the entity's own content, or null when it has none yet. */
  private worldSphere(e: BimEntity): Sphere | null {
    const parts = e.meshes.length + e.instances.length;
    let b = this.bounds.get(e);
    // Models load asynchronously: recompute when the content changed.
    if (!b || b.parts !== parts) {
      b = localBounds(e, parts);
      this.bounds.set(e, b);
      // Meshes that arrived while the entity was culled must follow its state.
      if (e.culled) e.culled = true;
    }
    if (b.radius < 0) return null;
    const m = e.group.matrixWorld;
    _sphere.center.copy(b.center).applyMatrix4(m);
    _sphere.radius = b.radius * m.getMaxScaleOnAxis();
    return _sphere;
  }
}

/** Bounding sphere of an entity's meshes and instances in its group's frame. */
function localBounds(e: BimEntity, parts: number): LocalBounds {
  _box.makeEmpty();
  e.group.updateWorldMatrix(true, false);
  _inv.copy(e.group.matrixWorld).invert();
  for (const mesh of e.meshes as Mesh[]) {
    const g = mesh.geometry;
    if (!g) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    mesh.updateWorldMatrix(true, false);
    _part.copy(g.boundingBox!).applyMatrix4(_m.multiplyMatrices(_inv, mesh.matrixWorld));
    _box.union(_part);
  }
  for (const i of e.instances) i.expandLocalBox(_box);
  if (_box.isEmpty()) return { center: new Vector3(), radius: -1, parts };
  _box.getBoundingSphere(_sphere);
  return { center: _sphere.center.clone(), radius: _sphere.radius, parts };
}
