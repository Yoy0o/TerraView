/**
 * Local scene ("sandbox mode", docs/agents/local-scene.md): shows one area of
 * the globe on its own (terrain, imagery, draped vectors and 3D Tiles inside a
 * circle, rectangle, polygon or a tileset's footprint) on a studio background,
 * with walls around it, and keeps the camera around it. A sub-mode of the
 * globe scene, independent of the indoor (BIM) levels.
 *
 * This class orchestrates; the parts live elsewhere: culling and clip
 * materials in `Globe` / `Tiles3DLayer`, the shared clip mask in
 * `regionMask.ts`, the camera bounds in the controller, the walls in
 * `RegionWalls`, the dimmed look in `RegionDimEffect`. The viewer reads the
 * background uniforms and the visibility test each frame.
 */
import { Box3, Color, Matrix4, Sphere, Vector3, type ColorRepresentation, type PerspectiveCamera } from 'three';
import { uniform } from 'three/tsl';
import type { Ellipsoid } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { DEG2RAD, RAD2DEG } from '../core/math';
import type { Globe } from '../globe/Globe';
import type { Tiles3DLayer } from '../tiles3d/Tiles3DLayer';
import type { CameraBounds, GlobeCameraController } from '../viewer/GlobeCameraController';
import { RegionDimEffect } from './RegionDimEffect';
import { RegionWalls } from './RegionWalls';
import { boxFootprint, resolveRegion, type LocalRegion, type ResolvedRegion } from './region';
import { setRegionGpuState, type RegionGpuState } from './regionMask';

/** Area of a local scene: a shape (degrees / meters), or the footprint of a 3D Tiles layer. */
export type LocalSceneRegion = LocalRegion | { type: 'tileset'; layer: Tiles3DLayer };

/** Walls around the area (the sandbox look). */
export interface LocalSceneWallOptions {
  /** Meters from the lowest point of the boundary down to the base (default 2 % of the region diameter, 30–1000 m). */
  depth?: number;
  /** Soil color at the top (default `#8c6b4f`; deeper parts are darker). */
  color?: ColorRepresentation;
  /** Bright line along the top edge (default true). */
  edge?: boolean;
}

/** Camera behavior in a local scene. */
export interface LocalSceneCameraOptions {
  /** Fly to the overview when entering (default true). */
  fit?: boolean;
  /** Overview heading in degrees clockwise from north (default: the current heading). */
  heading?: number;
  /** Overview pitch in degrees, negative looks down (default -35). */
  pitch?: number;
  /** Keep the view on the area (default true): see `CameraBounds`. */
  constrain?: boolean;
  /** How far the view center may leave the area, as a share of the region radius (default 0.25). */
  margin?: number;
  /** Farthest camera distance from the center, as a multiple of the overview distance (default 2). */
  maxRangeScale?: number;
}

export interface LocalSceneOptions {
  region: LocalSceneRegion;
  /**
   * What happens outside the area: `'hide'` (default) neither draws nor loads it; `'dim'` keeps
   * it, darkened and desaturated (no walls, normal background; everything stays loaded).
   */
  outside?: 'hide' | 'dim';
  /**
   * Walls around the area (default true: soil-colored sandbox sides). false keeps them
   * invisible: the area floats on the background like a cut-out patch.
   */
  walls?: boolean | LocalSceneWallOptions;
  /** Background with `outside: 'hide'`: `'studio'` (default, dark gradient), `'space'` (stars and sky) or a color. */
  background?: 'studio' | 'space' | ColorRepresentation;
  /**
   * The globe in the area: `'clip'` (default) or `'hide'` (data that brings its own ground, e.g.
   * photogrammetry; with a tileset region the globe would show through it).
   */
  globe?: 'clip' | 'hide';
  camera?: LocalSceneCameraOptions;
  /** Seconds the outside takes to fade (default 0.8; 0 switches at once). */
  transition?: number;
}

export interface LocalSceneEvents extends Record<string, unknown> {
  /** Entered (or switched to another area): emitted when `enter` is called. */
  enter: { region: ResolvedRegion };
  /** Left: emitted once the outside is back. */
  exit: void;
}

