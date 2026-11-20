/**
 * HTML markers / top cards (顶牌) anchored to world positions: projection in
 * float64 each frame, culling (behind the camera, horizon, viewport, distance
 * range) and screen-space decluttering.
 *
 * Built for thousands of markers (see docs/agents/markers.md §5):
 * - Decluttering uses a uniform grid (`CollisionGrid`), O(n) per frame.
 * - Styles are written only when they change (transform rounded to 0.1 px,
 *   z-index, display), so a still camera causes no style recalculation and a
 *   moving one only touches the markers on screen.
 * - New or resized elements are measured together in one layout.
 * - Above `DENSE_ON` shown markers the layer gets the `dense` class, which
 *   drops per-element blur filters (`backdrop-filter` re-blurs the WebGPU
 *   canvas under every label on every frame).
 * - Event proxy: clicks, double clicks and right clicks on a marker that
 *   carries `userData.entity` (and no handler of its own) go to
 *   `eventProxy`, which the viewer forwards to `viewer.interaction`.
 * - Occlusion (`occlusion: 'hide' | 'fade'`, M2.2): markers on screen get a
 *   proxy from `occlusion` (the viewer's occlusion queries); while it is
 *   hidden behind opaque geometry the marker is hidden or faded. Important
 *   markers (not decluttered) only fade. See `occlusion.ts`.
 */
import { Matrix4, Vector3, type PerspectiveCamera } from 'three';
import { CollisionGrid } from '../core/CollisionGrid';
import { isScaledSpacePointVisible, WGS84_A, WGS84_B } from '../core/geodesy';
import { effectiveOcclusion, OcclusionState, proxyRadius, type MarkerOcclusion, type OcclusionMode } from './occlusion';

export interface MarkerOptions {
  /** World (ECEF) anchor, or a function evaluated every frame (null hides the marker). */
  position: Vector3 | (() => Vector3 | null);
  /** Content; positioned with CSS transforms inside the marker layer. */
  element: HTMLElement;
  /** Point of the element placed on the anchor, as fractions of its size. Default bottom center [0.5, 1]. */
  pivot?: [number, number];
  /** Extra screen offset in CSS pixels (x right, y down). */
  offsetPx?: [number, number];
  /** Hide closer / farther than these camera distances (meters). */
  minDistance?: number;
  maxDistance?: number;
  /** Hide anchors behind the globe's horizon (default true). */
  horizonCulling?: boolean;
  /** Static or computed visibility (e.g. "only while this floor is entered"). */
  visible?: boolean | (() => boolean);
  /** Shrink with distance: scale 1 up to `near`, `minScale` from `far` on. */
  scaleByDistance?: [near: number, far: number, minScale: number];
  /** Stacking order; nearer markers are drawn on top within the same value. */
  zIndex?: number;
  /**
   * Hide this marker when it would overlap a more important one (screen-space
   * collision test). Markers without it are always shown and act as obstacles.
   */
  declutter?: boolean;
  /** Collision priority (higher wins; ties go to the nearer marker). May change per frame. */
  priority?: number | (() => number);
  /**
   * When the anchor is hidden behind opaque geometry (buildings, terrain, 3D
   * Tiles): 'none' (default) keeps the marker, 'hide' hides it, 'fade' dims
   * it (`.marker.occluded`). Markers that do not declutter (cards, alarms)
   * are never hidden: 'hide' fades them. Needs `MarkerManager.occlusion`.
   */
  occlusion?: OcclusionMode;
  onClick?: (event: MouseEvent, marker: Marker) => void;
  onDoubleClick?: (event: MouseEvent, marker: Marker) => void;
  /**
   * `entity`: the scene object the marker labels. Events the marker has no
   * handler for are passed to `MarkerManager.eventProxy` as events on it.
   */
  userData?: Record<string, unknown>;
}

/** Marker events forwarded by the event proxy. */
export type MarkerEventType = 'click' | 'dblclick' | 'rightclick';

/** Per-frame counters (`viewer.markers.stats`). */
export interface MarkerStats {
  /** Registered markers. */
  total: number;
  /** Passed culling this frame. */
  candidates: number;
  /** Hidden by decluttering this frame. */
  decluttered: number;
  /** Shown this frame. */
  shown: number;
  /** Hidden or faded because their anchor is occluded, this frame. */
  occluded: number;
  /** CPU time of the last `update`, ms. */
  ms: number;
}

