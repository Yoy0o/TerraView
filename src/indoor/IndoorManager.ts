/**
 * Buildings on the globe and indoor level navigation (ThingJS level model):
 * globe → building → floor → room / thing. What each level shows, what a
 * pick resolves to and how the camera frames it come from level controls
 * (`LevelControl.ts`); this class walks the level path, caches viewpoints,
 * keeps selection / hover and owns the entity labels (顶牌).
 */
import { Group, Sphere, Vector3, type Object3D, type PerspectiveCamera, type Raycaster } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { DEG2RAD } from '../core/math';
import { createCard, type CardOptions } from '../markers/cards';
import type { Marker, MarkerManager } from '../markers/MarkerManager';
import { BimEntity, selectorPredicate, type EntitySelector } from './BimEntity';
import { Building, type ModelLoader } from './Building';
import { ContributionCuller } from './ContributionCulling';
import { EntitySet } from './EntitySet';
import { isBatchMesh } from './InstanceBatch';
import {
  basicLevelControl,
  BUILTIN_LEVEL_CONTROLS,
  defaultFilterObject,
  levelPath,
  showOutside,
  type LevelContext,
  type LevelControl,
} from './LevelControl';
import { fovNormalizedRange, type LevelView } from './levelView';
import { parseBuildingDoc, type BuildingDoc, type LabelDef, type LabelMode } from './schema';

export interface LevelEvent {
  /** The level entered or left at this step (null = the globe). */
  object: BimEntity | null;
  /** Level before the transition. */
  previous: BimEntity | null;
  /** Final level of the transition. */
  next: BimEntity | null;
  /** Every level of the transition in order: the ones left, then the ones entered. */
  path: readonly (BimEntity | null)[];
}

export interface IndoorEvents extends Record<string, unknown> {
  'buildings-changed': Building[];
  beforeEnterLevel: LevelEvent;
  enterLevel: LevelEvent;
  leaveLevel: LevelEvent;
  select: { entity: BimEntity | null };
  hover: { entity: BimEntity | null };
}

/** A camera pose: ECEF position, heading and pitch in degrees. */
export interface CameraPose {
  position: Vector3;
  heading: number;
  pitch: number;
  /** World (ECEF) point the pose looks at, if known (flights back keep it in frame). */
  target?: Vector3;
}

/** What the indoor layer needs from the viewer. */
export interface IndoorHost {
  readonly ellipsoid: Ellipsoid;
  readonly camera: PerspectiveCamera;
  readonly markers: MarkerManager;
  /**
   * Reliable ground height (WGS84 ellipsoidal meters, `viewer.surfaceHeight`: terrain,
   * or 3D Tiles without the globe) at a position in radians; null while not detailed
   * enough, in which case the building keeps its current height.
   */
  groundHeight(longitude: number, latitude: number): number | null;
  /** Flies to look at `view.target` from its heading / pitch / range (degrees, meters). */
  flyToView(view: LevelView, duration?: number): Promise<void>;
  /** Current camera pose. */
  getCameraPose(): CameraPose;
  /** Flies back to a pose returned by `getCameraPose`. */
  flyToPose(pose: CameraPose, duration?: number): Promise<void>;
  /** Photogrammetry and other 3D Tiles are hidden while inside a building so they cannot occlude it. */
  setTilesetsVisible(visible: boolean): void;
  loadModel: ModelLoader | null;
  /** Builds label DOM (default: `createCard`); injectable for custom cards and for tests. */
  createLabelElement?: (options: CardOptions, entity: BimEntity) => HTMLElement;
  /** Shifts the camera / its flight destination when the building being viewed moved (terrain clamping). */
  followMove?: (delta: Vector3) => void;
  /** Called right before a level change alters what is shown (the viewer crossfades from the current frame). */
  beginTransition?: () => void;
}

export interface EnterOptions {
  /** Animate the camera to the level (default true). */
  fly?: boolean;
  /** Flight duration in seconds (default: automatic). */
  duration?: number;
  /**
   * Fly only at the destination (default true). With false the camera flies
   * to every level on the way down (building, then floor, then room).
   */
  jumping?: boolean;
  /** Crossfade from the current picture while the level's content switches (default true). */
  transition?: boolean;
}

