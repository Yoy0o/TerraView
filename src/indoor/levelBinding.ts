/**
 * Level bindings: content that is not part of the entity tree (a Gaussian splat layer, a
 * 3D Tiles layer, an application's own three.js object) attached to one of its nodes, so
 * that the level the view is in decides when it is shown, and the entity's own geometry
 * can step back while it is.
 *
 * There is one level tree (globe → building → floor → room / thing); reality captures and
 * other layers are content of a node, not levels of their own. The entity stays the
 * semantic side of the pair: selectors, events, labels and navigation keep working on it
 * while the bound content provides the look. See docs/agents/indoor-bim.md §6.5.
 *
 * The rule (`levelShown`) is pure; `LevelBindings` keeps the registry and applies the
 * entity opacity. Nothing here knows about splats or tiles.
 */
import type { BimEntity } from './BimEntity';

/**
 * When bound content is shown, relative to the level the view is in:
 * - `'always'`: whenever the entity exists;
 * - `'entity'`: while the entity is shown (it follows the level controls like the entity's own meshes);
 * - `'inside'`: while the view's level is the entity or below it (the interior of a floor or room);
 * - `'current'`: only while the entity itself is the view's level;
 * - `'outside'`: while the view's level is neither the entity nor below it, and the entity
 *   is shown (the exterior of a building).
 */
export type LevelShow = 'always' | 'entity' | 'inside' | 'current' | 'outside';

/** Names of `LevelShow`, for validating documents. */
export const LEVEL_SHOW_MODES: readonly LevelShow[] = ['always', 'entity', 'inside', 'current', 'outside'];

/** Where the view's level is relative to a bound entity. */
export type LevelRelation = 'at' | 'below' | 'outside';

/** What a `show` predicate decides on. */
export interface LevelShowState {
  /** The bound entity; null for content bound to the globe (no `entity` in the options). */
  entity: BimEntity | null;
  /** Level the view is in (null = the globe). */
  current: BimEntity | null;
  /** `'at'`: the view's level is the entity; `'below'`: a level inside it; `'outside'`: anything else. */
  relation: LevelRelation;
  /** The entity is shown (itself and every ancestor visible). */
  visible: boolean;
}

export interface LevelBindingOptions {
  /**
   * The level node the content belongs to: an entity, or its id (resolved whenever buildings
   * are added, so content can be bound before its building is loaded). Omit, or null, for
   * the globe: the content is then level-aware without belonging to an entity.
   */
  entity?: BimEntity | string | null;
  /**
   * When the content is shown (`LevelShow`), or a predicate for anything else, e.g.
   * `({ current }) => current?.type !== 'room'`. Default: `'outside'` for a building,
   * `'inside'` for floors, rooms and things, `'current'` (only on the globe) without an entity.
   */
  show?: LevelShow | ((state: LevelShowState) => boolean);
  /**
   * Opacity of the entity's own geometry (and everything below it) while the content is
   * shown and ready, 0..1 (default 1: unchanged). Below 1 the geometry steps back for the
   * content; at 0 it is not seen at all but is still picked, outlined and labelled, so a
   * capture can be the look of a level whose rooms and devices stay interactive.
   */
  entityOpacity?: number;
}

interface TreeNode<T> {
  readonly parent: T | null;
}

/** Where `current` is relative to `entity` (null entity = the globe, which contains every level). */
export function levelRelation<T extends TreeNode<T>>(entity: T | null, current: T | null): LevelRelation {
  if (entity === null) return current === null ? 'at' : 'below';
  for (let x = current; x; x = x.parent) if (x === entity) return x === current ? 'at' : 'below';
  return 'outside';
}

/** The default `show` of a binding: the exterior for buildings, the interior below, the globe level without an entity. */
export function defaultLevelShow(entityType: string | null): LevelShow {
  return entityType === null ? 'current' : entityType === 'building' ? 'outside' : 'inside';
}

/** Whether a `LevelShow` mode shows content for a relation and the entity's visibility. */
export function levelShown(show: LevelShow, relation: LevelRelation, visible: boolean): boolean {
  switch (show) {
    case 'always':
      return true;
    case 'entity':
      return visible;
    case 'inside':
      return relation !== 'outside';
    case 'current':
      return relation === 'at';
    case 'outside':
      return relation === 'outside' && visible;
  }
}

/** A binding as the registry reports it. */
export interface LevelBinding {
  readonly content: object;
  readonly options: Readonly<LevelBindingOptions>;
  /** The entity the content is bound to: null for the globe, and while no loaded building has it. */
  readonly entity: BimEntity | null;
  /** The binding names an entity that no loaded building has (the content stays hidden). */
  readonly unresolved: boolean;
  /** Whether the level shows the content now. */
  readonly shown: boolean;
}

/** What bound content tells the registry, and hears from it. */
export interface LevelBindingHooks {
  /**
   * Whether the content is really on screen once shown (loaded, and not hidden by the user):
   * the entity's geometry only steps back (`entityOpacity`) while it is. Default: always.
   */
  showing?: () => boolean;
  /**
   * Called when `shown` or the resolved entity changed, once per change (not for the state
   * `bind()` returns). Layers of the SDK read the binding each frame instead.
   */
  onChange?: (binding: LevelBinding) => void;
}

/** What the registry needs from the level tree. */
export interface LevelTree {
  /** Level the view is in (null = the globe). */
  readonly current: BimEntity | null;
  getById(id: string): BimEntity | null;
  /** Whether an entity belongs to a building that is loaded. */
  contains(entity: BimEntity): boolean;
}

