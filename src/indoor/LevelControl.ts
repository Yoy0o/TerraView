/**
 * Level control strategies (ThingJS `LevelControl`): what entering a
 * building, floor, room or device level does — visibility and fading,
 * which entity a pick resolves to, and how the camera frames the level.
 * `IndoorManager` picks a control per level by selector and priority; the
 * built-in ones below can be replaced per tag
 * (`indoor.registerLevelControl(control, tag)`). See docs/agents/indoor-bim.md §6.
 */
import { Sphere, type PerspectiveCamera } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';
import { STRUCTURE_TAG, type BimEntity, type EntitySelector } from './BimEntity';
import { Building } from './Building';
import type { IndoorManager } from './IndoorManager';
import { nearestDiagonalView, type Framing, type LevelView } from './levelView';
import { pointInPolygon } from './schema';

/** What a level control gets to work with. */
export interface LevelContext {
  /** The level this control handles: being entered, being left, or current. */
  readonly object: BimEntity;
  /** Level before the transition started (null = the globe). */
  readonly origin: BimEntity | null;
  /** Final level of the transition (null = the globe). */
  readonly target: BimEntity | null;
  readonly indoor: IndoorManager;
  /** The scene camera (read it; move it only through `viewFor`). */
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
}

/**
 * A level strategy. Entering a level runs `setEffect`, leaving it runs
 * `resetEffect`; going back up re-enters the parent level, so effects should
 * set absolute states (idempotent) rather than toggle.
 */
export interface LevelControl {
  /** For debugging and docs. */
  readonly name?: string;
  /** Which levels use this control, e.g. '.room' or 'tags:or(device, door)'. */
  condition: EntitySelector;
  /** Among matching controls the highest wins (default 0); ties go to the one registered last. */
  priority?: number;
  /** Entering: visibility, fading, highlights. May be async (awaited before flying). */
  setEffect(ctx: LevelContext): void | Promise<void>;
  /** Leaving: undo `setEffect`. */
  resetEffect(ctx: LevelContext): void | Promise<void>;
  /**
   * Maps a picked entity to the unit that hover, click and double click act
   * on while this level is current (null = not interactive).
   */
  filterObject(hit: BimEntity, ctx: LevelContext): BimEntity | null;
  /** Camera view for the level (null = do not fly). */
  viewFor(entity: BimEntity, ctx: LevelContext): LevelView | null;
  /** Adjusts camera parameters while the level is entered; returns how to restore them. */
  configureCamera?(ctx: LevelContext): (() => void) | void;
}

/** Floors spread apart by this many meters per storey when `indoor.expandFloors` is on. */
export const FLOOR_EXPAND_GAP = 7;
/** Opacity of the other rooms and devices while a room or device is entered (ThingJS: 25 %). */
export const SIBLING_OPACITY = 0.25;

/** Default framing per level type (pitch in degrees, distance in bounding radii at 60° field of view). */
export const LEVEL_FRAMING: Record<'building' | 'floor' | 'room' | 'thing' | 'element', Framing> = {
  building: { pitch: -35, radii: 2.8, minRadius: 30 },
  floor: { pitch: -55, radii: 2.1, minRadius: 15 },
  room: { pitch: -50, radii: 3, minRadius: 7 },
  thing: { pitch: -35, radii: 7, minRadius: 3 },
  element: { pitch: -40, radii: 5, minRadius: 3 },
};

// -----------------------------------------------------------------------------
// Tree rules (pure)

interface TreeNode<T> {
  readonly parent: T | null;
}

/** Lowest common ancestor-or-self of two nodes, null when they are in different trees. */
export function commonAncestor<T extends TreeNode<T>>(a: T, b: T): T | null {
  const seen = new Set<T>();
  for (let x: T | null = a; x; x = x.parent) seen.add(x);
  for (let x: T | null = b; x; x = x.parent) if (seen.has(x)) return x;
  return null;
}

/**
 * The levels a transition walks through (ThingJS `getPathTo`): leave from
 * `from` up to (not including) the common ancestor, then enter down to `to`.
 * Going up re-enters the ancestor itself; null stands for the globe, and
 * `enter` always ends with `to`.
 */
export function levelPath<T extends TreeNode<T>>(from: T | null, to: T | null): { leave: T[]; enter: (T | null)[] } {
  const ancestor = from && to ? commonAncestor(from, to) : null;
  const leave: T[] = [];
  for (let x = from; x && x !== ancestor; x = x.parent) leave.push(x);
  if (to === null || to === ancestor) return { leave, enter: [to] };
  const down: T[] = [];
  for (let x: T | null = to; x && x !== ancestor; x = x.parent) down.unshift(x);
  return { leave, enter: down };
}

function rootOf(e: BimEntity): BimEntity {
  let x = e;
  while (x.parent) x = x.parent;
  return x;
}

/** The child of `ancestor` on the way down to `e`. */
function childToward(ancestor: BimEntity, e: BimEntity): BimEntity {
  let x = e;
  while (x.parent && x.parent !== ancestor) x = x.parent;
  return x;
}

/**
 * Default pick mapping (ThingJS `filterObject`): the unit to act on is always
 * the next level that can be entered.
 * - On the globe: the whole building.
 * - The current level or one of its ancestors (e.g. the floor slab under a room): itself.
 * - Inside the current level: its direct child on the way to the hit (building → floor → room).
 * - Elsewhere (a sibling room, another floor, another building): the root of that
 *   branch below the common ancestor.
 * Structural elements (`structure` tag: walls, slabs, columns) are not interactive.
 */
