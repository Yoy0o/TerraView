/**
 * Managed BIM entities (building, floor, room, thing, element): the entity
 * tree, per-entity style overrides, tags, and selector matching.
 */
import { Box3, Color, Group, Mesh, Sphere, Vector3, type Material, type Object3D } from 'three';
import type { LabelDef, Vec2, ViewpointDef } from './schema';
import { compileSelector, type Selectable } from './selector';

export type EntityType = 'building' | 'floor' | 'room' | 'thing' | 'element';

/** Visual overrides (ThingJS `object.style`). */
export interface EntityStyle {
  /** Tint color (CSS), null to restore. */
  color?: string | null;
  /** 0..1, null to restore. */
  opacity?: number | null;
  /** Glow used for selection / hover highlight. */
  emissive?: string | null;
}

/**
 * Unstyled look of a mesh material or a batched instance: what styles
 * override and what restoring a style brings back.
 */
export interface BaseLook {
  color: Color | null;
  emissive: Color | null;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/** Look after applying a style and the level opacity (same fields; colors are not shared with the base). */
export type ResolvedLook = BaseLook;

/**
 * The look of a material or instance under a style and level opacity:
 * style color / emissive replace the base ones, opacity is the style (or
 * base) opacity times the level factor. Level-faded content (factor < 1) is
 * transparent and stops writing depth so it never hides what is behind it.
 */
export function resolveLook(base: BaseLook, style: EntityStyle, levelOpacity: number): ResolvedLook {
  const faded = levelOpacity < 1;
  const styledOpacity = style.opacity !== undefined && style.opacity !== null;
  return {
    color: style.color ? new Color(style.color) : base.color,
    emissive: style.emissive ? new Color(style.emissive) : base.emissive,
    opacity: (styledOpacity ? style.opacity! : base.opacity) * levelOpacity,
    transparent: faded || (styledOpacity ? style.opacity! < 1 : base.transparent),
    depthWrite: faded ? false : base.depthWrite,
  };
}

/**
 * One instance of an entity in an instanced batch (see `InstanceBatch.ts`):
 * the entity drives its look, visibility and transform through this.
 */
export interface EntityInstance {
  /** Unstyled look (from the source material and the document color). */
  readonly base: BaseLook;
  /** Applies a resolved look (moves the instance to the batch of its render state when that changes). */
  setLook(look: ResolvedLook): void;
  /** Shows or hides the instance (hidden instances leave their batch). */
  setActive(active: boolean): void;
  /** Re-reads the entity's local transform (after the entity group moved). */
  updateMatrix(): void;
  /** Expands a world (ECEF) box by the instance's bounds. */
  expandWorldBox(box: Box3): void;
  /** Expands a box in the entity's own frame by the instance's bounds (contribution culling). */
  expandLocalBox(box: Box3): void;
  /** Leaves the batch for good. */
  dispose(): void;
}

type StylableMaterial = Material & { color?: Color; emissive?: Color; opacity: number; transparent: boolean; depthWrite: boolean };

/**
 * Tag of structural elements (walls, slabs, columns): drawn, but not
 * interactive inside a floor or room (they would get in the way of what is in it).
 */
export const STRUCTURE_TAG = 'structure';

const _box = new Box3();

/**
 * A managed element of a building: building, floor, room, thing (equipment)
 * or structural element. Owns a three.js group in building-local space; the
 * building's root carries the geographic placement (ENU frame at the anchor).
 */
export class BimEntity implements Selectable {
  readonly children: BimEntity[] = [];
  /** Free-form tags (document `tags` plus defaults such as `structure`), matched by `tags:or(...)` selectors. */
  readonly tags = new Set<string>();
  /** Preset camera view for this level (document `viewpoint`). */
  viewpoint: ViewpointDef | null = null;
  /** Rooms: boundary in floor-local meters (used to tell what stands inside). */
  outline: Vec2[] | null = null;
  parent: BimEntity | null = null;
  /** Local-space content (child of the parent's group). */
  readonly group = new Group();
  /** Meshes that get style overrides (built per entity so overrides stay local). */
  readonly meshes: Mesh[] = [];
  /**
   * Instances in shared instanced batches (devices of the same model and
   * style, M3.6); styled, shown and bounded like `meshes`. Add them with
   * `addInstance`.
   */
  readonly instances: EntityInstance[] = [];
  /** Label anchor in this entity's local space (top of the content by default). */
  readonly labelAnchor = new Vector3();
  label: LabelDef | null;
  private styled = new Map<Material, BaseLook>();
  private _style: EntityStyle = {};
  /** Opacity factor of level effects (sibling fading), kept apart from user styles. */
  private _levelOpacity = 1;
  /** Hidden by contribution culling, kept apart from `visible`. */
  private _culled = false;
  /**
   * @internal Set on the root entity (the building) by its owner: called when this entity or
   * one below it changed how it looks (`geometry` false: style, level opacity) or what it
   * covers (`geometry` true: shown, hidden, moved), so the viewer draws at the full frame
   * rate and refreshes picking. Not called for `culled`, which the viewer sets itself.
   */
  onChange: ((geometry: boolean) => void) | null = null;