interface RegisteredControl {
  control: LevelControl;
  tag: string;
  order: number;
  test: (e: BimEntity) => boolean;
}

interface CachedView {
  pose: CameraPose;
  /** Building the pose looks at (moves with it when it settles on the terrain). */
  building: Building | null;
}

/** A level waits this long (ms) for its glTF models before the camera flies anyway. */
const MODEL_WAIT_MS = 1500;
/** The globe view is only remembered when the camera was within this many building radii (else back = a wide view). */
const GLOBE_CACHE_RADII = 50;
const HIGHLIGHT = '#1d4ed8';
const HOVER = '#0f2f66';

const _sphere = new Sphere();
const _p = new Vector3();

/**
 * Buildings and indoor navigation on the globe ("level" model of ThingJS):
 * globe → building → floor → room / thing. Double click enters a level,
 * right click or Esc goes back, the camera flies to every level and only
 * relevant content stays visible (exterior shell outside, one floor inside).
 * Every step of a transition emits `beforeEnterLevel` / `enterLevel` /
 * `leaveLevel`.
 */
export class IndoorManager {
  readonly root = new Group();
  readonly buildings: Building[] = [];
  readonly events = new EventEmitter<IndoorEvents>();
  /** Current level (null = globe). */
  current: BimEntity | null = null;
  hovered: BimEntity | null = null;
  selected: BimEntity | null = null;
  /** Hide 3D Tiles while inside a building. */
  hideTilesetsIndoor = true;
  /** Milliseconds a level waits for its models before the camera flies anyway. */
  modelWaitMs = MODEL_WAIT_MS;
  /**
   * Draw devices of the same shape / model as instanced batches with pooled
   * materials (M3.6). Applies to buildings added afterwards; false builds one
   * mesh and material per device.
   */
  batchDevices = true;
  /**
   * Contribution culling (M2.3): devices and non-structural components too
   * small on screen are not drawn. Off by default:
   * `indoor.culling.configure({ enabled: true, threshold: 0.005 })`.
   * The entered level and the selection are never culled.
   */
  readonly culling: ContributionCuller;
  private _showLabels = true;
  private _expandFloors = false;
  private readonly labels = new Map<BimEntity, Marker>();
  private readonly controls: RegisteredControl[] = [];
  private controlOrder = 0;
  /** Control that set the effect of each entered level (reset with the same one). */
  private readonly applied = new Map<BimEntity, LevelControl>();
  private readonly cameraRestores = new Map<BimEntity, () => void>();
  /** Camera poses remembered when diving below a level (key null = the globe). */
  private readonly viewCache = new Map<BimEntity | null, CachedView>();
  private transition: { cancelled: boolean } | null = null;
  private frame = 0;

  constructor(private readonly host: IndoorHost) {
    this.root.name = 'Indoor';
    for (const c of BUILTIN_LEVEL_CONTROLS) this.registerLevelControl(c, 'builtin');
    this.culling = new ContributionCuller(host.camera, () => this.buildings, (e) => e === this.current || e === this.selected);
    // Newly shown floors and a new selection get their state at once, not after the interval.
    for (const type of ['enterLevel', 'select'] as const) this.events.on(type, () => this.culling.invalidate());
  }

  get showLabels(): boolean {
    return this._showLabels;
  }

  set showLabels(v: boolean) {
    this._showLabels = v;
  }

  /** Spread the floors of the entered building apart (楼层展开). */
  get expandFloors(): boolean {
    return this._expandFloors;
  }

  set expandFloors(v: boolean) {
    this._expandFloors = v;
    this.refresh();
  }

  /** Re-applies the effects of the current level path (after changing options such as `hideTilesetsIndoor`). */
  refresh(): void {
    const c = this.current;
    if (!c) return;
    for (const level of [...c.ancestors(), c]) {
      const control = this.applied.get(level);
      if (control) void control.setEffect(this.context(level, c, c));
    }
  }

  /** Shows or hides the 3D Tiles layers (used by level controls). */
  setTilesetsVisible(visible: boolean): void {
    this.host.setTilesetsVisible(visible);
  }

  // ---------------------------------------------------------------------------
  // Buildings