interface Entry extends LevelBinding {
  options: LevelBindingOptions;
  entity: BimEntity | null;
  unresolved: boolean;
  shown: boolean;
  hooks: LevelBindingHooks;
  /** Opacity it currently asks of its entity's subtree (1 = none). */
  asks: number;
}

/**
 * Registry of level bindings (`viewer.indoor.bindings`). Layers register themselves through
 * their `level` option; applications can bind anything else:
 *
 * ```ts
 * viewer.indoor.bindings.bind(mesh, { entity: 'F3', show: 'inside' }, { onChange: (b) => (mesh.visible = b.shown) });
 * ```
 */
export class LevelBindings {
  private readonly entries = new Map<object, Entry>();
  /** Entities whose geometry is currently faded for bound content, with the factor applied. */
  private applied = new Map<BimEntity, number>();
  private resolveNeeded = true;
  private opacityDirty = false;

  constructor(private readonly tree: LevelTree) {}

  /** Binds content to a level (replacing an earlier binding of the same content) and evaluates it at once. */
  bind(content: object, options: LevelBindingOptions, hooks: LevelBindingHooks = {}): LevelBinding {
    const previous = this.entries.get(content);
    const entry: Entry = { content, options: { ...options }, entity: null, unresolved: false, shown: false, hooks, asks: 1 };
    this.entries.set(content, entry);
    if (previous && previous.asks < 1) this.opacityDirty = true;
    this.resolve(entry);
    this.evaluate(entry);
    this.applyOpacity();
    return entry;
  }

  /** Removes the binding of some content (its entity's geometry comes back if it had stepped back). */
  unbind(content: object): void {
    const entry = this.entries.get(content);
    if (!entry) return;
    this.entries.delete(content);
    if (entry.asks < 1) this.opacityDirty = true;
    this.applyOpacity();
  }

  /** The binding of some content, or null. */
  get(content: object): LevelBinding | null {
    return this.entries.get(content) ?? null;
  }

  /** Every binding, in the order they were made. */
  all(): LevelBinding[] {
    return [...this.entries.values()];
  }

  /** The bindings of an entity (not of its descendants). */
  of(entity: BimEntity): LevelBinding[] {
    return this.all().filter((b) => b.entity === entity);
  }

  /** Buildings were added or removed: ids are resolved again at the next `update`. */
  invalidate(): void {
    this.resolveNeeded = true;
  }

  /**
   * Evaluates every binding against the current level (per frame, and after level changes).
   * Returns true when what is shown, or an entity's opacity, changed.
   */
  update(): boolean {
    let changed = false;
    const resolve = this.resolveNeeded;
    this.resolveNeeded = false;
    if (resolve) {
      // Entities of removed buildings are gone with their meshes.
      for (const e of [...this.applied.keys()]) {
        if (!this.tree.contains(e)) {
          this.applied.delete(e);
          this.opacityDirty = true;
        }
      }
    }
    for (const entry of this.entries.values()) {
      const resolved = resolve && this.resolve(entry);
      const switched = this.evaluate(entry);
      if (!resolved && !switched) continue;
      changed = true;
      entry.hooks.onChange?.(entry);
    }
    if (this.applyOpacity()) changed = true;
    return changed;
  }

  /** Looks the entity of a binding up; true when it changed. */
  private resolve(entry: Entry): boolean {
    const target = entry.options.entity ?? null;
    let entity: BimEntity | null = null;
    if (typeof target === 'string') entity = this.tree.getById(target);
    else if (target && this.tree.contains(target)) entity = target;
    const unresolved = target !== null && entity === null;
    if (entity === entry.entity && unresolved === entry.unresolved) return false;
    entry.entity = entity;
    entry.unresolved = unresolved;
    return true;
  }

  /** Applies the rule to one binding; true when `shown` (or what it asks of the entity) changed. */
  private evaluate(entry: Entry): boolean {
    const { entity } = entry;
    let shown = false;
    if (!entry.unresolved) {
      const current = this.tree.current;
      const relation = levelRelation(entity, current);
      const visible = entity ? entity.effectivelyVisible : true;
      const show = entry.options.show ?? defaultLevelShow(entity ? entity.type : null);
      shown = typeof show === 'function' ? show({ entity, current, relation, visible }) : levelShown(show, relation, visible);
    }
    const opacity = entry.options.entityOpacity ?? 1;
    const asks = shown && entity && opacity < 1 && (entry.hooks.showing?.() ?? true) ? Math.max(0, opacity) : 1;
    if (asks !== entry.asks) {
      entry.asks = asks;
      this.opacityDirty = true;
    }
    if (shown === entry.shown) return false;
    entry.shown = shown;
    return true;
  }

  /**
   * Fades the geometry of entities whose bound content is on screen: an entity takes the
   * lowest opacity any binding at or above it asks for. True when something was set.
   */
  private applyOpacity(): boolean {
    if (!this.opacityDirty) return false;
    this.opacityDirty = false;
    const wanted = new Map<BimEntity, number>();
    for (const entry of this.entries.values()) {
      if (entry.asks >= 1 || !entry.entity) continue;
      entry.entity.traverse((e) => wanted.set(e, Math.min(wanted.get(e) ?? 1, entry.asks)));
    }
    let changed = false;
    for (const e of new Set([...this.applied.keys(), ...wanted.keys()])) {
      const value = wanted.get(e) ?? 1;
      if (e.bindingOpacity === value) continue;
      e.bindingOpacity = value;
      changed = true;
    }
    this.applied = wanted;
    return changed;
  }

  /** Drops every binding and gives the entities their geometry back. */
  clear(): void {
    this.entries.clear();
    this.opacityDirty = true;
    this.applyOpacity();
  }
}