/** @internal What the local scene needs from the viewer. */
export interface LocalSceneHost {
  readonly ellipsoid: Ellipsoid;
  /** The viewer's renderer (the clip mask looks its region up by renderer). */
  readonly renderer: object;
  readonly camera: PerspectiveCamera;
  readonly globe: Globe;
  readonly controller: GlobeCameraController;
  readonly walls: RegionWalls;
  readonly dim: RegionDimEffect;
  tilesets(): readonly Tiles3DLayer[];
  globeShown(): boolean;
  setGlobeShown(shown: boolean): void;
  lighting(): boolean;
  /** World direction towards the sun (this frame). */
  sunDirection(): Vector3;
  /** Ground height (radians in, meters out) and whether it is reliable (`viewer.surfaceHeight`). */
  groundHeight(longitude: number, latitude: number): { height: number; reliable: boolean };
  /** Highest 3D Tiles surface on the vertical through a position (radians), or null. */
  tilesHeight(longitude: number, latitude: number): number | null;
  /** Current view in degrees / meters. */
  getView(): { longitude: number; latitude: number; height: number; heading: number; pitch: number };
  flyTo(view: { longitude: number; latitude: number; height: number; heading: number; pitch: number }, duration?: number): Promise<void>;
  flyToSphere(sphere: Sphere, heading: number, pitch: number, duration: number | undefined, rangeScale: number): Promise<void>;
  requestRender(): void;
}

type Phase = 'off' | 'entering' | 'on' | 'exiting';

interface Settings {
  outside: 'hide' | 'dim';
  walls: boolean;
  wallDepth: number | null;
  wallColor: ColorRepresentation;
  wallEdge: boolean;
  background: 'studio' | 'space' | ColorRepresentation;
  globe: 'clip' | 'hide';
  fit: boolean;
  heading: number | null;
  pitch: number;
  constrain: boolean;
  margin: number;
  maxRangeScale: number;
  transition: number;
}

const DEFAULTS: Settings = {
  outside: 'hide',
  walls: true,
  wallDepth: null,
  wallColor: 0x8c6b4f,
  wallEdge: true,
  background: 'studio',
  globe: 'clip',
  fit: true,
  heading: null,
  pitch: -35,
  constrain: true,
  margin: 0.25,
  maxRangeScale: 2,
  transition: 0.8,
};

/** Walls are rebuilt at most this often while the surface changes (ms). */
const WALL_REBUILD_MS = 150;
/** Time per frame spent on vertical rays into 3D Tiles for the walls (ms). */
const TILE_RAY_BUDGET_MS = 2;
/** A new pass of 3D Tiles wall samples starts this long after tiles changed (ms). */
const TILE_RESAMPLE_MS = 600;
/** Most wall columns (the boundary is walked at the drawn terrain's grid spacing). */
const MAX_WALL_COLUMNS = 8192;
/** Walls stand this far outside the clip boundary (meters, at least, or this share of the radius). */
const WALL_OUTSET_MIN = 0.05;
const WALL_OUTSET_RATIO = 1e-5;
/** How long the ground at the center is looked for before settling for what is known (ms). */
const CENTER_HEIGHT_WAIT_MS = 15_000;

const _v = new Vector3();
const _w = new Vector3();
const _xy = { x: 0, y: 0 };

export class LocalScene {
  readonly events = new EventEmitter<LocalSceneEvents>();
  /** @internal 0..1: how much of the background is the local one (read by the viewer's background node). */
  readonly backgroundAmount = uniform(0);
  /** @internal 1 = plain color background, 0 = studio gradient. */
  readonly backgroundSolid = uniform(0);
  /** @internal Plain background color. */
  readonly backgroundColor = uniform(new Color(0x0a0f18));
  /** @internal Local vertical at the region center (the studio sky's horizon). */
  readonly skyUp = uniform(new Vector3(0, 0, 1));