export function defaultFilterObject(hit: BimEntity, current: BimEntity | null): BimEntity | null {
  if (current && (hit === current || current.isDescendantOf(hit))) return hit;
  const ancestor = current ? commonAncestor(current, hit) : null;
  const unit = ancestor ? childToward(ancestor, hit) : rootOf(hit);
  return unit.tags.has(STRUCTURE_TAG) ? null : unit;
}

// -----------------------------------------------------------------------------
// Built-in controls

/** Globe-level state of a building: shell shown, floors hidden and collapsed. */
export function showOutside(b: Building): void {
  b.exterior.visible = true;
  for (const f of b.floors) f.visible = false;
  b.setExpanded(0);
}

/** Nearest diagonal view of an entity's bounds, overridden by its document `viewpoint`. */
export function framedView(entity: BimEntity, ctx: LevelContext, framing: Framing): LevelView | null {
  const sphere = entity.worldBounds(new Sphere());
  if (!sphere) return null;
  const building = entity.closest('building');
  const buildingHeading = building instanceof Building ? building.heading / DEG2RAD : 0;
  const view = nearestDiagonalView(ctx.ellipsoid, sphere.center, sphere.radius, buildingHeading, ctx.camera.position, ctx.camera.getEffectiveFOV(), framing);
  const vp = entity.viewpoint;
  if (vp) {
    if (vp.heading !== undefined) view.heading = buildingHeading + vp.heading;
    if (vp.pitch !== undefined) view.pitch = vp.pitch;
    if (vp.range !== undefined) view.range = vp.range;
  }
  return view;
}

const filter = (hit: BimEntity, ctx: LevelContext) => defaultFilterObject(hit, ctx.object);

/** Building: shell off, all floors on (optionally spread apart), 3D Tiles hidden. */
export const buildingLevelControl: LevelControl = {
  name: 'building',
  condition: '.building',
  setEffect({ object, indoor }) {
    if (!(object instanceof Building)) return;
    object.exterior.visible = false;
    for (const f of object.floors) f.visible = true;
    object.setExpanded(indoor.expandFloors ? FLOOR_EXPAND_GAP : 0);
    indoor.setTilesetsVisible(!indoor.hideTilesetsIndoor);
  },
  resetEffect({ object, indoor }) {
    if (object instanceof Building) showOutside(object);
    indoor.setTilesetsVisible(true);
  },
  filterObject: filter,
  viewFor: (entity, ctx) => framedView(entity, ctx, LEVEL_FRAMING.building),
};

/** Floor: only this storey is shown, floors collapse. */
export const floorLevelControl: LevelControl = {
  name: 'floor',
  condition: '.floor',
  setEffect({ object }) {
    const b = object.closest('building');
    if (!(b instanceof Building)) return;
    for (const f of b.floors) f.visible = f === object;
    b.setExpanded(0);
  },
  resetEffect({ object }) {
    const b = object.closest('building');
    if (b instanceof Building) for (const f of b.floors) f.visible = true;
  },
  filterObject: filter,
  viewFor: (entity, ctx) => framedView(entity, ctx, LEVEL_FRAMING.floor),
};

/** Floor-local position of an entity's content (its label anchor without the height). */
function floorPoint(e: BimEntity): [number, number] {
  return [e.group.position.x + e.labelAnchor.x, e.group.position.y + e.labelAnchor.y];
}

function containsEntity(room: BimEntity, e: BimEntity): boolean {
  if (!room.outline) return false;
  const [x, y] = floorPoint(e);
  return pointInPolygon(x, y, room.outline);
}

/**
 * What stays opaque when a room or device is entered: the room and what
 * stands in it, or the device and the room it stands in.
 */
export function focusSet(level: BimEntity): Set<BimEntity> {
  const keep = new Set<BimEntity>([level]);
  for (const s of level.parent?.children ?? []) {
    if (s === level) continue;
    if (level.type === 'room' ? s.type !== 'room' && containsEntity(level, s) : s.type === 'room' && containsEntity(s, level)) keep.add(s);
  }
  return keep;
}

/** Room, device or element: everything else on the floor fades to 25 % (structure excepted). */
export const placementLevelControl: LevelControl = {
  name: 'placement',
  condition: '.room, .thing, .element',
  setEffect({ object }) {
    const keep = focusSet(object);
    for (const s of object.parent?.children ?? []) s.levelOpacity = keep.has(s) || s.tags.has(STRUCTURE_TAG) ? 1 : SIBLING_OPACITY;
  },
  resetEffect({ object }) {
    for (const s of object.parent?.children ?? []) s.levelOpacity = 1;
  },
  filterObject: filter,
  viewFor(entity, ctx) {
    const framing = entity.type === 'room' ? LEVEL_FRAMING.room : entity.type === 'element' ? LEVEL_FRAMING.element : LEVEL_FRAMING.thing;
    return framedView(entity, ctx, framing);
  },
};

/** Fallback for levels no registered control matches: no effects, default picking and framing. */
export const basicLevelControl: LevelControl = {
  name: 'basic',
  condition: () => true,
  priority: -Infinity,
  setEffect() {},
  resetEffect() {},
  filterObject: filter,
  viewFor: (entity, ctx) => framedView(entity, ctx, LEVEL_FRAMING.thing),
};

/** The built-in controls, registered under the tag 'builtin'. */
export const BUILTIN_LEVEL_CONTROLS: readonly LevelControl[] = [buildingLevelControl, floorLevelControl, placementLevelControl];
