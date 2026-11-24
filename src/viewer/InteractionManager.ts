/**
 * Pointer events resolved to scene objects (ThingJS `app.on`): click,
 * double click, right click, hover; selectors with bubbling, tags,
 * priorities, `once`, `stopPropagation`, pausing (ThingJS `pauseEvent`), and
 * an event proxy for HTML labels.
 */
import type { Vector3 } from 'three';
import type { Cartographic } from '../core/Ellipsoid';
import { selectorPredicate, type BimEntity, type EntitySelector } from '../indoor/BimEntity';
import type { Marker } from '../markers/MarkerManager';
import type { TileFeature } from '../tiles3d/Tiles3DLayer';
import type { Tiles3DLayer } from '../tiles3d/Tiles3DLayer';

const noTileFeature = (): TileFeature | null => null;

/** What lies under a screen point (closest along the view ray). */
export interface PickInfo {
  kind: 'entity' | 'tiles' | 'globe' | 'none';
  /** Building / floor / room / thing hit, when `kind` is 'entity'. */
  entity: BimEntity | null;
  tileset: Tiles3DLayer | null;
  /** World (ECEF) position. */
  point: Vector3 | null;
  /** Radians / meters. */
  cartographic: Cartographic | null;
  clientX: number;
  clientY: number;
  /** The HTML label (顶牌) the event came through; null for picks in the 3D scene. */
  marker: Marker | null;
  /**
   * The 3D Tiles feature at this pick (feature ID and properties), resolved on the first
   * call with a CPU ray from the camera pose of the pick, then cached; null when the pick
   * is not on a 3D Tiles layer or its content has no readable feature there. Optional
   * for hosts building picks themselves; events always have it.
   */
  tileFeature?: () => TileFeature | null;
}

export type InteractionType = 'click' | 'dblclick' | 'rightclick' | 'mousemove' | 'mouseenter' | 'mouseleave';

export interface InteractionEvent extends PickInfo {
  type: InteractionType;
  /**
   * The 3D Tiles feature under the pointer, or null (see `PickInfo.tileFeature`). Costs a
   * CPU ray on the first call per pick: call it in the listeners that need it.
   */
  tileFeature(): TileFeature | null;
  /** The entity the listener's selector matched (the hit entity or an ancestor); the hit entity without a selector. */
  object: BimEntity | null;
  button: number;
  originalEvent: MouseEvent | null;
  /** Suppresses the default behavior (e.g. the camera's double-click flight). */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
  /**
   * Stops the remaining listeners, except those with the same priority whose
   * selector matched the same entity (like listeners on one DOM node).
   * Listeners run by priority, then deepest matched entity first (bubbling).
   */
  stopPropagation(): void;
  /** Stops every remaining listener. */
  stopImmediatePropagation(): void;
}

export interface ListenerOptions {
  /** Only fire for entities matching this selector (bubbling to ancestors), e.g. '.building'. */
  selector?: EntitySelector;
  /** Group listeners for removal with `off(type, tag)` (ThingJS event tags). */
  tag?: string;
  /** Higher runs first (default 0). */
  priority?: number;
  /** Remove the listener after its first call. */
  once?: boolean;
}

/**
 * Which listeners a pause covers; every given field must match, an empty
 * scope covers all listeners.
 */
export interface PauseScope {
  /** Event type(s); all types when omitted. */
  type?: InteractionType | readonly InteractionType[];
  /** Only listeners registered with this tag. */
  tag?: string;
  /**
   * Only events whose hit entity (or an ancestor) matches, e.g. '.floor' pauses
   * listeners for picks inside floors; picks of the globe, tiles or nothing
   * are not covered.
   */
  selector?: EntitySelector;
  /**
   * Also suppress the default behavior of covered events (the camera's
   * double-click flight), as if a listener called `preventDefault()`.
   * Ignores `tag` (defaults belong to no listener). Default false: pausing
   * only silences listeners.
   */
  blockDefault?: boolean;
}

type Handler = (e: InteractionEvent) => void;

interface Pause {
  scope: PauseScope;
  types: ReadonlySet<InteractionType> | null;
  test: ((e: BimEntity) => boolean) | null;
}

interface Listener {
  type: InteractionType;
  handler: Handler;
  test: ((e: BimEntity) => boolean) | null;
  tag?: string;
  priority: number;
  once: boolean;
  /** Registration order (ties). */
  order: number;
  /** Hover state for mouseenter / mouseleave. */
  current: BimEntity | null;
}