  private phase: Phase = 'off';
  /** 0 = whole globe, 1 = only the area (eased into `keepOutside`). */
  private progress = 0;
  private resolved: ResolvedRegion | null = null;
  private settings: Settings = { ...DEFAULTS };
  private gpu: RegionGpuState | null = null;
  private previousView: ReturnType<LocalSceneHost['getView']> | null = null;
  private hidGlobe = false;
  private waiters: (() => void)[] = [];
  private enteredAt = 0;
  private centerSettled = false;
  /** Region-frame z range of the content (walls), for the overview sphere. */
  private zRange: [number, number] = [0, 0];
  private baseHeight = 0;
  // Walls.
  private wallsDirty = true;
  private lastWallBuild = -Infinity;
  private lastSurface = NaN;
  private tileXY: Float64Array | null = null;
  private tileHeights: Float64Array | null = null;
  private tileCursor = 0;
  private tilesChangedAt = -Infinity;
  private tilePassDone = true;
  private readonly layerListeners = new Map<Tiles3DLayer, () => void>();

  /** @internal Created by the viewer (`viewer.localScene`). */
  constructor(private readonly host: LocalSceneHost) {}

  /** Entered or entering (not while leaving). */
  get active(): boolean {
    return this.phase === 'entering' || this.phase === 'on';
  }

  /** @internal Anything to do with a local scene on screen (entering, on or leaving). */
  get engaged(): boolean {
    return this.phase !== 'off';
  }

  /** The area shown, or null. */
  get region(): ResolvedRegion | null {
    return this.active ? this.resolved : null;
  }

  /** @internal The outside is (mostly) hidden: picks, markers and labels there are dropped. */
  get hidesOutside(): boolean {
    return this.resolved !== null && this.phase !== 'off' && this.settings.outside === 'hide' && this.keepOutside < 0.5;
  }

  /** @internal Something animates (transition, walls catching up): the viewer keeps drawing. */
  get busy(): boolean {
    return this.phase === 'entering' || this.phase === 'exiting' || (this.phase === 'on' && (this.wallsDirty || !this.tilePassDone));
  }

  /** @internal Ellipsoidal height of the wall base (meters): the ground outside the area. */
  get groundOutside(): number {
    return this.baseHeight;
  }

  private get keepOutside(): number {
    const p = this.progress;
    return 1 - p * p * (3 - 2 * p);
  }

  /** Whether a position (degrees) is in the area (false without a local scene). */
  contains(longitude: number, latitude: number): boolean {
    return this.region?.contains(longitude, latitude) ?? false;
  }

  /** @internal Whether a world point is shown (always true unless the outside is hidden). */
  showsWorld(point: Vector3, margin = 0.5): boolean {
    return !this.hidesOutside || this.resolved!.containsWorld(point, margin);
  }

  /**
   * Shows one area on its own (see `LocalSceneOptions`). Calling it again switches to another
   * area or changes the options. Resolves when the camera has arrived and the outside has
   * faded. Throws `option-invalid` for a bad region (nothing changes then).
   */
  enter(options: LocalSceneOptions): Promise<void> {
    const region = this.resolve(options.region);
    const s = normalize(options);
    const wasOff = this.phase === 'off' || this.phase === 'exiting';
    if (this.phase === 'off') this.previousView = this.host.getView();
    if (wasOff) this.enteredAt = performance.now();
    this.settings = s;
    this.resolved = region;
    this.centerSettled = false;
    this.settleCenter(true);
    this.phase = s.transition > 0 && this.progress < 1 ? 'entering' : 'on';
    if (this.phase === 'on') this.progress = 1;

    // The globe may have to go (photogrammetry with its own ground), or come back.
    if (s.globe === 'hide' && this.host.globeShown()) {
      this.host.setGlobeShown(false);
      this.hidGlobe = true;
    } else if (s.globe === 'clip' && this.hidGlobe) {
      this.host.setGlobeShown(true);
      this.hidGlobe = false;
    }
    this.applyRegion();
    this.applyStyle();
    this.resetWalls();
    this.events.emit('enter', { region });
    this.host.requestRender();

    const flight = s.fit ? this.fit() : Promise.resolve();
    return Promise.all([flight, this.transitionDone()]).then(() => undefined);
  }

