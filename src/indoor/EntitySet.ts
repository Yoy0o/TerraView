/**
 * Query result of `IndoorManager.query` (ThingJS `Selector`): an array of
 * entities with batch operations and chained queries.
 */
import type { ObjectEffects } from '../post/postMath';
import { selectorPredicate, type BimEntity, type EntitySelector, type EntityStyle } from './BimEntity';

/**
 * Entities matched by a selector. It is a real array (`length`, index
 * access, `forEach`, `map`...); `map` / `filter` and friends return plain
 * arrays, `query` and `where` return entity sets.
 */
export class EntitySet extends Array<BimEntity> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** Builds a set without duplicates, keeping the first occurrence's order. */
  static create(items: Iterable<BimEntity> = []): EntitySet {
    const set = new EntitySet();
    const seen = new Set<BimEntity>();
    for (const e of items) {
      if (seen.has(e)) continue;
      seen.add(e);
      set.push(e);
    }
    return set;
  }

  /** Descendants of the entities in this set that match a selector (chained query: `query('.floor').query('.room')`). */
  query(selector: EntitySelector): EntitySet {
    const test = selectorPredicate(selector);
    const out: BimEntity[] = [];
    for (const root of this) for (const c of root.children) c.traverse((e) => test(e) && out.push(e));
    return EntitySet.create(out);
  }

  /** The entities of this set that match a selector. */
  where(selector: EntitySelector): EntitySet {
    const test = selectorPredicate(selector);
    return EntitySet.create(Array.prototype.filter.call(this, (e: BimEntity) => test(e)) as BimEntity[]);
  }

  /** Applies a style override to every entity (see `BimEntity.setStyle`). */
  setStyle(style: EntityStyle): this {
    for (const e of this) e.setStyle(style);
    return this;
  }

  /** Merges effects into every entity's (outline, glow; see `BimEntity.setEffects`). */
  setEffects(effects: ObjectEffects): this {
    for (const e of this) e.setEffects(effects);
    return this;
  }

  /** True when every entity is visible (its own flag, not its ancestors'); setting it shows or hides all. */
  get visible(): boolean {
    return this.every((e) => e.visible);
  }

  set visible(v: boolean) {
    for (const e of this) e.visible = v;
  }

  /** First entity or null. */
  get first(): BimEntity | null {
    return this[0] ?? null;
  }
}
