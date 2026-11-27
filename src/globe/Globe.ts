/**
 * The quadtree globe (`viewer.globe`): configuration, the per-frame update and tile selection,
 * cache eviction and height / ray queries. Its parts get what they need through narrow host
 * interfaces (the globe passes itself):
 *
 *   TileLoader   request scheduling: priority queues, concurrency, prefetch, upload budget
 *   TileContent  applying loaded content: imagery reveal and cross-fades, terrain morphs
 *   PolarCaps    the caps closing the poles
 *
 * Selection rules are in tileSelection.ts (pure functions, unit tested).
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Ray,
  SRGBColorSpace,
  type Sphere,
  Vector3,
} from 'three';
import { Ellipsoid, cartographic, type Cartographic } from '../core/Ellipsoid';
import type { TerraViewError } from '../core/errors';
import { geodeticToEcef, isScaledSpacePointVisible, WGS84_A } from '../core/geodesy';
import { clamp, wrapPi } from '../core/math';
import { RegionRelation, type ResolvedRegion } from '../region/region';
import { GlobeTile, MIN_LEVEL, SharedTexture } from './GlobeTile';
import { PolarCaps } from './PolarCaps';
import { TileContent } from './TileContent';
import { B_ANCHOR, B_BLOCKING, B_LOW, B_RENDERED, B_URGENT, TileLoader } from './TileLoader';
import { EMPTY_OVERLAY, MORPH_ATTRIBUTE, refreshTileMaterials, type TileMaterial } from './TileMaterial';
import type { TileOverlaySource } from './overlay';
import { WebMercatorTilingScheme } from './TilingScheme';
import type { ImageryProvider } from './imagery/ImageryProvider';
import type { TerrainSource } from './terrain/TerrainSource';
import { extractQuads, quadrantQuads } from './tileMeshLayout';
import { fogRelaxedError, horizonFogDensity, refinesNow, selectionIn, TileSelection, wouldLoseDetail } from './tileSelection';

export interface GlobeOptions {
  imagery: ImageryProvider;
  terrain?: TerrainSource | null;
  terrainExaggeration?: number;
  /** Refine until one imagery texel covers at most this many CSS pixels. */
  maxScreenSpaceError?: number;
  maxCachedTiles?: number;
  /** Concurrent imagery downloads (HTTP/2 tile servers handle 20-30 well). */
  maxConcurrentLoads?: number;
  /** Concurrent terrain mesh jobs. */
  maxConcurrentGeometry?: number;
  /** Grid cells per tile edge. */
  segments?: number;
  maxAnisotropy?: number;
  /** Seconds to cross-fade to better imagery (a sharper ancestor or the tile's own; 0 = pop in). Default 0.5. */
  fadeDuration?: number;
  /**
   * Seconds to morph terrain from the surface that was on screen to a tile's
   * new mesh (interim to exact terrain, parent to children, children to
   * parent), so level-of-detail changes do not make the ground jump. 0 = snap.
   */
  morphDuration?: number;
  /**
   * Horizon fog (CesiumJS): with the camera low and looking towards the
   * horizon, tiles in the haze refine less; a tile in full fog needs
   * `1 + factor` times `maxScreenSpaceError` to refine. 0 disables. Default 1.
   */
  fogScreenSpaceErrorFactor?: number;
  /**
   * Build interpolated meshes for the children of refined tiles that are just
   * outside the view, so panning or zooming out does not fall back to the
   * parent when they come into view (CesiumJS `preloadSiblings`, limited to
   * meshes that need no download). Default true.
   */
  preloadSiblings?: boolean;
  /**
   * While no drawn tile waits for imagery, download the next level's imagery
   * around the view center into the browser's HTTP cache (no decoding, no GPU
   * upload; at most `PREFETCH_MAX_ACTIVE` requests), so zooming in shows the
   * final imagery almost at once. Providers opt out with `prefetch: false`.
   * Default true.
   */
  prefetchImagery?: boolean;
}

export interface GlobeStats {
  rendered: number;
  cached: number;
  /** Requests in flight (all channels). */
  loading: number;
  /** Requests waiting for a free slot. */
  queued: number;
  maxLevel: number;
  /** Rendered tiles still showing a magnified ancestor or the placeholder. */
  waitingImagery: number;
  /** Rendered tiles finer than needed, kept until a coarser ancestor can replace them without losing detail. */
  keptForDetail: number;
  /** Parent quadrants drawn in place of children whose mesh is not ready yet. */
  fills: number;
  /** Rendered tiles holding back better imagery, to reveal it together with their siblings (or with sharper ancestors). */
  heldImagery: number;
  /** Next-level imagery downloads in flight into the HTTP cache. */
  prefetching: number;
}

const IMAGERY_TILE_SIZE = 256;
const MAX_LEVEL = 22;
const TERRAIN_MAX_HEIGHT = 8900;
/** Lowest ellipsoidal height of the geoid-corrected sea surface (EGM96 minimum is about -107 m). */
const TERRAIN_MIN_HEIGHT = -120;

/** Rendered tiles whose fallback is this many levels coarser get an intermediate ancestor loaded first. */
const ANCHOR_GAP = 3;
/**
 * Interim meshes are interpolated from an ancestor with real terrain at most
 * this many levels up; deeper tiles wait for their data (coarser estimates are
 * too far off in mountains and produce visible steps).
 */
const MAX_UPSAMPLE_LEVELS = 3;

const _projScreen = new Matrix4();
const _p = [0, 0, 0];
const _v = new Vector3();
const _localRay = new Ray();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _hit = new Vector3();

/**
 * Quadtree globe surface: Web Mercator tiles with terrain, imagery and a
 * draped overlay.
 *
 * Loading model (docs/agents/tile-loading.md):
 * - geometry, imagery and overlay are independent channels with their own
 *   concurrency limits, so slow terrain never holds back imagery;
 * - a tile is renderable as soon as it has a mesh; imagery falls back to the
 *   closest ancestor (magnified) or a placeholder, and cross-fades in when the
 *   tile's own texture arrives;
 * - child meshes can be upsampled from the parent's heights, so refinement
 *   does not wait on the network; the exact terrain replaces them later;
 * - requests are sorted into priority buckets, then by distance from the view
 *   center (foveated), so what the user looks at loads first;
 * - finished loads are applied under a per-frame budget;
 * - selection remembers the previous frame (CesiumJS): a coarser tile replaces
 *   its descendants only once it shows as much detail as they did, so zooming
 *   out never flashes a blurry ancestor.
 *
 * @advanced Reached as `viewer.globe` and created by the viewer: swap
 * imagery and terrain, read `stats`, tune the loading properties. Members
 * the viewer drives each frame are internal.
 */