  /**
   * Back to the whole globe: the outside fades back in and (with `restoreView`, default true) the
   * camera flies back to where it was before entering. Resolves when done.
   */
  exit(options: { restoreView?: boolean } = {}): Promise<void> {
    if (!this.active) return this.transitionDone();
    const s = this.settings;
    this.phase = s.transition > 0 && this.progress > 0 ? 'exiting' : 'off';
    this.host.controller.bounds = null;
    if (this.hidGlobe) {
      this.host.setGlobeShown(true);
      this.hidGlobe = false;
    }
    const view = this.previousView;
    const flight = options.restoreView !== false && view ? this.host.flyTo(view) : Promise.resolve();
    if (this.phase === 'off') this.finishExit();
    else this.applyRegion();
    this.host.requestRender();
    return Promise.all([flight, this.transitionDone()]).then(() => undefined);
  }

  /** Flies to the overview of the area (see `LocalSceneCameraOptions`); duration in seconds. */
  fit(duration?: number): Promise<void> {
    const r = this.resolved;
    if (!r || !this.active) return Promise.resolve();
    const s = this.settings;
    const heading = s.heading ?? this.host.getView().heading;
    return this.host.flyToSphere(this.boundingSphere(), heading, s.pitch, duration, this.aspectScale());
  }

  /**
   * Changes how the area looks and behaves without entering again (walls, background, camera,
   * transition; not `region`, `outside` or `globe`).
   */
  set(options: Partial<Omit<LocalSceneOptions, 'region' | 'outside' | 'globe'>>): void {
    const s = normalize({ ...this.optionsOf(this.settings), ...options, region: { type: 'circle', center: [0, 0], radius: 1 } });
    this.settings = { ...s, outside: this.settings.outside, globe: this.settings.globe };
    if (!this.active) return;
    this.applyStyle();
    this.applyBounds();
    this.wallsDirty = true;
    this.host.requestRender();
  }

  /** @internal A tileset was added while the scene is on: clip it too. */
  attachLayer(layer: Tiles3DLayer): void {
    this.applyRegionTo(layer);
  }

  /**
   * @internal Per frame, after the globe and the tilesets were updated: transition, ground at
   * the center, walls. Returns true while something animates.
   */
  update(dt: number): boolean {
    if (this.phase === 'off' || !this.resolved) return false;
    this.watchLayers();
    if (this.phase === 'entering' || this.phase === 'exiting') {
      const s = this.settings;
      const step = s.transition > 0 ? dt / s.transition : 1;
      this.progress = this.phase === 'entering' ? Math.min(1, this.progress + step) : Math.max(0, this.progress - step);
      if (this.phase === 'entering' && this.progress >= 1) {
        this.phase = 'on';
        this.applyRegion();
        this.resolveWaiters();
      } else if (this.phase === 'exiting' && this.progress <= 0) {
        this.finishExit();
        return true;
      }
    }
    if (!this.centerSettled) this.settleCenter(false);
    this.updateUniforms();
    if (this.settings.outside === 'hide') this.updateWalls();
    return this.busy;
  }

  /** @internal Releases what the scene holds (viewer disposal). */
  dispose(): void {
    if (this.phase !== 'off') {
      this.phase = 'off';
      this.progress = 0;
      this.finishExit();
    }
    for (const [layer, off] of this.layerListeners) {
      off();
      this.layerListeners.delete(layer);
    }
  }

  // ---------------------------------------------------------------------------

  private resolve(region: LocalSceneRegion): ResolvedRegion {
    if (region?.type === 'tileset') {
      const layer = region.layer;
      const box = layer.ready ? tilesetCorners(layer) : null;
      if (!box) {
        const s = layer.boundingSphere;
        const c = this.host.ellipsoid.cartesianToCartographic(s.center);
        if (!c || !(s.radius > 0)) return resolveRegion({ type: 'circle', center: [NaN, NaN], radius: 0 }, this.host.ellipsoid);
        return resolveRegion({ type: 'circle', center: [c.longitude * RAD2DEG, c.latitude * RAD2DEG], radius: s.radius }, this.host.ellipsoid);
      }
      return resolveRegion({ type: 'polygon', coordinates: boxFootprint(box, this.host.ellipsoid) }, this.host.ellipsoid);
    }
    return resolveRegion(region, this.host.ellipsoid);
  }

