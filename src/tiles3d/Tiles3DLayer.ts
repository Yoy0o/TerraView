import { Box3, DoubleSide, Matrix4, Mesh, Sphere, Vector3, type Material, type Object3D } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin, GoogleCloudAuthPlugin, TilesFadePlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { EventEmitter } from '../core/EventEmitter';
import type { Ellipsoid } from '../core/Ellipsoid';
import { TerraViewError } from '../core/errors';
import { gpuProfile, type TilesQuality } from '../core/gpuProfile';
import { createAdaptiveErrorState, stepAdaptiveError, tilesFalloffDensity } from './lodPolicy';
import { applyTexturePolicy, NodeFadeMaterialManager, NodeMaterialPlugin, type NodeMaterialLibrary } from './nodeMaterials';

export type TilesetSource =
  | { type: 'url'; url: string }
  | { type: 'ion'; assetId: number; token: string }
  | { type: 'google'; apiKey: string };

export interface Tiles3DLayerOptions {
  source: TilesetSource;
  name?: string;
  /**
   * Target screen-space error in pixels (lower = more detail). The GPU tier
   * scales it (`TilesQuality.errorTargetScale`), and it rises temporarily
   * while the tile cache is full (see `Tiles3DLayer.errorScale`).
   */
  errorTarget?: number;
  /**
   * Extra error distant tiles may have in oblique views, as a multiple of the
   * error target (0 disables; default from the GPU tier). See `lodPolicy.ts`.
   */
  errorFalloff?: number;
  /** Vertical offset in meters along the local up axis at the tileset center. */
  heightOffset?: number;
  /** Dithered cross-fade between levels of detail, in milliseconds (0 disables). */
  fadeDuration?: number;
}

export interface Tiles3DLayerEvents extends Record<string, unknown> {
  ready: { sphere: Sphere };
  /**
   * The root tileset failed to load (failures of single tiles after that are logged and
   * retried by the library). `error` is a `tileset-load-failed` `TerraViewError`
   * (`details.url`, `details.reason`) with the library's error as `cause`.
   */
  error: { message: string; error: Error };
  change: void;
}

/** Loader dependencies shared by all tilesets (decoders are heavy). */
export interface LoaderKit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dracoLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ktxLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meshoptDecoder: any;
  /** Renderer node library; enables node materials (and with them the WebGPU fade). */
  nodeLibrary?: NodeMaterialLibrary;
}

/** Where the camera is relative to the ground, for the distance falloff of the error target. */
export interface TilesViewState {
  /** Camera height above the ground in meters. */
  altitude: number;
  /** Cosine of the angle between the view direction and the local vertical (-1 = straight down). */
  viewDotUp: number;
}

/** Memory and level-of-detail state of a tileset (bytes are the tile renderer's estimates). */
export interface TilesMemoryStats {
  /** Tile content of this layer uploaded to the GPU (visible tiles plus hidden ones not yet freed). */
  gpuBytes: number;
  /** Decoded tile content in the cache shared by all tilesets, on the GPU or not. */
  cachedBytes: number;
  /** Size at which the shared cache stops loading. */
  cacheMaxBytes: number;
  /** Tiles the last update wanted but could not load because the cache is full. */
  refused: number;
  /** Factor currently applied to the error target because of a full cache (1 = none). */
  errorScale: number;
}

/** The parts of the tile renderer this wrapper reads that its typings do not declare. */
interface TilesInternals {
  stats: { refused?: number; queued?: number; downloading?: number; parsing?: number };
  usedSet?: Set<unknown>;
}

let nextId = 1;

/**
 * An OGC 3D Tiles tileset (b3dm / i3dm / pnts / cmpt / glTF content, implicit
 * tiling) driven by NASA-AMMOS 3DTilesRendererJS. Tile selection, caching and
 * parsing come from the library; this wrapper handles placement on the globe,
 * credentials, node materials, the WebGPU LOD fade, the memory budgets of the
 * GPU tier and lifecycle.
 */
export class Tiles3DLayer {
  readonly id = nextId++;
  readonly name: string;
  readonly tiles: TilesRenderer;
  readonly events = new EventEmitter<Tiles3DLayerEvents>();
  readonly source: TilesetSource;
  ready = false;
  /** Message of the root tileset's load failure (see the `error` event), null otherwise. */
  error: string | null = null;
  /** Bounding sphere in world (ECEF) space once the root tileset is loaded. */
  readonly boundingSphere = new Sphere();
  /** Target screen-space error in pixels as configured, before the tier and cache scaling. */
  errorTarget: number;
  /** Extra error for distant tiles in oblique views, as a multiple of the error target (0 disables). */
  errorFalloff: number;
  private _heightOffset: number;
  private _visible = true;
  private _suppressed = false;
  private readonly baseMatrix = new Matrix4();
  private readonly unload: UnloadTilesPlugin;
  private readonly adaptive = createAdaptiveErrorState();