  constructor(
    readonly id: string,
    readonly type: EntityType,
    public name: string,
    public category: string,
    public properties: Record<string, unknown>,
    label?: LabelDef,
    tags?: Iterable<string>,
  ) {
    this.label = label ?? null;
    if (tags) for (const t of tags) this.tags.add(t);
    this.group.name = `${type}:${id}`;
    this.group.userData.entity = this;
  }

  add(child: BimEntity): void {
    child.parent = this;
    this.children.push(child);
    this.group.add(child.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Shows or hides the entity (set this rather than `group.visible`: batched instances follow it). */
  set visible(v: boolean) {
    const changed = v !== this.group.visible;
    this.group.visible = v;
    for (const i of this.instances) i.setActive(v && !this._culled);
    if (changed) this.changed(true);
  }

  /**
   * Too small on screen to be drawn (contribution culling, set by
   * `indoor.culling`): hides this entity's own meshes and batched instances
   * without touching `visible`, so user and level visibility stay as they
   * were. Child entities are not affected.
   */
  get culled(): boolean {
    return this._culled;
  }

  set culled(v: boolean) {
    this._culled = v;
    for (const mesh of this.meshes) mesh.visible = !v;
    for (const i of this.instances) i.setActive(this.group.visible && !v);
  }

  /**
   * Registers an instance of this entity in a batch and gives it the
   * current style, level opacity and visibility. Batched entities must be
   * direct children of the entity that owns the batch (things of a floor).
   */
  addInstance(instance: EntityInstance): void {
    this.instances.push(instance);
    instance.updateMatrix();
    instance.setLook(resolveLook(instance.base, this._style, this._levelOpacity));
    instance.setActive(this.group.visible && !this._culled);
  }

  /**
   * Call after changing the transform of `group` (position, rotation,
   * scale): batched instances do not follow the scene graph on their own.
   */
  refreshTransform(): void {
    this.group.updateMatrix();
    for (const i of this.instances) i.updateMatrix();
    this.changed(true);
  }

  /** Tells the owner of the entity tree (see `onChange`) that something changed. */
  private changed(geometry: boolean): void {
    let root: BimEntity = this;
    while (root.parent) root = root.parent;
    root.onChange?.(geometry);
  }

  /** Visible including all ancestors (three.js raycasting ignores `visible`). */
  get effectivelyVisible(): boolean {
    let o: Object3D | null = this.group;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  /** Root-to-this chain, excluding this entity. */
  ancestors(): BimEntity[] {
    const out: BimEntity[] = [];
    for (let p = this.parent; p; p = p.parent) out.unshift(p);
    return out;
  }

  isDescendantOf(other: BimEntity): boolean {
    for (let p = this.parent; p; p = p.parent) if (p === other) return true;
    return false;
  }

  /** Depth-first walk over this entity and its descendants. */
  traverse(cb: (e: BimEntity) => void): void {
    cb(this);
    for (const c of this.children) c.traverse(cb);
  }

  /** Closest ancestor-or-self of a type. */
  closest(type: EntityType): BimEntity | null {
    for (let e: BimEntity | null = this; e; e = e.parent) if (e.type === type) return e;
    return null;
  }

  get style(): Readonly<EntityStyle> {
    return this._style;
  }

  /** Applies visual overrides to this entity's own meshes (ThingJS `obj.style.color = ...`). */
  setStyle(style: EntityStyle): void {
    this._style = { ...this._style, ...style };
    this.applyStyles();
    this.changed(false);
  }

  /**
   * Opacity factor applied by level effects (e.g. 0.25 for the siblings of the
   * entered room), multiplied with the style opacity; 1 restores. Faded
   * meshes stop writing depth so they never hide what is behind them.
   */
  get levelOpacity(): number {
    return this._levelOpacity;
  }

  set levelOpacity(v: number) {
    if (v === this._levelOpacity) return;
    this._levelOpacity = v;
    this.applyStyles();
    this.changed(false);
  }

  /** Re-applies the current style and level opacity (after meshes were added, e.g. a model loaded). */
  refreshStyle(): void {
    if (this._levelOpacity !== 1 || Object.keys(this._style).length > 0) this.applyStyles();
  }

  private applyStyles(): void {
    for (const mesh of this.meshes) {
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as StylableMaterial[];
      for (const m of materials) this.applyStyle(m);
    }
    for (const i of this.instances) i.setLook(resolveLook(i.base, this._style, this._levelOpacity));
  }

  private applyStyle(m: StylableMaterial): void {
    let s = this.styled.get(m);
    if (!s) {
      s = { color: m.color?.clone() ?? null, emissive: m.emissive?.clone() ?? null, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
      this.styled.set(m, s);
    }
    const look = resolveLook(s, this._style, this._levelOpacity);
    if (m.color && look.color) m.color.copy(look.color);
    if (m.emissive && look.emissive) m.emissive.copy(look.emissive);
    m.opacity = look.opacity;
    if (m.transparent !== look.transparent || m.depthWrite !== look.depthWrite) {
      m.transparent = look.transparent;
      m.depthWrite = look.depthWrite;
      m.needsUpdate = true;
    }
  }

  /** World (ECEF) bounding sphere of the content (meshes and batched instances), or null when empty. */
  worldBounds(out = new Sphere()): Sphere | null {
    this.group.updateWorldMatrix(true, true);
    _box.makeEmpty().expandByObject(this.group, true);
    for (const i of this.instances) i.expandWorldBox(_box);
    if (_box.isEmpty()) return null;
    return _box.getBoundingSphere(out);
  }

  /** World (ECEF) position of the label anchor. */
  labelPosition(out = new Vector3()): Vector3 {
    this.group.updateWorldMatrix(true, false);
    return out.copy(this.labelAnchor).applyMatrix4(this.group.matrixWorld);
  }

  /**
   * Frees the meshes under this entity's group and leaves its batches.
   * Pooled batch meshes (`userData.pooled`) are skipped: their owner releases them.
   */
  dispose(): void {
    for (const i of this.instances) i.dispose();
    this.instances.length = 0;
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || mesh.userData.pooled) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of materials) m.dispose();
    });
    this.styled.clear();
  }
}

/**
 * Entity selector: an expression string (see `selector.ts`, e.g.
 * `.room && [category=office]`, `tags:or(alarm, camera)`, `#F3-R10`), a
 * RegExp tested against the name, or a predicate.
 */
export type EntitySelector = string | RegExp | ((e: BimEntity) => boolean);

/** Whether an entity matches a selector. String selectors are compiled once and cached. */
export function matchesSelector(e: BimEntity, selector: EntitySelector): boolean {
  if (typeof selector === 'function') return selector(e);
  if (selector instanceof RegExp) return selector.test(e.name);
  return compileSelector(selector)(e);
}

/** Selector as a predicate (compiles string selectors up front). */
export function selectorPredicate(selector: EntitySelector): (e: BimEntity) => boolean {
  if (typeof selector === 'function') return selector;
  if (selector instanceof RegExp) return (e) => selector.test(e.name);
  return compileSelector(selector);
}

/** Closest ancestor-or-self matching a selector (event bubbling). */
export function closestMatching(e: BimEntity | null, selector: EntitySelector): BimEntity | null {
  const test = selectorPredicate(selector);
  for (let x = e; x; x = x.parent) if (test(x)) return x;
  return null;
}