  /** Adds a building from a document (object or JSON text); `baseUrl` resolves model URIs. */
  add(input: BuildingDoc | unknown, baseUrl?: string): Building {
    const doc = parseBuildingDoc(input);
    if (this.buildings.some((b) => b.id === doc.id)) throw new Error(`建筑 ${doc.id} 已加载`);
    const building = new Building(doc, this.host.ellipsoid, this.host.loadModel, baseUrl, { batching: this.batchDevices });
    this.buildings.push(building);
    this.root.add(building.root);
    showOutside(building);
    this.clampToGround(building, true);
    building.traverse((e) => this.createLabel(e));
    this.events.emit('buildings-changed', this.buildings);
    return building;
  }

  remove(building: Building): void {
    const i = this.buildings.indexOf(building);
    if (i < 0) return;
    // Synchronous when the controls' effects are: the building is reset before it is disposed.
    if (this.current && (this.current === building || this.current.isDescendantOf(building))) void this.enter(null, { fly: false, transition: false });
    if (this.selected?.closest('building') === building) this.select(null);
    if (this.hovered?.closest('building') === building) this.setHovered(null);
    building.traverse((e) => {
      this.labels.get(e)?.remove();
      this.labels.delete(e);
      this.viewCache.delete(e);
    });
    if (this.viewCache.get(null)?.building === building) this.viewCache.delete(null);
    this.buildings.splice(i, 1);
    this.culling.forget(building);
    building.dispose();
    this.events.emit('buildings-changed', this.buildings);
  }

  /**
   * All entities matching a selector (ThingJS `app.query`), e.g. '.room',
   * '#F3-R10', '.thing && [category=camera]', 'tags:or(alarm)'. Chain with
   * `.query()` to search below the results.
   */
  query(selector: EntitySelector): EntitySet {
    const test = selectorPredicate(selector);
    const out: BimEntity[] = [];
    for (const b of this.buildings) b.traverse((e) => test(e) && out.push(e));
    return EntitySet.create(out);
  }