export class Globe {
  /** @internal */
  readonly group = new Group();
  /** @internal */
  readonly scheme = new WebMercatorTilingScheme();
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly stats: GlobeStats = { rendered: 0, cached: 0, loading: 0, queued: 0, maxLevel: 0, waitingImagery: 0, keptForDetail: 0, fills: 0, heldImagery: 0, prefetching: 0 };
  /**
   * @internal Hash of the drawn surface (tile meshes and fills, their geometries and
   * morph values), updated by `update()`: changes whenever the shape on
   * screen may have changed, even at equal draw and triangle counts (the GPU
   * pick buffer uses it to know its depth is out of date).
   */
  surfaceSignature = 0;

  maxScreenSpaceError: number;
  maxCachedTiles: number;
  maxConcurrentLoads: number;
  maxConcurrentGeometry: number;
  fadeDuration: number;
  /** See `GlobeOptions.morphDuration` (seconds, 0 disables). */
  morphDuration: number;
  /** See `GlobeOptions.fogScreenSpaceErrorFactor` (0 disables). */
  fogScreenSpaceErrorFactor: number;
  /** See `GlobeOptions.preloadSiblings`. */
  preloadSiblings: boolean;
  /** See `GlobeOptions.prefetchImagery`. */
  prefetchImagery: boolean;
  /** Stop refining and loading (debug). */
  freeze = false;
  /** @internal Bumped whenever the local scene region or its mode changes (tiles re-decide their clip state). */
  regionGen = 0;
  /**
   * Called once per provider when its imagery requests keep failing (after 3 failures), with an
   * `imagery-unreachable` error (`details.provider`, `details.reason`).
   */
  onImageryError: ((error: TerraViewError) => void) | null = null;
  /** Last reported imagery failure for the current provider (null when healthy). */
  imageryError: TerraViewError | null = null;
  /**
   * Last reported terrain failure for the current terrain source (null when healthy): a
   * `terrain-unreachable` error after 3 failed tile builds (`details.source`, `details.reason`).
   * Tiles that fail keep their previous mesh and are retried with backoff.
   */
  terrainError: TerraViewError | null = null;
  /** @internal The viewer's listener for imagery and terrain failures (`viewer.events` 'error'). */
  reportError: ((source: 'imagery' | 'terrain', error: TerraViewError) => void) | null = null;
  /** @internal Request scheduling: queues, concurrency, prefetch, upload budget. */
  readonly loader: TileLoader;
  /** @internal Applying loaded content: imagery reveal and cross-fades, terrain morphs. */
  readonly content: TileContent;
  /** @internal */
  readonly polarCaps: PolarCaps;

  // State the parts read (internal).
  /** @internal */
  wireframe = false;
  /** @internal */
  imagery: ImageryProvider;
  /** @internal */
  terrain: TerrainSource | null;
  /** @internal */
  exaggeration: number;
  /** @internal */
  readonly segments: number;
  /** @internal */
  readonly maxAnisotropy: number;
  private readonly roots: GlobeTile[] = [];
  /** @internal Tiles holding content (the cache). */
  readonly loaded = new Set<GlobeTile>();
  /** @internal Tiles drawn this frame. */
  renderList: GlobeTile[] = [];
  private prevRenderList: GlobeTile[] = [];
  /** Quadrant meshes drawn this frame for children without a mesh yet (see `GlobeTile.fills`). */
  private fillList: Mesh[] = [];
  private prevFillList: Mesh[] = [];
  /** @internal Frame counter and `performance.now()` of the current update. */
  frame = 0;
  /** @internal */
  now = 0;
  /** @internal Generations of the imagery provider and the terrain source (bumped when they change). */
  imageryGen = 0;
  /** @internal */
  geometryGen = 0;
  /** @internal Imagery shown while a tile has none of its own or an ancestor's. */
  readonly placeholder: SharedTexture;
  /** @internal */
  overlaySource: TileOverlaySource | null = null;
  /** @internal */
  readonly emptyOverlay: SharedTexture;

  // Per-frame camera state.
  private readonly frustum = new Frustum();
  private readonly cameraPosition = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraCarto: Cartographic = cartographic();
  private readonly cameraScaled = new Vector3();
  private horizonCulling = true;
  private sseFactor = 1;
  private halfFovDiagonal = 0.6;
  /** Horizon fog density for this frame (per meter, 0 = none). */
  private fogDensity = 0;

  // Local scene (docs/agents/local-scene.md §4.1).
  private region: ResolvedRegion | null = null;
  /** Tiles outside the region are culled (else all tiles draw, clipped: the enter / exit transition). */
  private regionCull = false;