/** Shown-marker counts that switch the layer's `dense` class on / off (hysteresis). */
const DENSE_ON = 80;
const DENSE_OFF = 60;
/**
 * Collision placement runs at most this often (ms), like Mapbox GL's symbol placement;
 * in between, markers keep their last decision and only move. Placing every frame makes
 * labels blink while zooming and restyles hundreds of elements per frame.
 */
const PLACEMENT_INTERVAL = 150;
/** Sooner when markers new in view are waiting for a decision (they stay hidden until then). */
const PENDING_INTERVAL = 50;
/** Padding around placed markers in the collision test, CSS px. */
const GAP = 2;

const _vp = new Matrix4();
const _cam = new Vector3();

/** A DOM element pinned to a point on the globe (ThingJS `CSS2DComponent` / UIAnchor). */
export class Marker {
  readonly element: HTMLElement;
  /** Whether the marker was shown in the last frame. */
  shown = false;
  /** Screen position (CSS px) of the anchor in the last frame. */
  screenX = 0;
  screenY = 0;
  distance = 0;
  private width = -1;
  private height = -1;
  private readonly wrapper: HTMLElement;
  private readonly onClick: (e: MouseEvent) => void;
  private readonly onDoubleClick: (e: MouseEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onContextMenu: (e: MouseEvent) => void;
  /** A right button press started on this marker (only then is a context menu a right click on it). */
  private rightDown = false;
  // Last written style values (write-on-change).
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastScale = 1;
  private lastZ = Number.NaN;
  private originSet = false;
  /** @internal Per-frame values used by `MarkerManager.update`. */
  scale = 1;
  z = 0;
  priority = 0;
  /** @internal Last collision decision: 0 = none yet, 1 = placed, 2 = decluttered. */
  placement: 0 | 1 | 2 = 0;
  /** @internal Occlusion proxy slot (-1 = none). */
  proxy = -1;
  /** @internal Debounced occlusion state. */
  readonly occlusion = new OcclusionState();
  private faded = false;

  constructor(
    readonly options: MarkerOptions,
    private readonly manager: MarkerManager,
  ) {
    this.element = options.element;
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'tv-marker';
    this.wrapper.style.display = 'none';
    this.wrapper.append(this.element);
    const proxied = options.userData?.entity !== undefined;
    this.onClick = (e: MouseEvent) => (options.onClick ? options.onClick(e, this) : this.forward('click', e));
    this.onDoubleClick = (e: MouseEvent) => (options.onDoubleClick ? options.onDoubleClick(e, this) : this.forward('dblclick', e));
    this.onPointerDown = (e: PointerEvent) => {
      this.rightDown = e.button === 2;
    };
    this.onContextMenu = (e: MouseEvent) => {
      // A right drag that started on the canvas and ended here is a camera gesture, not a click.
      if (this.rightDown) this.forward('rightclick', e);
      this.rightDown = false;
    };
    if (options.onClick || options.onDoubleClick || proxied) {
      this.wrapper.classList.add('tv-interactive');
      this.wrapper.addEventListener('click', this.onClick);
      this.wrapper.addEventListener('dblclick', this.onDoubleClick);
    }
    if (proxied) {
      this.wrapper.addEventListener('pointerdown', this.onPointerDown);
      this.wrapper.addEventListener('contextmenu', this.onContextMenu);
    }
  }

  private forward(type: MarkerEventType, e: MouseEvent): void {
    if (this.options.userData?.entity === undefined) return;
    this.manager.eventProxy?.(type, this, e);
  }

  get root(): HTMLElement {
    return this.wrapper;
  }

  /** Re-measure the element on the next frame (call after changing its content). */
  invalidateSize(): void {
    this.width = -1;
  }

  /** @internal Whether the element size is unknown (new, or changed with `invalidateSize`). */
  get needsMeasure(): boolean {
    return this.width < 0;
  }

  /**
   * @internal Measures many markers with a single layout: show the hidden
   * ones, read all sizes, then hide them again. Measuring one by one would
   * force one synchronous layout per marker (seconds for thousands of points).
   */
  static measureAll(markers: readonly Marker[]): void {
    const unhidden: Marker[] = [];
    for (const m of markers) {
      if (m.wrapper.style.display === 'none') {
        m.wrapper.style.display = '';
        unhidden.push(m);
      }
    }
    for (const m of markers) {
      m.width = m.element.offsetWidth;
      m.height = m.element.offsetHeight;
    }
    for (const m of unhidden) m.wrapper.style.display = 'none';
  }

  remove(): void {
    this.manager.remove(this);
  }

  /** @internal Element size in CSS pixels (measured once, or after `invalidateSize`). */
  measure(): [number, number] {
    if (this.width < 0) Marker.measureAll([this]);
    return [this.width, this.height];
  }

  /** @internal Screen rectangle [x0, y0, x1, y1] the element would cover with its anchor at (x, y). */
  rect(x: number, y: number, scale: number): [number, number, number, number] {
    const [w, h] = this.measure();
    const [px, py] = this.options.pivot ?? [0.5, 1];
    const [ox, oy] = this.options.offsetPx ?? [0, 0];
    const ax = x + ox;
    const ay = y + oy;
    return [ax - px * w * scale, ay - py * h * scale, ax + (1 - px) * w * scale, ay + (1 - py) * h * scale];
  }

  /** @internal Places the element with its anchor at (x, y); writes only what changed. */
  place(x: number, y: number, scale: number, z: number): void {
    this.measure();
    const [px, py] = this.options.pivot ?? [0.5, 1];
    const [ox, oy] = this.options.offsetPx ?? [0, 0];
    // Rounded to 0.1 px: sub-pixel jitter of a still camera writes nothing.
    const tx = Math.round((x - px * this.width + ox) * 10) / 10;
    const ty = Math.round((y - py * this.height + oy) * 10) / 10;
    const s = Math.round(scale * 1000) / 1000;
    const style = this.wrapper.style;
    if (tx !== this.lastX || ty !== this.lastY || s !== this.lastScale) {
      if (!this.originSet) {
        style.transformOrigin = `${px * 100}% ${py * 100}%`;
        this.originSet = true;
      }
      style.transform = `translate3d(${tx}px, ${ty}px, 0)${s !== 1 ? ` scale(${s})` : ''}`;
      this.lastX = tx;
      this.lastY = ty;
      this.lastScale = s;
    }
    if (z !== this.lastZ) {
      style.zIndex = String(z);
      this.lastZ = z;
    }
    if (!this.shown) {
      style.display = '';
      this.shown = true;
    }
  }

  /** Whether the marker is hidden or faded because its anchor is occluded. */
  get occluded(): boolean {
    return this.occlusion.occluded;
  }

  /** @internal Dims the marker while occluded (`.tv-marker.tv-occluded`); writes only on change. */
  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    this.wrapper.classList.toggle('tv-occluded', faded);
  }