  constructor(
    options: Tiles3DLayerOptions,
    loaders: LoaderKit,
    private readonly ellipsoid: Ellipsoid,
    /** Budgets and level-of-detail settings of the GPU tier (default: the `high` tier). */
    readonly quality: TilesQuality = gpuProfile('high').tiles,
  ) {
    this.source = options.source;
    this.name = options.name ?? defaultName(options.source);
    this._heightOffset = options.heightOffset ?? 0;
    this.errorTarget = options.errorTarget ?? 12;
    this.errorFalloff = options.errorFalloff ?? quality.errorFalloffScale;

    const src = options.source;
    const tiles = src.type === 'url' ? new TilesRenderer(src.url) : new TilesRenderer();
    if (src.type === 'ion') {
      tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: src.token, assetId: String(src.assetId), autoRefreshToken: true }));
    } else if (src.type === 'google') {
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: src.apiKey, autoRefreshToken: true }));
    }
    tiles.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: loaders.dracoLoader,
        ktxLoader: loaders.ktxLoader,
        meshoptDecoder: loaders.meshoptDecoder,
        rtc: true,
        // Metadata texture reads rely on a WebGL renderer internally; keep tiles WebGPU-only.
        metadata: false,
        autoDispose: false,
      }),
    );
    if (loaders.nodeLibrary) {
      tiles.registerPlugin(new NodeMaterialPlugin(loaders.nodeLibrary, quality));
      const fadeDuration = options.fadeDuration ?? 300;
      if (fadeDuration > 0) {
        const fade = new TilesFadePlugin({ fadeDuration, fadeRootTiles: true, maximumFadeOutTiles: 60 });
        // The stock material manager patches GLSL through onBeforeCompile (a no-op under
        // WebGPU); swap in the TSL one. Its interface is the same three methods.
        (fade as unknown as { _fadeMaterialManager: NodeFadeMaterialManager })._fadeMaterialManager = new NodeFadeMaterialManager();
        tiles.registerPlugin(fade);
      }
    }
    // Hidden tiles leave the GPU only while the layer is above its GPU target, and not right away
    // (re-uploading is what makes turning around stutter). Their decoded data stays in the cache.
    this.unload = new UnloadTilesPlugin({ delay: quality.unloadDelayMs, bytesTarget: quality.gpuBytesTarget });
    tiles.registerPlugin(this.unload);
    configureSharedQueues(tiles, quality);
    tiles.errorTarget = this.errorTarget * quality.errorTargetScale;
    tiles.group.name = `3D Tiles: ${this.name}`;
    this.tiles = tiles;

    tiles.addEventListener('load-root-tileset', () => this.onRootLoaded());
    if (!loaders.nodeLibrary) tiles.addEventListener('load-model', (e: { scene: Object3D }) => this.onModelLoaded(e.scene));
    tiles.addEventListener('load-error', (e: { error: Error; url: string | URL }) => {
      const reason = String(e.error?.message ?? e.error);
      const message = `${reason} (${String(e.url)})`;
      console.warn('[3D Tiles]', message);
      if (this.ready || this.error !== null) return;
      const error = new TerraViewError('tileset-load-failed', message, { url: String(e.url), reason }, { cause: e.error });
      this.error = message;
      this.events.emit('error', { message, error });
    });
    tiles.addEventListener('needs-update', () => this.events.emit('change', undefined));
  }

  get group(): Object3D {
    return this.tiles.group;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.tiles.group.visible = v && !this._suppressed;
  }

  /** Temporarily hidden by the viewer (e.g. while inside a building), independent of `visible`. */
  get suppressed(): boolean {
    return this._suppressed;
  }

  set suppressed(v: boolean) {
    this._suppressed = v;
    this.tiles.group.visible = this._visible && !v;
  }

  /** Visible and not suppressed: drawn, updated and pickable. */
  get active(): boolean {
    return this._visible && !this._suppressed;
  }

  /**
   * Keep loading (without drawing) while suppressed, so the ground under a
   * building entered before the tiles ever loaded can still be measured
   * (`viewer.surfaceHeight`). Set by the viewer each frame.
   */
  probe = false;

  /** Loaded and visible, and either active or probing: a vertical ground ray may hit it (pointer picks still need `active`). */
  get measurable(): boolean {
    return this.ready && this._visible && (!this._suppressed || this.probe);
  }

  get heightOffset(): number {
    return this._heightOffset;
  }

  set heightOffset(meters: number) {
    this._heightOffset = meters;
    this.applyPlacement();
  }

  /**
   * Factor currently applied to the error target because the tile cache is
   * full (1 = none): the view asks for coarser tiles until it fits, and
   * returns to full detail once there is room again.
   */
  get errorScale(): number {
    return this.adaptive.scale;
  }

  /**
   * Tiles waiting for, or in, download and parsing: at least 1 while the root
   * tileset loads, 0 after it failed and while the layer is not updated
   * (hidden, or suppressed inside a building without probing for ground).
   */
  get pending(): number {
    // Not updated means nothing loads, the root tileset included.
    if (this.error !== null || !(this.active || (this._visible && this.probe))) return 0;
    if (!this.ready) return 1;
    const s = (this.tiles as unknown as TilesInternals).stats;
    return (s.queued ?? 0) + (s.downloading ?? 0) + (s.parsing ?? 0);
  }

  /** Memory counters for the status bar and `viewer.memory`. */
  get memory(): TilesMemoryStats {
    const cache = this.tiles.lruCache;
    return {
      gpuBytes: (this.unload as unknown as { estimatedGpuBytes: number }).estimatedGpuBytes,
      cachedBytes: (cache as unknown as { cachedBytes: number }).cachedBytes,
      cacheMaxBytes: cache.maxBytesSize,
      refused: (this.tiles as unknown as TilesInternals).stats.refused ?? 0,
      errorScale: this.adaptive.scale,
    };
  }

  /**
   * Call once per frame after the camera has been updated.
   *
   * @param dt Seconds since the last frame (drives the adaptive error target).
   * @param view Camera height and tilt for the distance falloff; without it distant tiles are not relaxed.
   */
  update(dt = 0, view?: TilesViewState): void {
    if (!(this.active || (this._visible && this.probe))) return;
    const tiles = this.tiles;
    const target = this.errorTarget * this.quality.errorTargetScale * this.adaptive.scale;
    tiles.errorTarget = target;
    tiles.errorFalloff = this.errorFalloff * target;
    tiles.errorFalloffDensity = view && this.errorFalloff > 0 ? tilesFalloffDensity(view.altitude, view.viewDotUp) : 0;
    tiles.update();

    const internals = tiles as unknown as TilesInternals;
    const refused = internals.stats.refused ?? 0;
    // The used bytes only matter for coming back down; skip the sum while nothing is raised.
    const usedBytes = this.adaptive.scale > 1 ? this.usedBytes(internals) : Infinity;
    stepAdaptiveError(this.adaptive, {
      refused,
      usedBytes,
      cacheMinBytes: tiles.lruCache.minBytesSize,
      maxScale: this.quality.adaptiveErrorMaxScale,
      dt,
    });
  }

  /** Bytes of the tiles the last update used (visible ones, their ancestors and siblings). */
  private usedBytes(internals: TilesInternals): number {
    const cache = this.tiles.lruCache;
    let bytes = 0;
    internals.usedSet?.forEach((tile) => (bytes += cache.getMemoryUsage(tile)));
    return bytes;
  }

  private onRootLoaded(): void {
    const sphere = new Sphere();
    if (!this.tiles.getBoundingSphere(sphere)) {
      const box = new Box3();
      if (this.tiles.getBoundingBox(box)) box.getBoundingSphere(sphere);
    }
    this.baseMatrix.identity();
    this.boundingSphere.copy(sphere);
    this.applyPlacement();
    this.ready = true;
    this.events.emit('ready', { sphere: this.boundingSphere });
  }

  private applyPlacement(): void {
    const group = this.tiles.group;
    group.matrix.copy(this.baseMatrix);
    const center = this.boundingSphere.center;
    if (this._heightOffset !== 0 && center.lengthSq() > 1) {
      const up = this.ellipsoid.geodeticSurfaceNormal(center, new Vector3());
      group.matrix.premultiply(new Matrix4().makeTranslation(up.multiplyScalar(this._heightOffset)));
    }
    group.matrix.decompose(group.position, group.quaternion, group.scale);
    group.updateMatrixWorld(true);
  }

  /** Fallback without node materials: make every material double sided and apply the texture policy. */
  private onModelLoaded(scene: Object3D): void {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
      for (const m of materials) {
        m.side = DoubleSide;
        applyTexturePolicy(m, this.quality);
      }
    });
  }

  dispose(): void {
    this.tiles.group.removeFromParent();
    this.tiles.dispose();
  }
}

/**
 * Applies a tier's budgets to the tile cache and the download / parse queues.
 * The library shares these between all tilesets, so the budget is one for the
 * whole page, and the last tileset added sets it.
 */
function configureSharedQueues(tiles: TilesRenderer, quality: TilesQuality): void {
  const cache = tiles.lruCache;
  cache.minBytesSize = quality.cacheMinBytes;
  cache.maxBytesSize = quality.cacheMaxBytes;
  tiles.parseQueue.maxJobs = quality.parseJobs;
  const downloads = tiles.downloadQueue as unknown as { maxJobs: number; maxJobsPerOrigin: number };
  downloads.maxJobs = quality.downloadJobs;
  downloads.maxJobsPerOrigin = quality.downloadJobs;
  tiles.maxTilesProcessed = quality.maxTilesProcessed;
}

function defaultName(src: TilesetSource): string {
  if (src.type === 'google') return 'Google Photorealistic 3D Tiles';
  if (src.type === 'ion') return `Cesium ion #${src.assetId}`;
  try {
    const u = new URL(src.url, location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : u.hostname;
  } catch {
    return src.url;
  }
}