  private optionsOf(s: Settings): Omit<LocalSceneOptions, 'region'> {
    return {
      outside: s.outside,
      walls: s.walls ? { depth: s.wallDepth ?? undefined, color: s.wallColor, edge: s.wallEdge } : false,
      background: s.background,
      globe: s.globe,
      camera: { fit: s.fit, heading: s.heading ?? undefined, pitch: s.pitch, constrain: s.constrain, margin: s.margin, maxRangeScale: s.maxRangeScale },
      transition: s.transition,
    };
  }

  /** Puts the region (and the current fade mode) into the globe, the tilesets, the shader and the dim effect. */
  private applyRegion(): void {
    const r = this.resolved;
    const hide = r !== null && this.phase !== 'off' && this.settings.outside === 'hide';
    const cull = hide && this.phase === 'on';
    this.host.globe.setRegion(hide ? r : null, cull);
    for (const layer of this.host.tilesets()) this.applyRegionTo(layer);
    if (hide && r) {
      this.gpu ??= { worldToRegion: r.worldToRegion, kind: r.kind, radius: r.radius, vertices: r.vertices, keepOutside: 1 };
      this.syncGpu();
      setRegionGpuState(this.host.renderer, this.gpu);
    } else {
      setRegionGpuState(this.host.renderer, null);
      this.gpu = null;
    }
    this.host.dim.setRegion(r !== null && this.phase !== 'off' && this.settings.outside === 'dim' ? r : null);
    this.applyBounds();
  }

  private applyRegionTo(layer: Tiles3DLayer): void {
    const r = this.resolved;
    const hide = r !== null && this.phase !== 'off' && this.settings.outside === 'hide';
    layer.setRegion(hide ? r : null, hide && this.phase === 'on');
  }

  private syncGpu(): void {
    const r = this.resolved;
    const g = this.gpu;
    if (!r || !g) return;
    (g as { worldToRegion: unknown }).worldToRegion = r.worldToRegion;
    g.kind = r.kind;
    g.radius = r.radius;
    g.vertices = r.vertices;
  }

  private applyBounds(): void {
    const r = this.resolved;
    const s = this.settings;
    if (!r || !this.active || !s.constrain) {
      this.host.controller.bounds = null;
      return;
    }
    const margin = s.margin * r.radius;
    const bounds: CameraBounds = {
      center: r.toWorld(_v.set(0, 0, 0), new Vector3()),
      referenceHeight: r.centerHeight,
      maxRange: this.overviewRange() * s.maxRangeScale,
      clampFocus: (point, out) => {
        const q = r.toRegion(point, _w);
        if (!r.clampXY(q.x, q.y, margin, _xy)) return false;
        r.toWorld(_v.set(_xy.x, _xy.y, q.z), out);
        return true;
      },
    };
    this.host.controller.bounds = bounds;
  }

  private applyStyle(): void {
    const s = this.settings;
    const walls = this.host.walls;
    walls.setSolid(s.walls);
    walls.setStyle(s.wallColor, s.wallEdge);
    const bg = s.background;
    if (bg !== 'studio' && bg !== 'space') {
      this.backgroundColor.value.set(bg);
      this.backgroundSolid.value = 1;
    } else {
      this.backgroundSolid.value = 0;
    }
    const r = this.resolved;
    if (r) this.host.ellipsoid.geodeticNormal(r.toWorld(_v.set(0, 0, 0)), this.skyUp.value);
  }

  /** Looks for the ground at the center; moves the region frame onto it once known. */
  private settleCenter(first: boolean): void {
    const r = this.resolved;
    if (!r) return;
    const g = this.host.groundHeight(r.longitude * DEG2RAD, r.latitude * DEG2RAD);
    const waited = performance.now() - this.enteredAt > CENTER_HEIGHT_WAIT_MS;
    if (g.reliable || waited || first) {
      if (Math.abs(g.height - r.centerHeight) > 0.5) {
        r.setCenterHeight(g.height);
        this.syncGpu();
        this.host.globe.regionChanged();
        this.applyBounds();
        this.resetWalls();
      }
      if (g.reliable || waited) this.centerSettled = true;
    }
  }