  /** @internal Hidden by culling: the next placement decides again whether it fits. */
  cull(): void {
    this.hide();
    this.placement = 0;
  }

  /** @internal */
  hide(): void {
    if (!this.shown) return;
    this.wrapper.style.display = 'none';
    this.shown = false;
  }

  /** @internal */
  detach(): void {
    this.wrapper.removeEventListener('click', this.onClick);
    this.wrapper.removeEventListener('dblclick', this.onDoubleClick);
    this.wrapper.removeEventListener('pointerdown', this.onPointerDown);
    this.wrapper.removeEventListener('contextmenu', this.onContextMenu);
    this.wrapper.remove();
  }
}

/**
 * Screen-space HTML markers anchored to world positions: top cards (顶牌),
 * info panels and pins. Positions are projected on the CPU in float64 every
 * frame, so markers stay glued to their anchor at any scale; culled when
 * behind the camera, beyond the horizon, outside the viewport or outside
 * their distance range.
 */
export class MarkerManager {
  readonly root: HTMLElement;
  readonly stats: MarkerStats = { total: 0, candidates: 0, decluttered: 0, shown: 0, occluded: 0, ms: 0 };
  /**
   * Occlusion queries for markers with `occlusion` set (the viewer assigns
   * its proxies); null = markers are never treated as occluded.
   */
  occlusion: MarkerOcclusion | null = null;
  /** @internal Hides markers whose anchor fails it (set by the viewer: outside a local scene). */
  regionFilter: ((position: Vector3) => boolean) | null = null;
  /**
   * Receives click / dblclick / rightclick on markers with `userData.entity`
   * that have no handler of their own (ThingJS DOM event proxy). The viewer
   * forwards them to `viewer.interaction` as events on that entity.
   */
  eventProxy: ((type: MarkerEventType, marker: Marker, event: MouseEvent) => void) | null = null;
  private readonly markers = new Set<Marker>();
  private readonly candidates: Marker[] = [];
  private readonly unmeasured: Marker[] = [];
  private readonly grid = new CollisionGrid(64);
  private dense = false;
  private lastPlacement = -Infinity;
  private placementRequested = true;
  private pending = false;