  getById(id: string): BimEntity | null {
    let found: BimEntity | null = null;
    for (const b of this.buildings) {
      b.traverse((e) => {
        if (!found && e.id === id) found = e;
      });
      if (found) break;
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Level controls

  /**
   * Registers a level control; `tag` groups controls for
   * `unregisterLevelControls` (the built-in ones use 'builtin'). Returns a
   * function that unregisters it.
   */
  registerLevelControl(control: LevelControl, tag = 'custom'): () => void {
    const entry: RegisteredControl = { control, tag, order: this.controlOrder++, test: selectorPredicate(control.condition) };
    this.controls.push(entry);
    // Highest priority first, the most recently registered first among equals.
    this.controls.sort((a, b) => (b.control.priority ?? 0) - (a.control.priority ?? 0) || b.order - a.order);
    return () => {
      const i = this.controls.indexOf(entry);
      if (i >= 0) this.controls.splice(i, 1);
    };
  }

  /** Removes every level control registered with a tag (e.g. 'builtin' to replace the defaults). */
  unregisterLevelControls(tag: string): void {
    for (let i = this.controls.length - 1; i >= 0; i--) if (this.controls[i].tag === tag) this.controls.splice(i, 1);
  }

  /** The control a level uses: the highest-priority one whose condition matches. */
  controlFor(level: BimEntity): LevelControl {
    return this.controls.find((c) => c.test(level))?.control ?? basicLevelControl;
  }

  private context(object: BimEntity, origin: BimEntity | null, target: BimEntity | null): LevelContext {
    return { object, origin, target, indoor: this, camera: this.host.camera, ellipsoid: this.host.ellipsoid };
  }

  /**
   * The entity that hover, click and double click act on for a picked one at
   * the current level (the current level control's `filterObject`); null
   * when it is not interactive here.
   */
  filterObject(hit: BimEntity): BimEntity | null {
    const c = this.current;
    if (!c) return defaultFilterObject(hit, null);
    return (this.applied.get(c) ?? this.controlFor(c)).filterObject(hit, this.context(c, c, c));
  }

  /**
   * The level a double click on `hit` should enter: the building from
   * outside, then its floor, then the room / thing itself. Null when `hit` is
   * the current level or not interactive.
   */
  nextLevel(hit: BimEntity): BimEntity | null {
    const unit = this.filterObject(hit);
    return unit && unit !== this.current ? unit : null;
  }

  // ---------------------------------------------------------------------------
  // Levels

  /**
   * Switches the level (null = back to the globe) along the level path:
   * leaves the levels up to the common ancestor, then enters the ones down to
   * the target, each step with its events and level effects. A later call
   * cancels a transition still in progress. Rooms, things and elements get
   * selected. Resolves false when cancelled.
   */
  async enter(target: BimEntity | null, options: EnterOptions = {}): Promise<boolean> {
    if (this.transition) this.transition.cancelled = true;
    const token = { cancelled: false };
    this.transition = token;
    const origin = this.current;
    const { leave, enter } = levelPath(origin, target);
    const path = [...leave, ...enter];
    const fly = options.fly !== false;
    const jumping = options.jumping ?? true;
    const goingUp = target !== origin && (target === null || (origin !== null && origin.isDescendantOf(target)));
    const event = (object: BimEntity | null): LevelEvent => ({ object, previous: origin, next: target, path });

    // Diving below a level: remember the view to come back to it.
    if (fly && target && (origin === null || target.isDescendantOf(origin))) this.rememberView(origin, target);
    // Copy the picture before anything switches; re-entering the current level changes nothing.
    const changes = leave.length > 0 || enter[0] !== origin;
    if (changes && options.transition !== false) this.host.beginTransition?.();

    for (const level of leave) {
      const control = this.applied.get(level) ?? this.controlFor(level);
      this.applied.delete(level);
      this.cameraRestores.get(level)?.();
      this.cameraRestores.delete(level);
      const reset = control.resetEffect(this.context(level, origin, target));
      if (reset) await reset;
      if (token.cancelled) return false;
      this.viewCache.delete(level);
      this.current = level.parent;
      this.events.emit('leaveLevel', event(level));
      if (token.cancelled) return false;
    }

    for (let i = 0; i < enter.length; i++) {
      const level = enter[i];
      const last = i === enter.length - 1;
      this.events.emit('beforeEnterLevel', event(level));
      if (token.cancelled) return false;
      this.current = level;
      if (last) this.updateSelection(level);
      if (level) {
        const control = this.controlFor(level);
        this.applied.set(level, control);
        const set = control.setEffect(this.context(level, origin, target));
        if (set) await set;
        if (token.cancelled) return false;
        const restore = control.configureCamera?.(this.context(level, origin, target));
        if (restore && !this.cameraRestores.has(level)) this.cameraRestores.set(level, restore);
      }
      this.events.emit('enterLevel', event(level));
      if (token.cancelled) return false;
      if (fly && (last || !jumping)) {
        await this.waitForModels(level);
        if (token.cancelled) return false;
        await this.flyToLevel(level, origin, target, last && goingUp, options.duration);
        if (token.cancelled) return false;
      }
    }
    if (this.transition === token) this.transition = null;
    return true;
  }

  /** Goes up one level (room → floor → building → globe). */
  back(): Promise<boolean> {
    const c = this.current;
    if (!c) return Promise.resolve(true);
    return this.enter(c.parent);
  }

  /** Rooms, things and elements are selected when entered; leaving a level drops a selection outside it. */
  private updateSelection(level: BimEntity | null): void {
    if (level && (level.type === 'room' || level.type === 'thing' || level.type === 'element')) this.select(level);
    else if (this.selected && (!level || !this.selected.isDescendantOf(level))) this.select(null);
  }

  private rememberView(level: BimEntity | null, target: BimEntity): void {
    const building = target.closest('building') as Building | null;
    if (level === null) {
      // From far away (e.g. space) "back" should not fly all the way up again: only cache nearby views.
      const sphere = building?.worldBounds(_sphere);
      if (!sphere || this.host.camera.position.distanceTo(sphere.center) > Math.max(sphere.radius * GLOBE_CACHE_RADII, 5_000)) {
        this.viewCache.delete(null);
        return;
      }
    }
    this.viewCache.set(level, { pose: this.host.getCameraPose(), building });
  }

  /** Waits (bounded) until the level's models are attached, so the framing sees their bounds. */
  private async waitForModels(level: BimEntity | null): Promise<void> {
    const building = level?.closest('building');
    if (!level || !(building instanceof Building)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.modelWaitMs);
    });
    try {
      await Promise.race([building.modelsLoaded(level), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Building the camera is flying to (its re-grounding shifts the flight). */
  private flyingTo: Building | null = null;

  private async flyToLevel(level: BimEntity | null, origin: BimEntity | null, target: BimEntity | null, useCache: boolean, duration?: number): Promise<void> {
    const cached = useCache ? this.viewCache.get(level) : undefined;
    this.viewCache.delete(level);
    let view: LevelView | null = null;
    let building: Building | null;
    if (cached) {
      building = cached.building;
    } else if (level) {
      building = level.closest('building') as Building | null;
      view = (this.applied.get(level) ?? this.controlFor(level)).viewFor(level, this.context(level, origin, target));
      if (!view) return;
    } else {
      // Back to the globe without a remembered view: step out to a wide view of the building.
      building = (origin?.closest('building') as Building | null) ?? null;
      const sphere = building?.worldBounds(_sphere);
      if (!sphere) return;
      const range = fovNormalizedRange(Math.max(sphere.radius, 30) * 6.6, this.host.camera.getEffectiveFOV());
      view = { target: sphere.center.clone(), heading: this.host.getCameraPose().heading, pitch: -35, range };
    }
    this.flyingTo = building;
    try {
      if (cached) await this.host.flyToPose(cached.pose, duration);
      else await this.host.flyToView(view!, duration);
    } finally {
      this.flyingTo = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Selection / hover

  select(entity: BimEntity | null): void {
    if (entity === this.selected) return;
    const prev = this.selected;
    this.selected = entity;
    if (prev) this.restyle(prev);
    if (entity) this.restyle(entity);
    this.events.emit('select', { entity });
  }

  setHovered(entity: BimEntity | null): void {
    if (entity === this.hovered) return;
    const prev = this.hovered;
    this.hovered = entity;
    if (prev) this.restyle(prev);
    if (entity) this.restyle(entity);
    this.events.emit('hover', { entity });
  }

  private restyle(e: BimEntity): void {
    const color = e === this.selected ? HIGHLIGHT : e === this.hovered && e.type !== 'building' ? HOVER : null;
    e.setStyle({ emissive: color });
  }

  /** Closest visible entity hit by a ray (batched devices resolve through the hit's instance index). */
  pick(raycaster: Raycaster): { entity: BimEntity; point: Vector3; distance: number } | null {
    if (this.buildings.length === 0) return null;
    const hits = raycaster.intersectObject(this.root, true);
    for (const h of hits) {
      if (!isVisible(h.object)) continue;
      const entity = this.entityForHit(h.object, h.instanceId);
      if (entity) return { entity, point: h.point, distance: h.distance };
    }
    return null;
  }

  /**
   * Entity drawn by a scene object (a ray hit or a GPU pick sample): the
   * device at `instanceId` for batched devices, else the closest entity up
   * the parent chain. Null for objects outside the buildings.
   */
  entityForHit(object: Object3D, instanceId?: number): BimEntity | null {
    if (isBatchMesh(object)) return instanceId !== undefined ? object.entityAt(instanceId) : null;
    return entityOf(object);
  }

  // ---------------------------------------------------------------------------
  // Labels (顶牌)

  private createLabel(e: BimEntity): void {
    const def = e.label ?? defaultLabel(e);
    if (!def) return;
    const mode: LabelMode = def.mode ?? (e.type === 'building' ? 'always' : 'level');
    const subtitle = def.subtitle ?? (e.type === 'room' ? String(e.properties['面积'] ?? '') : undefined);
    const card: CardOptions = {
      title: def.title ?? e.name,
      subtitle,
      style: def.style ?? (e.type === 'building' ? 'card' : e.type === 'thing' ? 'pin' : 'tag'),
      color: def.color,
      icon: def.icon,
    };
    const element = (this.host.createLabelElement ?? createCard)(card, e);
    // Alarm cards (style 'card' inside a floor) and the selection always win the collision test.
    const base = e.type === 'building' ? 10 : def.style === 'card' ? 8 : e.type === 'room' ? 4 : 2;
    const marker = this.host.markers.add({
      element,
      position: () => e.labelPosition(_p),
      visible: () => this.isLabelVisible(e, mode),
      maxDistance: e.type === 'building' ? 25_000 : e.type === 'thing' ? 120 : 400,
      zIndex: e.type === 'building' ? 1 : e.type === 'thing' ? 3 : 2,
      // Cards (buildings, alarms) are never hidden by decluttering; tags and pins make way for them.
      declutter: e.type !== 'building' && def.style !== 'card',
      priority: () => base + (this.selected === e ? 20 : 0) + (this.hovered === e ? 10 : 0),
      // Clicks on the label reach `viewer.interaction` as clicks on the entity (marker event proxy).
      userData: { entity: e },
    });
    this.labels.set(e, marker);
  }

  private isLabelVisible(e: BimEntity, mode: LabelMode): boolean {
    if (!this._showLabels) return false;
    if (e.type === 'building') {
      const inside = this.current?.closest('building') === e;
      return !inside && (mode === 'always' || (mode === 'hover' && this.hovered === e));
    }
    if (!e.effectivelyVisible) return false;
    switch (mode) {
      case 'always':
        return true;
      case 'hover':
        return this.hovered === e;
      case 'click':
        return this.selected === e;
      case 'level': {
        const parent = e.parent;
        const c = this.current;
        return !!parent && !!c && (c === parent || c.isDescendantOf(parent));
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** Advances animations and terrain clamping; returns true when something moved (floors spreading, a building re-grounded). */
  update(dt: number): boolean {
    this.frame++;
    let changed = false;
    for (const b of this.buildings) {
      if (b.update(dt)) changed = true;
      // Poll often until the terrain under the anchor is detailed enough, then rarely.
      if (this.frame % (this.grounded.has(b) ? 30 : 5) === 0 && this.clampToGround(b, false)) changed = true;
    }
    if (this.culling.update()) changed = true;
    return changed;
  }

  private readonly grounded = new WeakSet<Building>();

  /** Whether a building without an explicit height still waits for a reliable ground height. */
  get awaitingGround(): boolean {
    return this.buildings.some((b) => b.doc.anchor.height === undefined && !this.grounded.has(b));
  }

  /** Buildings without an explicit height sit on the terrain; refined as finer terrain arrives. Returns true when the building moved. */
  private clampToGround(b: Building, force: boolean): boolean {
    if (b.doc.anchor.height !== undefined) return false;
    const a = b.doc.anchor;
    const h = this.host.groundHeight(a.longitude * DEG2RAD, a.latitude * DEG2RAD);
    if (h === null) return false;
    this.grounded.add(b);
    if (!force && Math.abs(h - b.groundHeight) <= 0.25) return false;
    const before = b.group.getWorldPosition(new Vector3());
    b.place(h);
    const delta = b.group.getWorldPosition(new Vector3()).sub(before);
    // Remembered views of this building move with it.
    for (const v of this.viewCache.values()) {
      if (v.building !== b) continue;
      v.pose.position.add(delta);
      v.pose.target?.add(delta);
    }
    // Keep looking at the building when it settles while we fly to it or are inside it.
    if (this.host.followMove && (this.flyingTo === b || this.current?.closest('building') === b)) this.host.followMove(delta);
    return true;
  }

  dispose(): void {
    if (this.transition) this.transition.cancelled = true;
    for (const b of [...this.buildings]) this.remove(b);
    this.root.removeFromParent();
  }
}

function defaultLabel(e: BimEntity): LabelDef | null {
  // Buildings and rooms always get a card; equipment only when the document asks for one.
  return e.type === 'building' || e.type === 'room' ? {} : null;
}

function isVisible(o: Object3D): boolean {
  for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function entityOf(o: Object3D): BimEntity | null {
  for (let x: Object3D | null = o; x; x = x.parent) {
    const e = x.userData.entity as BimEntity | undefined;
    if (e instanceof BimEntity) return e;
  }
  return null;
}