  constructor(options: GlobeOptions) {
    this.loader = new TileLoader(this);
    this.content = new TileContent(this);
    this.imagery = options.imagery;
    this.terrain = options.terrain ?? null;
    this.exaggeration = options.terrainExaggeration ?? 1;
    this.maxScreenSpaceError = options.maxScreenSpaceError ?? 1.25;
    this.maxCachedTiles = options.maxCachedTiles ?? 700;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 24;
    this.maxConcurrentGeometry = options.maxConcurrentGeometry ?? 12;
    this.segments = options.segments ?? 32;
    this.maxAnisotropy = options.maxAnisotropy ?? 8;
    this.fadeDuration = options.fadeDuration ?? 0.5;
    this.morphDuration = options.morphDuration ?? 0.4;
    this.fogScreenSpaceErrorFactor = options.fogScreenSpaceErrorFactor ?? 1;
    this.preloadSiblings = options.preloadSiblings ?? true;
    this.prefetchImagery = options.prefetchImagery ?? true;
    this.group.name = 'Globe';

    const placeholderTex = new DataTexture(new Uint8Array([28, 46, 72, 255]), 1, 1);
    placeholderTex.colorSpace = SRGBColorSpace;
    placeholderTex.needsUpdate = true;
    this.placeholder = new SharedTexture(placeholderTex, -1, 0, 0, 4).acquire();
    this.emptyOverlay = new SharedTexture(EMPTY_OVERLAY, -1, 0, 0, 4).acquire();

    const n = this.scheme.tilesAtLevel(MIN_LEVEL);
    const lo = this.terrain ? TERRAIN_MIN_HEIGHT : 0;
    const hi = this.terrain ? TERRAIN_MAX_HEIGHT : 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) this.roots.push(new GlobeTile(MIN_LEVEL, x, y, null, this.scheme, lo, hi));
    }
    this.polarCaps = new PolarCaps(this);
  }

  // ---------------------------------------------------------------------------
  // Configuration

  get imageryProvider(): ImageryProvider {
    return this.imagery;
  }

  get terrainSource(): TerrainSource | null {
    return this.terrain;
  }

  get terrainExaggeration(): number {
    return this.exaggeration;
  }

  setImagery(provider: ImageryProvider): void {
    if (provider === this.imagery) return;
    this.imagery.dispose?.();
    this.imagery = provider;
    this.imageryGen++;
    this.loader.imageryErrors = 0;
    this.imageryError = null;
    this.polarCaps.capColors[0].clear();
    this.polarCaps.capColors[1].clear();
    for (const t of this.loader.active.img) t.img.loading?.abort();
    this.loader.resetPrefetch();
  }

  /** @internal Drapes a tile overlay source (the viewer's `overlays`) over the imagery. */
  setOverlaySource(source: TileOverlaySource | null): void {
    if (source === this.overlaySource) return;
    this.overlaySource = source;
    this.forEachTile((t) => {
      t.ovl.loading?.abort();
      t.ownOverlay?.release();
      t.ownOverlay = null;
      t.overlayGen = -1;
      this.content.resolveOverlay(t);
    });
  }

  setTerrain(source: TerrainSource | null, exaggeration = this.exaggeration): void {
    if (source === this.terrain && exaggeration === this.exaggeration) return;
    if (source !== this.terrain) {
      this.loader.terrainErrors = 0;
      this.terrainError = null;
    }
    this.terrain = source;
    this.exaggeration = exaggeration;
    this.geometryGen++;
    for (const t of this.loader.active.geo) t.geo.loading?.abort();
    if (!source) {
      // Flat globe: bounds are exact without waiting for data.
      this.forEachTile((t) => {
        if (!t.mesh || t.geometryGen !== this.geometryGen) {
          t.minHeight = 0;
          t.maxHeight = 0;
          t.estimateBounds();
        }
      });
    } else {
      for (const r of this.roots) {
        if (r.geometryGen !== this.geometryGen) {
          r.minHeight = Math.min(r.minHeight, TERRAIN_MIN_HEIGHT);
          r.maxHeight = Math.max(r.maxHeight, TERRAIN_MAX_HEIGHT * exaggeration);
          r.estimateBounds();
        }
      }
    }
  }

  /**
   * @internal Local scene region (null: the whole globe). With `cull`, tiles outside it are
   * neither drawn nor loaded and only tiles crossing its boundary are clipped; without, every
   * tile is drawn with the clip material (the outside fades through `keepOutside`).
   */
  setRegion(region: ResolvedRegion | null, cull: boolean): void {
    if (region === this.region && cull === this.regionCull) return;
    this.region = region;
    this.regionCull = region !== null && cull;
    this.regionGen++;
    for (const cap of this.polarCaps.caps) cap.visible = region === null;
  }

  /** @internal Bumps the clip state of every tile (the region moved, e.g. to the ground height at its center). */
  regionChanged(): void {
    this.regionGen++;
  }

  /** @internal Whether a tile is outside the culling region. */
  outsideRegion(tile: GlobeTile): boolean {
    return this.regionCull && this.region!.relateSphere(tile.boundingSphere.center, tile.boundingSphere.radius) === RegionRelation.OUTSIDE;
  }

  /** Picks the plain or the clipped material for a tile about to be drawn. */
  private updateClip(tile: GlobeTile): void {
    if (tile.regionGen === this.regionGen) return;
    tile.regionGen = this.regionGen;
    const r = this.region;
    const clipped = r !== null && (!this.regionCull || r.relateSphere(tile.boundingSphere.center, tile.boundingSphere.radius) !== RegionRelation.INSIDE);
    tile.setClipped(clipped);
  }

  // ---------------------------------------------------------------------------
  // Per-frame update

  /** @internal Imagery cross-fades or terrain morphs in progress: the picture changes from frame to frame. */
  get animating(): boolean {
    return this.content.fading.size > 0 || this.content.morphing.size > 0;
  }

  /** @internal Called by the viewer every frame while the globe is shown. */
  update(camera: PerspectiveCamera, viewportHeightCss: number): void {
    // Frozen: keep the previous selection so it can be inspected from elsewhere.
    if (this.freeze) return;
    this.frame++;
    this.now = performance.now();
    this.prepareCamera(camera, viewportHeightCss);
    // Upload what finished since the last frame first, so this traversal can use it.
    this.loader.applyReady();

    this.renderList = [];
    this.fillList = [];
    for (const q of Object.values(this.loader.queues)) q.length = 0;
    for (const root of this.roots) this.visit(root, false);

    // Toggle visibility instead of re-parenting meshes.
    for (const t of this.prevRenderList) if (t.mesh) t.mesh.visible = false;
    for (const f of this.prevFillList) f.visible = false;
    for (const f of this.fillList) {
      f.visible = true;
      // A fill draws its tile's material: keep that tile's picture current although the tile is not drawn itself.
      const t = f.userData.globeTile as GlobeTile;
      this.updateClip(t);
      if (!t.ownImagery || t.imageryGen !== this.imageryGen) this.content.resolveImagery(t, false);
      if (this.overlaySource && (t.overlayGen !== this.overlaySource.version || t.overlay !== (t.ownOverlay ?? this.emptyOverlay))) {
        this.content.resolveOverlay(t);
      }
    }
    this.prevFillList = this.fillList;
    let maxLevel = 0;
    let waiting = 0;
    let kept = 0;
    let held = 0;
    for (const t of this.renderList) {
      if (t.mesh) t.mesh.visible = true;
      this.updateClip(t);
      // `lastRenderedFrame` still says whether the tile was on screen in the previous frame.
      if (t.lastRenderedFrame !== this.frame - 1) this.content.showNewTile(t);
      else if (this.content.updateShownImagery(t)) held++;
      t.lastRenderedFrame = this.frame;
      if (this.overlaySource && (t.overlayGen !== this.overlaySource.version || t.overlay !== (t.ownOverlay ?? this.emptyOverlay))) {
        this.content.resolveOverlay(t);
      }
      // Tiles kept only to preserve detail are about to be replaced: do not load for them.
      if (t.keptForDetail) kept++;
      else if (this.queueRenderedContent(t)) waiting++;
      maxLevel = Math.max(maxLevel, t.level);
    }
    this.prevRenderList = this.renderList;

    this.loader.cancelStaleLoads();
    this.loader.dispatch('geo', this.maxConcurrentGeometry);
    // HTTP/1.1 imagery servers take only a few requests at once: dispatch no more than that, so
    // the rest wait in the priority queue (which is re-sorted every frame) instead of the browser's.
    const imageryLimit = Math.min(this.maxConcurrentLoads, this.imagery.maxConcurrentRequests ?? Infinity);
    this.loader.dispatch('img', Math.max(1, imageryLimit - this.loader.prefetchActive));
    this.loader.prefetchNextLevel(imageryLimit);
    this.loader.dispatch('ovl', Math.max(4, Math.floor(this.maxConcurrentLoads / 3)));
    this.content.updateFades();
    this.content.updateMorphs();
    if (this.frame % 30 === 0) this.evict();

    this.stats.rendered = this.renderList.length;
    this.stats.cached = this.loaded.size;
    this.stats.loading = this.loader.active.geo.size + this.loader.active.img.size + this.loader.active.ovl.size;
    this.stats.queued = this.loader.queues.geo.length + this.loader.queues.img.length + this.loader.queues.ovl.length - this.stats.loading;
    this.stats.queued = Math.max(0, this.stats.queued);
    this.stats.maxLevel = maxLevel;
    this.stats.waitingImagery = waiting;
    this.stats.keptForDetail = kept;
    this.stats.heldImagery = held;
    this.stats.prefetching = this.loader.prefetchActive;
    this.stats.fills = this.fillList.length;
    let h = this.renderList.length;
    for (const t of this.renderList) {
      const m = t.mesh;
      if (m) h = (Math.imul(h, 31) + m.id * 7 + m.geometry.id * 13 + Math.round(t.material.morph * 4096)) | 0;
    }
    for (const f of this.fillList) h = (Math.imul(h, 31) + f.id * 7 + f.geometry.id * 13) | 0;
    // The wireframe switch changes the picture of the same meshes (still views are held until the signature changes).
    if (this.wireframe) h = ~h;
    this.surfaceSignature = h;
  }

  private prepareCamera(camera: PerspectiveCamera, viewportHeightCss: number): void {
    camera.updateMatrixWorld();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, camera.reversedDepth);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.cameraForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this.ellipsoid.cartesianToCartographic(this.cameraPosition, this.cameraCarto);
    this.cameraScaled.copy(this.cameraPosition).multiply(this.ellipsoid.oneOverRadii);
    // Below/near the ellipsoid (e.g. with terrain under sea level) the occluder is unreliable.
    this.horizonCulling = this.cameraCarto.height > 100;
    const fov = (camera.getEffectiveFOV() * Math.PI) / 180;
    this.sseFactor = viewportHeightCss / (2 * Math.tan(fov / 2));
    this.halfFovDiagonal = Math.atan(Math.tan(fov / 2) * Math.hypot(1, camera.aspect));
    // Horizon fog: only for low cameras looking towards the horizon (zero when looking straight down).
    const up = this.ellipsoid.geodeticNormal(this.cameraPosition, _v);
    this.fogDensity = this.fogScreenSpaceErrorFactor > 0 ? horizonFogDensity(this.cameraCarto.height, this.cameraForward.dot(up)) : 0;
  }

  private get maxLevel(): number {
    return Math.min(MAX_LEVEL, Math.max(this.imagery.maxZoom, this.terrain ? this.terrain.maxZoom : 0));
  }

  /** Frustum and horizon test, cached per frame (a parent tests its children before visiting them). */
  private isVisible(tile: GlobeTile): boolean {
    if (tile.cullFrame === this.frame) return tile.inView;
    tile.cullFrame = this.frame;
    tile.inView = this.testVisible(tile);
    return tile.inView;
  }

  private testVisible(tile: GlobeTile): boolean {
    if (!this.frustum.intersectsSphere(tile.boundingSphere)) return false;
    const hp = tile.horizonPoint;
    if (this.horizonCulling && hp) {
      const cs = this.cameraScaled;
      if (!isScaledSpacePointVisible(hp.x, hp.y, hp.z, cs.x, cs.y, cs.z)) return false;
    }
    return !this.outsideRegion(tile);
  }

  /** Approximate distance from the camera to the closest point of the tile. */
  private tileDistance(tile: GlobeTile): number {
    const c = this.cameraCarto;
    const sphereDist = this.cameraPosition.distanceTo(tile.boundingSphere.center) - tile.boundingSphere.radius;
    if (sphereDist > tile.boundingSphere.radius * 2) return sphereDist;
    const { west, east, south, north } = tile.rect;
    const cx = (west + east) / 2;
    const half = (east - west) / 2;
    const lon = cx + clamp(wrapPi(c.longitude - cx), -half, half);
    const lat = clamp(c.latitude, south, north);
    const h = clamp(c.height, tile.minHeight, tile.maxHeight);
    geodeticToEcef(lon, lat, h, _p);
    return Math.max(1, _v.set(_p[0], _p[1], _p[2]).distanceTo(this.cameraPosition));
  }

  /** @internal Size of one imagery texel on screen in CSS pixels, relaxed in the horizon fog. */
  computeSSE(tile: GlobeTile): number {
    const groundSize = (2 * Math.PI * WGS84_A * Math.cos(tile.latForResolution)) / 2 ** tile.level;
    const texel = groundSize / IMAGERY_TILE_SIZE;
    const sse = (texel * this.sseFactor) / tile.distance;
    return fogRelaxedError(sse, tile.distance, this.fogDensity, this.maxScreenSpaceError, this.fogScreenSpaceErrorFactor);
  }

  /** @internal Angle between the view direction and the tile, in units of the half diagonal FOV (0 = view center). */
  foveation(tile: GlobeTile): number {
    const s = tile.boundingSphere;
    _v.subVectors(s.center, this.cameraPosition);
    const d = _v.length();
    if (d <= s.radius) return 0;
    const cos = _v.dot(this.cameraForward) / d;
    const angle = Math.acos(clamp(cos, -1, 1)) - Math.asin(Math.min(1, s.radius / d));
    return Math.max(0, angle) / this.halfFovDiagonal;
  }

  // ---------------------------------------------------------------------------
  // Selection

  /**
   * Selects what to draw under `tile` (CesiumJS `QuadtreePrimitive.visitTile`, adapted).
   *
   * @param ancestorMeetsSse An ancestor is detailed enough but cannot be drawn yet without
   * losing detail: draw what was on screen last frame, refine no further and load nothing.
   */
  private visit(tile: GlobeTile, ancestorMeetsSse: boolean): void {
    tile.lastVisitedFrame = this.frame;
    if (!this.isVisible(tile)) {
      this.select(tile, TileSelection.CULLED);
      return;
    }
    tile.distance = this.tileDistance(tile);
    if (!tile.renderable) {
      // Only roots get here: children are visited once all visible ones can be drawn.
      this.loader.queue('geo', tile, B_BLOCKING);
      return;
    }
    const canRefine = tile.level < this.maxLevel;
    const meetsSse = !canRefine || this.computeSSE(tile) <= this.maxScreenSpaceError;
    const kept = ancestorMeetsSse;

    if (meetsSse || ancestorMeetsSse) {
      if (selectionIn(tile, this.frame - 1) !== TileSelection.REFINED || !this.losesDetail(tile)) {
        this.render(tile, !kept);
        return;
      }
      // Drawing this tile would replace sharper descendants that were on screen last frame
      // with a blurrier picture (zooming out onto a tile whose imagery or terrain is still
      // loading). Keep them, without refining further, and load this tile first.
      if (!kept) this.queueBlocker(tile);
      ancestorMeetsSse = true;
    }

    const children = tile.createChildren(this.scheme, this.childHeightRange(tile));
    let ready = true;
    let anyReady = false;
    for (const child of children) {
      child.lastVisitedFrame = this.frame;
      if (child.renderable) {
        anyReady ||= this.isVisible(child);
        continue;
      }
      if (this.isVisible(child)) {
        ready = false;
        child.distance = this.tileDistance(child);
        this.loader.queue('geo', child, B_BLOCKING);
      } else if (this.preloadSiblings && !kept && this.buildsLocally(child) && !this.outsideRegion(child)) {
        // Just outside the view: an interpolated mesh costs no download and saves a
        // fallback to this tile (and back) when the child comes into view.
        child.distance = this.tileDistance(child);
        this.loader.queue('geo', child, B_LOW);
      }
    }
    // Visible children without a mesh are drawn as this tile's quadrant (fills), so the ready ones
    // draw (and request their imagery) at once: zooming in, they need not wait for the slowest
    // sibling; zooming out or panning, the sharper children on screen are not swapped for this
    // tile when one more comes into view.
    if (!refinesNow(ready, anyReady)) {
      // Some visible children cannot be drawn yet; draw this tile meanwhile.
      this.render(tile, !kept);
      return;
    }

    this.select(tile, TileSelection.REFINED);
    if (!ancestorMeetsSse) {
      // Ancestors double as fallbacks for their descendants: keep them current at low priority.
      if (this.needsImagery(tile)) this.loader.queue('img', tile, B_LOW);
      // Interim ancestors still need their real terrain: descendants are estimated from it
      // and culled with its height range.
      if (this.needsGeometry(tile)) this.loader.queue('geo', tile, B_RENDERED);
    }
    for (const child of children) {
      if (child.renderable || !this.isVisible(child)) {
        this.visit(child, ancestorMeetsSse);
      } else {
        this.fillList.push(this.fillFor(tile, child));
        child.filledFrame = this.frame;
      }
    }
  }

  /** Mesh drawing the quadrant of `tile` that `child` covers (created on first use). */
  private fillFor(tile: GlobeTile, child: GlobeTile): Mesh {
    const q = (child.y - tile.y * 2) * 2 + (child.x - tile.x * 2);
    tile.fills ??= [null, null, null, null];
    let fill = tile.fills[q];
    if (fill) return fill;
    const source = tile.mesh!;
    const geometry = new BufferGeometry();
    // Shares the tile's vertex buffers: fills are disposed together with the tile's geometry.
    for (const name of ['position', 'normal', 'uv', MORPH_ATTRIBUTE]) geometry.setAttribute(name, source.geometry.getAttribute(name));
    const indices = source.geometry.getIndex()!.array as Uint16Array | Uint32Array;
    geometry.setIndex(new BufferAttribute(extractQuads(indices, quadrantQuads(tile.segments, q & 1, q >> 1)), 1));
    geometry.boundingSphere = source.geometry.boundingSphere;
    fill = new Mesh(geometry, tile.material);
    fill.name = `fill ${tile.key}/${q}`;
    fill.frustumCulled = false;
    fill.matrixAutoUpdate = false;
    fill.visible = false;
    fill.position.copy(source.position);
    fill.updateMatrix();
    fill.updateMatrixWorld(true);
    fill.userData.globeTile = tile;
    this.group.add(fill);
    tile.fills[q] = fill;
    return fill;
  }

  /** @internal Disposes a tile's fills; only together with its geometry, whose vertex buffers they share. */
  disposeFills(tile: GlobeTile): void {
    if (!tile.fills) return;
    for (const fill of tile.fills) {
      if (!fill) continue;
      this.group.remove(fill);
      fill.geometry.dispose();
    }
    tile.fills = null;
  }

  private select(tile: GlobeTile, result: TileSelection): void {
    tile.selection = result;
    tile.selectionFrame = this.frame;
  }

  /** Adds a tile to this frame's render list; `wanted` = this is the level of detail the view needs. */
  private render(tile: GlobeTile, wanted: boolean): void {
    this.select(tile, TileSelection.RENDERED);
    tile.keptForDetail = !wanted;
    this.renderList.push(tile);
    if (wanted && this.needsGeometry(tile)) this.loader.queue('geo', tile, tile.geometryGen === this.geometryGen ? B_RENDERED : B_URGENT);
  }

  /**
   * Whether drawing `tile` now would make detail vanish that its descendants
   * showed last frame (CesiumJS `canRenderWithoutLosingDetail`, negated):
   * its own imagery is still loading and a descendant showed sharper imagery
   * than the tile can (a magnified ancestor), or its terrain is still interim
   * and a descendant had real terrain. Failed loads count as done.
   */
  private losesDetail(tile: GlobeTile): boolean {
    const imageryDone = !this.needsImagery(tile) || tile.img.failures > 0;
    const terrainDone = !this.terrain || this.hasExactTerrain(tile) || tile.geo.failures > 0;
    if (imageryDone && terrainDone) return false;
    const fallback = this.fallbackLevel(tile);
    const shown = fallback === -Infinity ? -1 : fallback;
    return wouldLoseDetail(
      tile,
      this.frame - 1,
      (d) => (!imageryDone && (d.imagery?.level ?? -1) > shown) || (!terrainDone && this.hasExactTerrain(d)),
    );
  }

  /** Loads what `tile` lacks to replace its descendants (they stay on screen meanwhile). */
  private queueBlocker(tile: GlobeTile): void {
    if (this.needsImagery(tile) && tile.img.failures === 0) this.loader.queue('img', tile, B_BLOCKING);
    if (this.terrain && !this.hasExactTerrain(tile) && tile.geo.failures === 0) this.loader.queue('geo', tile, B_BLOCKING);
  }

  private needsGeometry(tile: GlobeTile): boolean {
    return !tile.mesh || tile.geometryGen !== this.geometryGen || tile.upsampled;
  }

  /** Mesh built from this tile's own terrain for the current source (not interpolated or flat). */
  private hasExactTerrain(tile: GlobeTile): boolean {
    return tile.mesh !== null && !tile.upsampled && tile.geometryGen === this.geometryGen && tile.dataLevel >= 0;
  }

  /**
   * @internal Where the next mesh for `tile` comes from without a download: an ancestor
   * with real terrain at most `MAX_UPSAMPLE_LEVELS` up (interpolated), 'flat'
   * for a root that has nothing yet, or null when it needs terrain data
   * (also when the tile already shows an interim mesh: next is the exact one).
   */
  interimSource(tile: GlobeTile): GlobeTile | 'flat' | null {
    if (!this.terrain) return null;
    if (tile.mesh !== null && tile.geometryGen === this.geometryGen && tile.upsampled) return null;
    // Interpolate from real terrain only (never from another estimate), and not from too far up.
    const src = this.exactAncestor(tile.parent);
    if (src && tile.level - src.level <= MAX_UPSAMPLE_LEVELS) return src;
    return !tile.parent && !tile.mesh ? 'flat' : null;
  }

  /** @internal Whether the next mesh for `tile` needs no download (flat globe, or interpolated from loaded terrain). */
  buildsLocally(tile: GlobeTile): boolean {
    return !this.terrain || this.interimSource(tile) !== null;
  }

  /** Closest ancestor-or-self with real (not interpolated) terrain for the current source. */
  private exactAncestor(tile: GlobeTile | null): GlobeTile | null {
    for (let t = tile; t; t = t.parent) {
      if (t.heights && !t.upsampled && t.geometryGen === this.geometryGen) return t;
    }
    return null;
  }

  /**
   * @internal Height range children of `tile` assume for culling until their own mesh
   * arrives. Interim heights are only estimates, so their children use the
   * range of the closest tile with real terrain (or the global range).
   */
  childHeightRange(tile: GlobeTile): [number, number] {
    if (!this.terrain || (tile.geometryGen === this.geometryGen && !tile.upsampled)) return [tile.minHeight, tile.maxHeight];
    // Interim or left over from another terrain source: only an estimate.
    const exact = this.exactAncestor(tile);
    if (exact) return [Math.min(exact.minHeight, tile.minHeight), Math.max(exact.maxHeight, tile.maxHeight)];
    return [TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT * this.exaggeration];
  }

  /** Whether imagery must be requested; tiles outside the provider's zoom range are settled on the spot. */
  private needsImagery(tile: GlobeTile): boolean {
    if (tile.imageryGen === this.imageryGen) return false;
    if (tile.level > this.imagery.maxZoom || tile.level < this.imagery.minZoom) {
      tile.ownImagery?.release();
      tile.ownImagery = null;
      tile.imageryGen = this.imageryGen;
      return false;
    }
    return true;
  }

  /** Level of the imagery a tile currently shows (-Infinity for the placeholder). */
  private fallbackLevel(tile: GlobeTile): number {
    let src: GlobeTile | null = tile;
    while (src) {
      if (src.ownImagery && src.imageryGen === this.imageryGen) return src.level;
      src = src.parent;
    }
    return -Infinity;
  }

  /**
   * Queues imagery / overlay for a rendered tile. When the tile shows a much
   * coarser fallback, an intermediate ancestor ("anchor") is loaded first: one
   * request that sharpens many tiles at once while their own imagery streams in.
   * Returns whether the tile is still waiting for its own imagery.
   */
  private queueRenderedContent(t: GlobeTile): boolean {
    let waiting = false;
    if (this.needsImagery(t)) {
      waiting = true;
      const effective = Math.min(t.level, this.imagery.maxZoom);
      const fallback = this.fallbackLevel(t);
      const gap = effective - fallback;
      this.loader.queue('img', t, gap >= ANCHOR_GAP ? B_URGENT : B_RENDERED);
      if (gap > ANCHOR_GAP) {
        const targetLevel = Math.max(this.imagery.minZoom, fallback === -Infinity ? MIN_LEVEL : fallback + ANCHOR_GAP);
        let anchor: GlobeTile = t;
        while (anchor.parent && anchor.level > targetLevel) anchor = anchor.parent;
        if (anchor !== t && anchor.level === targetLevel && this.needsImagery(anchor)) this.loader.queue('img', anchor, B_ANCHOR);
      }
    }
    if (this.overlaySource && this.overlayNeedsRequest(t)) this.loader.queue('ovl', t, B_RENDERED);
    return waiting;
  }

  /**
   * Whether the tile's overlay must be (re)requested. Tiles outside changed
   * regions or without any content are brought up to date on the spot.
   */
  private overlayNeedsRequest(tile: GlobeTile): boolean {
    const src = this.overlaySource;
    if (!src || tile.overlayGen === src.version) return false;
    if (tile.overlayGen >= 0 && src.isCurrent(tile.level, tile.x, tile.y, tile.overlayGen)) {
      tile.overlayGen = src.version;
      return false;
    }
    if (!src.hasContent(tile.level, tile.x, tile.y)) {
      this.content.applyOverlay(tile, null, src.version);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Loading

  // ---------------------------------------------------------------------------
  // Applying content

  // ---------------------------------------------------------------------------
  // Cache eviction

  private evict(): void {
    if (this.loaded.size <= this.maxCachedTiles) return;
    const target = Math.floor(this.maxCachedTiles * 0.9);
    const candidates = [...this.loaded].filter((t) => t.parent !== null && t.lastVisitedFrame < this.frame - 1);
    candidates.sort((a, b) => a.lastVisitedFrame - b.lastVisitedFrame || b.level - a.level);
    for (const tile of candidates) {
      if (this.loaded.size <= target) break;
      if (this.hasContentBelow(tile)) continue;
      this.unload(tile);
    }
  }

  /**
   * @internal Frees tile content while the globe is not drawn (hidden under 3D Tiles,
   * say): `update()` does not run then, so the regular eviction never would.
   * Unloads leaf first down to `keep` tiles; the root tiles always stay, so
   * the globe has something to show the moment it is back and reloads the
   * rest (from the browser cache, mostly).
   *
   * @returns The number of tiles unloaded.
   */
  releaseHidden(keep: number): number {
    if (this.loaded.size <= keep) return 0;
    const candidates = [...this.loaded].filter((t) => t.parent !== null);
    candidates.sort((a, b) => b.level - a.level || a.lastVisitedFrame - b.lastVisitedFrame);
    let released = 0;
    for (const tile of candidates) {
      if (this.loaded.size <= keep) break;
      if (this.hasContentBelow(tile)) continue;
      this.unload(tile);
      released++;
    }
    if (released > 0) {
      // What was on screen before is gone: the next update starts like a first frame
      // (no "shown last frame" shortcuts onto unloaded tiles).
      this.frame += 2;
      this.stats.cached = this.loaded.size;
    }
    return released;
  }

  /**
   * Estimated video memory of the loaded tiles in bytes: imagery and overlay
   * textures (shared ones counted once, with their mipmaps) and tile meshes.
   */
  get gpuBytes(): number {
    const textures = new Set<SharedTexture>();
    let bytes = 0;
    for (const tile of this.loaded) {
      for (const t of [tile.ownImagery, tile.imagery, tile.ownOverlay, tile.overlay]) {
        if (t && t.level >= 0 && !textures.has(t)) {
          textures.add(t);
          bytes += t.bytes;
        }
      }
      const geometry = tile.mesh?.geometry;
      if (geometry) {
        for (const name in geometry.attributes) bytes += (geometry.attributes[name].array as unknown as ArrayBufferView).byteLength;
        if (geometry.index) bytes += (geometry.index.array as unknown as ArrayBufferView).byteLength;
      }
    }
    return bytes;
  }

  private hasContentBelow(tile: GlobeTile): boolean {
    if (!tile.children) return false;
    for (const c of tile.children) {
      if (c.mesh || c.ownImagery || c.imagery || c.ownOverlay || c.loading || this.hasContentBelow(c)) return true;
    }
    return false;
  }

  private unload(tile: GlobeTile): void {
    tile.abortAll();
    tile.epoch++;
    if (this.content.fading.has(tile)) this.content.endFade(tile);
    this.content.endMorph(tile);
    this.disposeFills(tile);
    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      this.group.remove(tile.mesh);
      tile.mesh = null;
    }
    tile.ownImagery?.release();
    tile.ownImagery = null;
    tile.imagery?.release();
    tile.imagery = null;
    tile.ownOverlay?.release();
    tile.ownOverlay = null;
    tile.overlay?.release();
    tile.overlay = null;
    tile.overlayGen = -1;
    tile.material.overlayMap = EMPTY_OVERLAY;
    tile.heights = null;
    tile.upsampled = false;
    tile.geometryGen = -1;
    tile.imageryGen = -1;
    tile.imageryPendingSince = 0;
    if (tile.children) {
      // Children carry no content at this point (leaf-first eviction); drop the nodes.
      for (const c of tile.children) {
        c.abortAll();
        c.epoch++;
        c.material.dispose();
      }
      tile.children = null;
    }
    this.loaded.delete(tile);
  }

  /** Debug: draw all tiles as wireframes. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.forEachTile((t) => {
      t.material.wireframe = on;
    });
    for (const cap of this.polarCaps.caps) (cap.material as TileMaterial).wireframe = on;
    // Instances only rebuild when their shared node material does.
    refreshTileMaterials();
  }

  private forEachTile(cb: (t: GlobeTile) => void): void {
    const stack = [...this.roots];
    while (stack.length) {
      const t = stack.pop()!;
      cb(t);
      if (t.children) stack.push(...t.children);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries

  /**
   * Terrain height (WGS84 ellipsoidal, meters) at a position (radians) from
   * the finest loaded tile, or null if unknown. With `maxCellSize`, estimates
   * from data coarser than that grid spacing (meters) count as unknown: camera
   * collision uses this so a coarse or interpolated surface cannot push the
   * camera up by hundreds of meters. Terrain only: to put things on the
   * ground use `viewer.surfaceHeight`, which also covers 3D Tiles.
   */
  getHeight(longitude: number, latitude: number, maxCellSize = Infinity): number | null {
    const s = this.sampleHeight(longitude, latitude);
    return s && s.cellSize <= maxCellSize ? s.height : null;
  }

  /**
   * @internal Terrain height (WGS84 ellipsoidal, meters) at a position (radians) from the
   * finest loaded tile, with the grid spacing of the data it came from
   * (meters; Infinity for data not from a terrain tile, 0 without terrain,
   * where the ellipsoid is exact). Null while no tile there has heights.
   */
  sampleHeight(longitude: number, latitude: number): { height: number; cellSize: number } | null {
    if (!this.terrain) return { height: 0, cellSize: 0 };
    const n = this.scheme.tilesAtLevel(MIN_LEVEL);
    const { x, y } = this.scheme.positionToTile(MIN_LEVEL, longitude, latitude);
    let tile: GlobeTile | null = this.roots[y * n + x];
    let best: GlobeTile | null = null;
    const v = this.scheme.latitudeToMercatorV(latitude);
    const u = (longitude + Math.PI) / (2 * Math.PI);
    while (tile) {
      if (tile.heights && tile.geometryGen === this.geometryGen) best = tile;
      if (!tile.children) break;
      const scale = 2 ** (tile.level + 1);
      const cx = Math.min(1, Math.max(0, Math.floor(u * scale) - tile.x * 2));
      const cy = Math.min(1, Math.max(0, Math.floor(v * scale) - tile.y * 2));
      tile = tile.children[cy * 2 + cx];
    }
    if (!best) return null;
    const cellSize = best.dataLevel < 0 ? Infinity : (2 * Math.PI * WGS84_A * Math.cos(latitude)) / 2 ** best.dataLevel / Math.max(1, best.segments);
    const scale = 2 ** best.level;
    const height = best.sampleHeight(u * scale - best.x, v * scale - best.y);
    return height === null ? null : { height, cellSize };
  }

  /**
   * @internal Terrain height (WGS84 ellipsoidal, meters) at a position (radians) on the surface
   * drawn in the last frame: the tile on screen there (or the one whose quadrant fills in for a
   * child), not the finest loaded one, so things built along the surface (local scene walls)
   * meet it, with the grid spacing of that tile (meters). Ignores a running morph. Null where
   * nothing is drawn.
   */
  sampleRenderedHeight(longitude: number, latitude: number): { height: number; cellSize: number } | null {
    const n = this.scheme.tilesAtLevel(MIN_LEVEL);
    const { x, y } = this.scheme.positionToTile(MIN_LEVEL, longitude, latitude);
    const v = this.scheme.latitudeToMercatorV(latitude);
    const u = (longitude + Math.PI) / (2 * Math.PI);
    const frame = this.frame;
    let tile: GlobeTile | null = this.roots[y * n + x];
    while (tile) {
      const s = selectionIn(tile, frame);
      if (s === TileSelection.RENDERED) break;
      if (s !== TileSelection.REFINED || !tile.children) return null;
      const scale = 2 ** (tile.level + 1);
      const cx = Math.min(1, Math.max(0, Math.floor(u * scale) - tile.x * 2));
      const cy = Math.min(1, Math.max(0, Math.floor(v * scale) - tile.y * 2));
      const child: GlobeTile = tile.children[cy * 2 + cx];
      // A child drawn as this tile's quadrant (a fill): the surface is this tile's.
      if (child.filledFrame === frame) break;
      tile = child;
    }
    if (!tile) return null;
    const cellSize = (2 * Math.PI * WGS84_A * Math.cos(latitude)) / 2 ** tile.level / Math.max(1, this.segments);
    if (!this.terrain) return { height: 0, cellSize };
    if (!tile.heights) return null;
    const scale = 2 ** tile.level;
    const height = tile.sampleHeight(u * scale - tile.x, v * scale - tile.y);
    return height === null ? null : { height, cellSize };
  }

  /** @internal Nearest intersection of a world-space ray with the rendered globe surface (use `viewer.pick`). */
  raycast(ray: Ray, accept?: (point: Vector3) => boolean): { point: Vector3; distance: number } | null {
    let bestDist = Infinity;
    const best = new Vector3();
    // Grid triangles come first in both tile meshes and fills (tileMeshLayout.ts); skirts are skipped.
    const test = (mesh: Mesh, sphere: Sphere, triCount: number) => {
      if (!ray.intersectsSphere(sphere)) return;
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      const index = mesh.geometry.getIndex()!;
      _localRay.origin.subVectors(ray.origin, mesh.position);
      _localRay.direction.copy(ray.direction);
      for (let t = 0; t < triCount; t++) {
        _a.fromBufferAttribute(pos, index.getX(t * 3));
        _b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
        _c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
        if (_localRay.intersectTriangle(_a, _b, _c, false, _hit)) {
          const d = _hit.distanceTo(_localRay.origin);
          if (d < bestDist && (!accept || accept(_v.copy(_hit).add(mesh.position)))) {
            bestDist = d;
            best.copy(_hit).add(mesh.position);
          }
        }
      }
    };
    for (const tile of this.renderList) if (tile.mesh) test(tile.mesh, tile.boundingSphere, tile.segments * tile.segments * 2);
    for (const fill of this.fillList) {
      const tile = fill.userData.globeTile as GlobeTile;
      test(fill, tile.boundingSphere, (tile.segments / 2) ** 2 * 2);
    }
    if (bestDist < Infinity) return { point: best, distance: bestDist };
    // With a filter (local scene), the ellipsoid outside the region is not a surface either.
    if (accept) return null;
    const t = this.ellipsoid.intersectRay(ray);
    return t === null ? null : { point: ray.at(t, new Vector3()), distance: t };
  }

  // ---------------------------------------------------------------------------
  // Polar caps (Web Mercator stops at about 85 degrees)

  /** @internal Released by `viewer.dispose()`. */
  dispose(): void {
    this.forEachTile((t) => t.abortAll());
    for (const item of this.loader.ready) item.discard();
    this.loader.ready = [];
    this.forEachTile((t) => this.unload(t));
    this.forEachTile((t) => t.material.dispose());
    for (const cap of this.polarCaps.caps) {
      cap.geometry.dispose();
      (cap.material as TileMaterial).dispose();
    }
    for (const tex of this.polarCaps.capTextures) tex.dispose();
    this.placeholder.release();
    this.emptyOverlay.release();
    this.loader.resetPrefetch();
    this.loader.workers.dispose();
    this.imagery.dispose?.();
  }
}