  /**
   * @param eventTarget Element that receives wheel events over interactive
   * markers (the canvas), so zooming keeps working with the cursor on a label.
   */
  constructor(container: HTMLElement, eventTarget?: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tv-marker-layer';
    container.append(this.root);
    if (eventTarget) {
      this.root.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          eventTarget.dispatchEvent(new WheelEvent('wheel', e));
        },
        { passive: false },
      );
    }
    // Right clicks on labels should not open the browser menu over the map.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get count(): number {
    return this.markers.size;
  }

  /**
   * @internal A placement was requested (markers added, removed, resized, occlusion changed)
   * or markers still wait for their first placement: the viewer keeps its full frame rate
   * until they are placed (idle frame-rate throttling).
   */
  get busy(): boolean {
    return this.placementRequested || this.pending;
  }

  add(options: MarkerOptions): Marker {
    const marker = new Marker(options, this);
    this.markers.add(marker);
    this.placementRequested = true;
    this.root.append(marker.root);
    return marker;
  }

  remove(marker: Marker): void {
    if (!this.markers.delete(marker)) return;
    this.releaseProxy(marker);
    marker.detach();
  }

  /** Hidden by culling: also gives its occlusion proxy back (the slot is reused by others). */
  private cullMarker(m: Marker): void {
    m.cull();
    this.releaseProxy(m);
  }

  private releaseProxy(m: Marker): void {
    if (m.proxy >= 0) this.occlusion?.release(m.proxy);
    m.proxy = -1;
    m.occlusion.reset();
    m.setFaded(false);
  }

  /**
   * Places the marker's occlusion proxy and returns its (debounced) state;
   * false without occlusion support, for mode 'none' or when the pool is full.
   */
  private occlusionOf(m: Marker, mode: OcclusionMode, p: Vector3, dist: number, fov: number, height: number): boolean {
    const occlusion = this.occlusion;
    if (mode === 'none' || !occlusion) {
      if (m.proxy >= 0) this.releaseProxy(m);
      return false;
    }
    if (m.proxy < 0) m.proxy = occlusion.acquire();
    if (m.proxy < 0) return false;
    occlusion.place(m.proxy, p.x, p.y, p.z, proxyRadius(dist, fov, height));
    const before = m.occlusion.occluded;
    const now = m.occlusion.read(occlusion.occluded(m.proxy));
    // A marker coming out from behind a building is placed at once, not at the next placement tick.
    if (now !== before) this.placementRequested = true;
    return now;
  }

  clear(): void {
    for (const m of [...this.markers]) this.remove(m);
  }

  /** Positions all markers for this frame. */
  update(camera: PerspectiveCamera, width: number, height: number): void {
    const t0 = performance.now();
    const stats = this.stats;
    stats.total = this.markers.size;
    if (this.markers.size === 0) {
      stats.candidates = stats.decluttered = stats.shown = stats.occluded = 0;
      stats.ms = 0;
      this.setDense(false);
      // Nothing to place (a request left over from the last removal would otherwise stay pending).
      this.placementRequested = false;
      this.pending = false;
      return;
    }
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = _vp.elements;
    const csx = _cam.x / WGS84_A;
    const csy = _cam.y / WGS84_A;
    const csz = _cam.z / WGS84_B;
    const candidates = this.candidates;
    candidates.length = 0;
    const fov = camera.getEffectiveFOV();
    let occludedCount = 0;
    for (const m of this.markers) {
      const o = m.options;
      const visible = typeof o.visible === 'function' ? o.visible() : o.visible !== false;
      const p = visible ? (typeof o.position === 'function' ? o.position() : o.position) : null;
      if (!p) {
        this.cullMarker(m);
        continue;
      }
      const dist = p.distanceTo(_cam);
      if ((o.maxDistance !== undefined && dist > o.maxDistance) || (o.minDistance !== undefined && dist < o.minDistance)) {
        this.cullMarker(m);
        continue;
      }
      if (o.horizonCulling !== false && !isScaledSpacePointVisible(p.x / WGS84_A, p.y / WGS84_A, p.z / WGS84_B, csx, csy, csz)) {
        this.cullMarker(m);
        continue;
      }
      if (this.regionFilter && !this.regionFilter(p)) {
        this.cullMarker(m);
        continue;
      }
      const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
      if (w <= 0) {
        this.cullMarker(m);
        continue;
      }
      const nx = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / w;
      const ny = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / w;
      if (nx < -1.2 || nx > 1.2 || ny < -1.2 || ny > 1.2) {
        this.cullMarker(m);
        continue;
      }
      let scale = 1;
      if (o.scaleByDistance) {
        const [near, far, minScale] = o.scaleByDistance;
        const t = Math.min(1, Math.max(0, (dist - near) / Math.max(1e-6, far - near)));
        scale = 1 + (minScale - 1) * t;
      }
      // Occluded anchors: 'hide' leaves the marker out (no obstacle either), 'fade' dims it.
      const mode = effectiveOcclusion(o.occlusion, o.declutter);
      const occluded = this.occlusionOf(m, mode, p, dist, fov, height);
      if (occluded) occludedCount++;
      if (occluded && mode === 'hide') {
        m.hide();
        m.placement = 0;
        continue;
      }
      m.setFaded(occluded && mode === 'fade');
      m.screenX = (nx + 1) * 0.5 * width;
      m.screenY = (1 - ny) * 0.5 * height;
      m.distance = dist;
      m.scale = scale;
      // z-index band per option. Decluttered markers never overlap once placed, so only
      // obstacles are ordered by distance (nearer on top); a distance-based z-index on every
      // marker would restyle all of them on every frame of a zoom.
      m.z = (o.zIndex ?? 0) * 100_000 + (o.declutter === true ? 0 : Math.max(1, 99_999 - Math.round(Math.log2(1 + dist) * 300)));
      // Obstacles (not decluttered) sort before every decluttered marker.
      const priority = typeof o.priority === 'function' ? o.priority() : (o.priority ?? 0);
      m.priority = o.declutter === true ? priority : priority + 1e9;
      candidates.push(m);
    }

    // New or changed elements are measured together (one layout instead of one per marker).
    const unmeasured = this.unmeasured;
    unmeasured.length = 0;
    for (const m of candidates) if (m.needsMeasure) unmeasured.push(m);
    if (unmeasured.length > 0) Marker.measureAll(unmeasured);

    let shown = 0;
    let decluttered = 0;
    const elapsed = t0 - this.lastPlacement;
    if (this.placementRequested || elapsed >= PLACEMENT_INTERVAL || (this.pending && elapsed >= PENDING_INTERVAL)) {
      this.placementRequested = false;
      this.pending = false;
      this.lastPlacement = t0;
      // Obstacles first, then by priority, then nearest first; a decluttered marker is hidden
      // when its box overlaps one already placed.
      candidates.sort((a, b) => b.priority - a.priority || a.distance - b.distance);
      const grid = this.grid;
      grid.reset(width, height);
      for (const m of candidates) {
        const [x0, y0, x1, y1] = m.rect(m.screenX, m.screenY, m.scale);
        if (m.options.declutter && grid.hits(x0, y0, x1, y1)) {
          m.placement = 2;
          m.hide();
          decluttered++;
          continue;
        }
        grid.insert(x0 - GAP, y0 - GAP, x1 + GAP, y1 + GAP);
        m.placement = 1;
        m.place(m.screenX, m.screenY, m.scale, m.z);
        shown++;
      }
    } else {
      // Between placements: keep decisions; markers new in view wait for the next placement.
      for (const m of candidates) {
        if (m.options.declutter && m.placement !== 1) {
          if (m.placement === 0) this.pending = true;
          m.hide();
          decluttered++;
          continue;
        }
        m.place(m.screenX, m.screenY, m.scale, m.z);
        shown++;
      }
    }
    this.setDense(this.dense ? shown > DENSE_OFF : shown > DENSE_ON);
    stats.candidates = candidates.length;
    stats.decluttered = decluttered;
    stats.shown = shown;
    stats.occluded = occludedCount;
    stats.ms = performance.now() - t0;
  }

  /** Runs the collision placement on the next update (e.g. after a selection changes priorities). */
  requestPlacement(): void {
    this.placementRequested = true;
  }

  private setDense(dense: boolean): void {
    if (dense === this.dense) return;
    this.dense = dense;
    this.root.classList.toggle('tv-dense', dense);
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}