  private updateUniforms(): void {
    const keep = this.keepOutside;
    if (this.gpu) this.gpu.keepOutside = keep;
    const s = this.settings;
    const local = 1 - keep;
    this.backgroundAmount.value = s.outside === 'hide' && s.background !== 'space' ? local : 0;
    this.host.dim.amount = s.outside === 'dim' ? local : 0;
    const walls = this.host.walls;
    walls.setReveal(local);
    walls.mesh.visible = s.outside === 'hide' && this.wallsBuilt && local > 0.001;
    const r = this.resolved!;
    walls.setFrame(r.regionToWorld);
    if (this.host.lighting()) {
      walls.keyLight.value.copy(this.host.sunDirection());
    } else {
      // Map convention: light from the north-west, 45 degrees up.
      walls.keyLight.value.set(-0.5, 0.5, Math.SQRT1_2).transformDirection(r.regionToWorld);
    }
  }

  private wallsBuilt = false;

  private resetWalls(): void {
    this.wallsDirty = true;
    this.lastSurface = NaN;
    this.tileXY = null;
    this.tilePassDone = true;
    this.tilesChangedAt = performance.now() - TILE_RESAMPLE_MS;
  }

  /** Follows tile loading of the tilesets, so walls along 3D Tiles are measured again. */
  private watchLayers(): void {
    for (const layer of this.host.tilesets()) {
      if (this.layerListeners.has(layer)) continue;
      this.layerListeners.set(
        layer,
        layer.events.on('change', () => {
          this.tilesChangedAt = performance.now();
        }),
      );
    }
    for (const [layer, off] of this.layerListeners) {
      if (this.host.tilesets().includes(layer)) continue;
      off();
      this.layerListeners.delete(layer);
    }
  }

  private updateWalls(): void {
    const now = performance.now();
    const layers = this.host.tilesets().filter((l) => l.measurable);
    const globe = this.host.globeShown();
    if (layers.length > 0) {
      // 3D Tiles: fixed columns measured with vertical rays, a time budget per frame.
      if (this.tilePassDone && now - this.tilesChangedAt >= TILE_RESAMPLE_MS && (this.tileXY === null || this.tilesChangedAt > this.lastWallBuild)) {
        this.startTilePass();
      }
      if (!this.tilePassDone) this.continueTilePass(now);
      if (this.tilePassDone && this.wallsDirty) this.buildWalls(now);
      return;
    }
    this.tileXY = null;
    if (!globe) return;
    const sig = this.host.globe.surfaceSignature;
    if (sig !== this.lastSurface) this.wallsDirty = true;
    if (this.wallsDirty && now - this.lastWallBuild >= WALL_REBUILD_MS) {
      this.lastSurface = sig;
      this.buildWalls(now);
    }
  }

  private startTilePass(): void {
    const r = this.resolved!;
    const perimeter = this.perimeter();
    this.tileXY = r.boundaryPoints(Math.max(3, perimeter / 1024), 1024);
    this.tileHeights = new Float64Array(this.tileXY.length / 2).fill(NaN);
    this.tileCursor = 0;
    this.tilePassDone = false;
  }

  private continueTilePass(now: number): void {
    const xy = this.tileXY!;
    const heights = this.tileHeights!;
    const n = xy.length / 2;
    const r = this.resolved!;
    while (this.tileCursor < n && performance.now() - now < TILE_RAY_BUDGET_MS) {
      const i = this.tileCursor++;
      const c = this.host.ellipsoid.cartesianToCartographic(r.toWorld(_v.set(xy[i * 2], xy[i * 2 + 1], 0)));
      if (c) heights[i] = this.host.tilesHeight(c.longitude, c.latitude) ?? NaN;
    }
    if (this.tileCursor >= n) {
      this.tilePassDone = true;
      this.wallsDirty = true;
    }
  }

  private perimeter(): number {
    const r = this.resolved!;
    if (r.kind === 'circle') return 2 * Math.PI * r.radius;
    const v = r.vertices;
    const n = v.length / 2;
    let p = 0;
    for (let i = 0; i < n; i++) p += Math.hypot(v[((i + 1) % n) * 2] - v[i * 2], v[((i + 1) % n) * 2 + 1] - v[i * 2 + 1]);
    return p;
  }