export interface InteractionHost {
  readonly domElement: HTMLElement;
  pickAt(clientX: number, clientY: number): PickInfo;
  /** Geodetic position of a world point (for proxied events). */
  toCartographic?(point: Vector3): Cartographic | null;
}

const CLICK_SLOP_PX = 5;
const CLICK_MAX_MS = 500;

/** Listener with the entity its selector matched for one dispatch. */
interface Match {
  l: Listener;
  object: BimEntity | null;
  depth: number;
}

function depthOf(e: BimEntity | null): number {
  let d = 0;
  for (let x = e; x; x = x.parent) d++;
  return d;
}

/**
 * Pointer events resolved to scene objects (ThingJS-style `app.on`):
 * click / dblclick / rightclick (no drag), mousemove, mouseenter / mouseleave
 * on entities, with selector bubbling and tags. Hover picking is throttled to
 * one ray cast per frame and only runs while hover listeners exist.
 */
export class InteractionManager {
  enabled = true;
  private listeners: Listener[] = [];
  private pauses: Pause[] = [];
  private order = 0;
  private down: { x: number; y: number; t: number; button: number } | null = null;
  private pendingMove: { x: number; y: number } | null = null;
  private hovered: PickInfo | null = null;
  private pointerInside = false;

  constructor(private readonly host: InteractionHost) {
    const el = host.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);
  }

  /** Last hover pick (null when the pointer is outside or nothing is hovered). */
  get hover(): PickInfo | null {
    return this.hovered;
  }

  on(type: InteractionType, handler: Handler, options: ListenerOptions = {}): () => void {
    const listener: Listener = {
      type,
      handler,
      test: options.selector !== undefined ? selectorPredicate(options.selector) : null,
      tag: options.tag,
      priority: options.priority ?? 0,
      once: options.once === true,
      order: this.order++,
      current: null,
    };
    this.listeners.push(listener);
    return () => this.remove(listener);
  }

  /** Removes listeners of a type; restrict to a tag or a handler. */
  off(type: InteractionType, tagOrHandler?: string | Handler): void {
    this.listeners = this.listeners.filter((l) => {
      if (l.type !== type) return true;
      if (tagOrHandler === undefined) return false;
      return typeof tagOrHandler === 'string' ? l.tag !== tagOrHandler : l.handler !== tagOrHandler;
    });
  }

  /**
   * Pauses listeners until resumed (e.g. scene clicks while a dialog is open).
   * Paused listeners are skipped as if absent: `once` listeners are kept,
   * hover listeners keep their last state and catch up (leave / enter) on the
   * first pointer move after resuming. Covers listeners registered later too.
   * Pauses stack; the returned function lifts this one pause.
   */
  pause(scope: PauseScope = {}): () => void {
    const p: Pause = {
      scope: { ...scope },
      types: scope.type === undefined ? null : new Set(typeof scope.type === 'string' ? [scope.type] : scope.type),
      test: scope.selector !== undefined ? selectorPredicate(scope.selector) : null,
    };
    this.pauses.push(p);
    return () => {
      this.pauses = this.pauses.filter((x) => x !== p);
    };
  }

  /**
   * Lifts pauses: all of them without a scope, otherwise those made with the
   * same `type`, `tag` and `selector` (strings and regexps compared by value,
   * functions by identity).
   */
  resume(scope?: PauseScope): void {
    if (!scope) {
      this.pauses = [];
      return;
    }
    this.pauses = this.pauses.filter(
      ({ scope: s }) => !(sameTypes(s.type, scope.type) && s.tag === scope.tag && sameSelector(s.selector, scope.selector)),
    );
  }

  /** Whether any pause is active. */
  get paused(): boolean {
    return this.pauses.length > 0;
  }

  /** Whether a pause covers a listener for a pick of `entity`. */
  private isPaused(l: Listener, entity: BimEntity | null): boolean {
    return this.pauses.some((p) => covers(p, l.type, l.tag, entity, true));
  }

  /** Paused for every pick (a pause without a selector): no need to pick at all. */
  private pausedEverywhere(l: Listener): boolean {
    return this.pauses.some((p) => !p.test && covers(p, l.type, l.tag, null, true));
  }

  /** Whether a pause blocks the default behavior of an event on `entity`. */
  private defaultBlocked(type: InteractionType, entity: BimEntity | null): boolean {
    return this.pauses.some((p) => p.scope.blockDefault === true && covers(p, type, undefined, entity, false));
  }

  private mayBlockDefault(type: InteractionType): boolean {
    return this.pauses.some((p) => p.scope.blockDefault === true && (!p.types || p.types.has(type)));
  }

  private remove(listener: Listener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /** Listeners of a type that could run (cheap check before picking). */
  private hasListeners(type: InteractionType): boolean {
    return this.listeners.some((l) => l.type === type && !this.pausedEverywhere(l));
  }

  private hasHoverListeners(): boolean {
    return this.listeners.some(
      (l) => (l.type === 'mousemove' || l.type === 'mouseenter' || l.type === 'mouseleave') && !this.pausedEverywhere(l),
    );
  }

  /** Dispatches a native double click; returns true when a listener prevented the default. */
  dispatchDoubleClick(e: MouseEvent): boolean {
    if (!this.enabled || !(this.hasListeners('dblclick') || this.mayBlockDefault('dblclick'))) return false;
    return this.dispatch('dblclick', this.host.pickAt(e.clientX, e.clientY), e.button, e);
  }

  /**
   * Dispatches an event that reached an entity outside the canvas, such as a
   * click on its HTML label (ThingJS DOM event proxy): listeners run exactly
   * as for a pick of `entity`, with `marker` set. Returns true when a
   * listener prevented the default.
   */
  dispatchProxy(
    type: 'click' | 'dblclick' | 'rightclick',
    entity: BimEntity,
    original: MouseEvent | null,
    source: { marker?: Marker | null; point?: Vector3 | null } = {},
  ): boolean {
    if (!this.enabled || !(this.hasListeners(type) || this.mayBlockDefault(type))) return false;
    const point = source.point ?? null;
    const pick: PickInfo = {
      kind: 'entity',
      entity,
      tileset: null,
      point,
      cartographic: point && this.host.toCartographic ? this.host.toCartographic(point) : null,
      clientX: original?.clientX ?? 0,
      clientY: original?.clientY ?? 0,
      marker: source.marker ?? null,
    };
    return this.dispatch(type, pick, type === 'rightclick' ? 2 : 0, original);
  }

  /** Runs throttled hover picking; call once per frame. */
  update(): void {
    if (!this.enabled || !this.pendingMove) return;
    const { x, y } = this.pendingMove;
    this.pendingMove = null;
    if (!this.hasHoverListeners()) {
      this.hovered = null;
      return;
    }
    const pick = this.host.pickAt(x, y);
    this.hovered = pick;
    this.updateHover(pick, null);
  }

  /** Listeners of a type that apply to a pick, in dispatch order. */
  private matches(type: InteractionType, entity: BimEntity | null): Match[] {
    const out: Match[] = [];
    for (const l of this.listeners) {
      if (l.type !== type || this.isPaused(l, entity)) continue;
      let object = entity;
      if (l.test) {
        object = null;
        for (let x = entity; x; x = x.parent) {
          if (l.test(x)) {
            object = x;
            break;
          }
        }
        if (!object) continue;
      }
      out.push({ l, object, depth: depthOf(object) });
    }
    return out.sort((a, b) => b.l.priority - a.l.priority || b.depth - a.depth || a.l.order - b.l.order);
  }

  /** Calls matched listeners in order, honoring `once` and propagation stops. Returns true when the default was prevented. */
  private run(list: readonly Match[], make: (m: Match) => InteractionEvent): boolean {
    let prevented = false;
    let stop: Match | null = null;
    let stopAll = false;
    for (const m of list) {
      if (stopAll) break;
      // After stopPropagation only peers (same priority, same matched entity) still run.
      if (stop && (m.l.priority !== stop.l.priority || m.object !== stop.object)) break;
      if (m.l.once) this.remove(m.l);
      const event = make(m);
      let stopped = false;
      event.stopPropagation = () => {
        stopped = true;
      };
      event.stopImmediatePropagation = () => {
        stopAll = true;
      };
      m.l.handler(event);
      prevented ||= event.defaultPrevented;
      if (stopped && !stop) stop = m;
    }
    return prevented;
  }

  private updateHover(pick: PickInfo | null, original: MouseEvent | null): void {
    // All leaves before all enters, so moving from A to B reads "leave A, enter B".
    const leaves: Match[] = [];
    const enters: Match[] = [];
    const entity = pick?.entity ?? null;
    for (const type of ['mouseenter', 'mouseleave'] as const) {
      // Hover state is tracked per listener: the entity its selector matches under the pointer.
      for (const l of this.listeners) {
        // Paused: keep the last state so the listener catches up after resuming.
        if (l.type !== type || this.isPaused(l, entity)) continue;
        let next: BimEntity | null = entity;
        if (l.test) {
          next = null;
          for (let x = entity; x; x = x.parent) {
            if (l.test(x)) {
              next = x;
              break;
            }
          }
        }
        if (next === l.current) continue;
        const prev = l.current;
        l.current = next;
        if (type === 'mouseleave' && prev) leaves.push({ l, object: prev, depth: depthOf(prev) });
        if (type === 'mouseenter' && next) enters.push({ l, object: next, depth: depthOf(next) });
      }
    }
    const order = (a: Match, b: Match) => b.l.priority - a.l.priority || b.depth - a.depth || a.l.order - b.l.order;
    this.run(leaves.sort(order), (m) => this.makeEvent('mouseleave', pick ?? emptyPick(), m.object, 0, original));
    this.run(enters.sort(order), (m) => this.makeEvent('mouseenter', pick!, m.object, 0, original));
    if (pick) this.run(this.matches('mousemove', pick.entity), (m) => this.makeEvent('mousemove', pick, m.object, 0, original));
  }

  private dispatch(type: InteractionType, pick: PickInfo, button: number, original: MouseEvent | null): boolean {
    const prevented = this.run(this.matches(type, pick.entity), (m) => this.makeEvent(type, pick, m.object, button, original));
    return prevented || this.defaultBlocked(type, pick.entity);
  }

  private makeEvent(type: InteractionType, pick: PickInfo, object: BimEntity | null, button: number, original: MouseEvent | null): InteractionEvent {
    let prevented = false;
    return {
      ...pick,
      type,
      object,
      button,
      originalEvent: original,
      tileFeature: pick.tileFeature ?? noTileFeature,
      preventDefault: () => {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
      // Replaced per listener by `run`.
      stopPropagation: () => undefined,
      stopImmediatePropagation: () => undefined,
    };
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button } : null;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!this.enabled || !d || d.button !== e.button) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX || performance.now() - d.t > CLICK_MAX_MS) return;
    const type: InteractionType | null = e.button === 0 ? 'click' : e.button === 2 ? 'rightclick' : null;
    if (!type || !this.hasListeners(type)) return;
    this.dispatch(type, this.host.pickAt(e.clientX, e.clientY), e.button, e);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    this.pointerInside = true;
    // No hover updates while dragging the camera.
    if (e.buttons !== 0) return;
    this.pendingMove = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerLeave = () => {
    if (!this.pointerInside) return;
    this.pointerInside = false;
    this.pendingMove = null;
    this.hovered = null;
    this.updateHover(null, null);
  };

  dispose(): void {
    const el = this.host.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    this.listeners = [];
    this.pauses = [];
  }
}

function sameTypes(a: PauseScope['type'], b: PauseScope['type']): boolean {
  const norm = (t: PauseScope['type']) => (t === undefined ? '' : (typeof t === 'string' ? [t] : [...t]).sort().join());
  return norm(a) === norm(b);
}

function sameSelector(a: EntitySelector | undefined, b: EntitySelector | undefined): boolean {
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  return a === b;
}

/**
 * Whether a pause covers an event type for a pick of `entity`, and the
 * listener's tag when `checkTag` (default behaviors have no tag).
 */
function covers(p: Pause, type: InteractionType, tag: string | undefined, entity: BimEntity | null, checkTag: boolean): boolean {
  if (p.types && !p.types.has(type)) return false;
  if (checkTag && p.scope.tag !== undefined && p.scope.tag !== tag) return false;
  if (!p.test) return true;
  for (let x = entity; x; x = x.parent) if (p.test(x)) return true;
  return false;
}

function emptyPick(): PickInfo {
  return { kind: 'none', entity: null, tileset: null, point: null, cartographic: null, clientX: 0, clientY: 0, marker: null };
}