  /** Measures the surface along the boundary and rebuilds the wall geometry. */
  private buildWalls(now: number): void {
    this.wallsDirty = false;
    this.lastWallBuild = now;
    const r = this.resolved!;
    const host = this.host;
    const globe = host.globeShown() ? host.globe : null;
    const xs: number[] = [];
    const ys: number[] = [];
    const tops: number[] = [];
    const h0s: number[] = [];
    const sample = (x: number, y: number, tilesHeight: number): number => {
      const c = host.ellipsoid.cartesianToCartographic(r.toWorld(_v.set(x, y, 0)));
      if (!c) return Infinity;
      const s = globe?.sampleRenderedHeight(c.longitude, c.latitude) ?? null;
      let h = s ? s.height : NaN;
      if (Number.isFinite(tilesHeight)) h = Number.isFinite(h) ? Math.max(h, tilesHeight) : tilesHeight;
      xs.push(x);
      ys.push(y);
      tops.push(h);
      h0s.push(c.height);
      return s ? s.cellSize : Infinity;
    };
    if (this.tileXY && this.tileHeights) {
      const xy = this.tileXY;
      for (let i = 0; i < xy.length / 2; i++) sample(xy[i * 2], xy[i * 2 + 1], this.tileHeights[i]);
    } else {
      // Walk the boundary at the grid spacing of the terrain drawn there, so the wall top follows it.
      const perimeter = this.perimeter();
      const base = r.boundaryPoints(perimeter / 512, 1024);
      const minStep = perimeter / MAX_WALL_COLUMNS;
      const n = base.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = base[i * 2];
        const ay = base[i * 2 + 1];
        const bx = base[((i + 1) % n) * 2];
        const by = base[((i + 1) % n) * 2 + 1];
        const cell = sample(ax, ay, NaN);
        const len = Math.hypot(bx - ax, by - ay);
        const k = Math.min(64, Math.max(1, Math.ceil(len / Math.max(minStep, Number.isFinite(cell) ? cell : len))));
        for (let j = 1; j < k; j++) sample(ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k, NaN);
      }
    }
    const n = xs.length;
    if (!fillGaps(tops)) {
      this.wallsBuilt = false;
      this.host.walls.mesh.visible = false;
      return;
    }
    let lowest = Infinity;
    for (const h of tops) lowest = Math.min(lowest, h);
    const s = this.settings;
    const depth = s.wallDepth ?? Math.min(1000, Math.max(30, r.radius * 2 * 0.02));
    this.baseHeight = lowest - depth;
    const xy = new Float64Array(n * 2);
    const top = new Float32Array(n);
    const bottom = new Float32Array(n);
    const topHeight = new Float32Array(n);
    let zMin = Infinity;
    let zMax = -Infinity;
    // A hair outside the clip boundary: tile skirts end there, and would otherwise cut through
    // the wall plane in a dotted line (two surfaces at the same depth). Far below a pixel.
    const outset = Math.max(WALL_OUTSET_MIN, r.radius * WALL_OUTSET_RATIO);
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      const next = (i + 1) % n;
      let nx = ys[next] - ys[prev];
      let ny = -(xs[next] - xs[prev]);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      // Pointing out of the region whichever way the loop runs.
      if (r.signedDistance(xs[i] + nx, ys[i] + ny) > r.signedDistance(xs[i] - nx, ys[i] - ny)) {
        nx = -nx;
        ny = -ny;
      }
      xy[i * 2] = xs[i] + nx * outset;
      xy[i * 2 + 1] = ys[i] + ny * outset;
      // The prism axis is the center's vertical: a height difference is a z difference to well under 0.1 %.
      top[i] = tops[i] - h0s[i];
      bottom[i] = this.baseHeight - h0s[i];
      topHeight[i] = tops[i];
      zMin = Math.min(zMin, bottom[i]);
      zMax = Math.max(zMax, top[i]);
    }
    this.zRange = [zMin, zMax];
    this.host.walls.setColumns({ xy, top, bottom, topHeight, baseHeight: this.baseHeight });
    this.wallsBuilt = true;
    this.host.requestRender();
  }

  private boundingSphere(): Sphere {
    const r = this.resolved!;
    const [zMin, zMax] = this.zRange;
    const center = r.toWorld(new Vector3(0, 0, (zMin + zMax) / 2));
    return new Sphere(center, Math.hypot(r.radius, (zMax - zMin) / 2));
  }

  /** Extra distance for views narrower than tall (the overview fits the vertical field of view). */
  private aspectScale(): number {
    const cam = this.host.camera;
    const v = (cam.getEffectiveFOV() * DEG2RAD) / 2;
    const h = Math.atan(Math.tan(v) * cam.aspect);
    return h < v ? Math.sin(v) / Math.sin(h) : 1;
  }

  /** Camera distance of the overview (as `flyToSphere` computes it). */
  private overviewRange(): number {
    const v = (this.host.camera.getEffectiveFOV() * DEG2RAD) / 2;
    return (this.boundingSphere().radius / Math.sin(v)) * this.aspectScale() * 1.15;
  }

  private transitionDone(): Promise<void> {
    if (this.phase !== 'entering' && this.phase !== 'exiting') return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private resolveWaiters(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private finishExit(): void {
    this.phase = 'off';
    this.progress = 0;
    this.host.globe.setRegion(null, false);
    for (const layer of this.host.tilesets()) layer.setRegion(null, false);
    setRegionGpuState(this.host.renderer, null);
    this.gpu = null;
    this.host.dim.setRegion(null);
    this.host.dim.amount = 0;
    this.host.controller.bounds = null;
    this.backgroundAmount.value = 0;
    this.host.walls.mesh.visible = false;
    this.wallsBuilt = false;
    if (this.hidGlobe) {
      this.host.setGlobeShown(true);
      this.hidGlobe = false;
    }
    this.resolved = null;
    this.previousView = null;
    this.resolveWaiters();
    this.events.emit('exit', undefined);
    this.host.requestRender();
  }
}

function normalize(o: Partial<LocalSceneOptions>): Settings {
  const s: Settings = { ...DEFAULTS };
  if (o.outside === 'dim' || o.outside === 'hide') s.outside = o.outside;
  if (o.walls === false) s.walls = false;
  else if (o.walls && typeof o.walls === 'object') {
    s.walls = true;
    if (o.walls.depth !== undefined && Number.isFinite(o.walls.depth) && o.walls.depth > 0) s.wallDepth = o.walls.depth;
    if (o.walls.color !== undefined) s.wallColor = o.walls.color;
    if (o.walls.edge !== undefined) s.wallEdge = o.walls.edge;
  }
  if (o.background !== undefined) s.background = o.background;
  if (o.globe === 'hide' || o.globe === 'clip') s.globe = o.globe;
  const c = o.camera ?? {};
  if (c.fit !== undefined) s.fit = c.fit;
  if (c.heading !== undefined && Number.isFinite(c.heading)) s.heading = c.heading;
  if (c.pitch !== undefined && Number.isFinite(c.pitch)) s.pitch = Math.max(-90, Math.min(-1, c.pitch));
  if (c.constrain !== undefined) s.constrain = c.constrain;
  if (c.margin !== undefined && c.margin >= 0) s.margin = c.margin;
  if (c.maxRangeScale !== undefined && c.maxRangeScale >= 1) s.maxRangeScale = c.maxRangeScale;
  if (o.transition !== undefined && o.transition >= 0) s.transition = o.transition;
  return s;
}

/** Fills NaN heights from the nearest valid neighbor along the loop; false when none is valid. */
function fillGaps(h: number[]): boolean {
  const n = h.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(h[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return false;
  let last = h[first];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (Number.isFinite(h[i])) last = h[i];
    else h[i] = last;
  }
  return true;
}

/** The 8 world (ECEF) corners of a tileset's oriented bounding box, or null before it loaded. */
function tilesetCorners(layer: Tiles3DLayer): Vector3[] | null {
  const box = new Box3();
  const matrix = new Matrix4();
  if (!layer.tiles.getOrientedBoundingBox(box, matrix)) return null;
  matrix.premultiply(layer.group.matrixWorld);
  const corners: Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(matrix));
  }
  return corners;
}
