/**
 * Public types of the viewer (`GeoViewer`): options, views, picks, frame statistics, memory,
 * snapshots, events and errors. Types only, so any module can name them without importing the
 * viewer itself.
 */
import type { Vector3 } from 'three';
import type { GlobeOptions, GlobeStats } from '../globe/Globe';
import type { CloudOptions } from '../clouds/CloudLayer';
import type { Cartographic } from '../core/Ellipsoid';
import type { GpuTier } from '../core/gpuProfile';
import type { LocaleId, ViewerMessageOverrides } from '../core/i18n';
import type { BimEntity } from '../indoor/BimEntity';
import type { ContributionCullingOptions } from '../indoor/ContributionCulling';
import type { FloorOcclusionOptions } from '../indoor/FloorOcclusion';
import type { MarkerStats } from '../markers/MarkerManager';
import type { PointLayer } from '../markers/PointLayer';
import type { PointRecord } from '../markers/points';
import type { SunShadowOptions } from '../lighting/SunShadows';
import type { ColorGradingOptions } from '../post/postMath';
import type { PostStage } from '../post/PostPipeline';
import type { SupersamplingOptions } from '../post/Supersampling';
import type { SplatLayer, SplatLayerStats } from '../splats/SplatLayer';
import type { TransparencyOptions } from '../post/Transparency';
import type { Tiles3DLayer, TilesMemoryStats } from '../tiles3d/Tiles3DLayer';
import type { GeoJsonLayer } from '../vector/GeoJsonLayer';
import type { FeatureHit } from '../vector/types';
import type { LoadState } from './loadState';

export interface ViewPosition {
  /** Degrees. */
  longitude: number;
  /** Degrees. */
  latitude: number;
  /** Meters above the ellipsoid. */
  height: number;
  /** Degrees, clockwise from north. */
  heading?: number;
  /** Degrees, negative looks down. */
  pitch?: number;
}

/** Look at a point from a heading / pitch / range (ThingJS `flyTo({ target, horzAngle, vertAngle })`). */
export interface TargetView {
  /** Degrees / meters, or a world (ECEF) point. */
  target: { longitude: number; latitude: number; height?: number } | Vector3;
  /** Degrees clockwise from north (default: keep the current heading). */
  heading?: number;
  /** Degrees, negative looks down (default -45). */
  pitch?: number;
  /** Meters from the target (default 500). */
  range?: number;
  /** Seconds (default: automatic). */
  duration?: number;
}

export interface SphereFlightOptions {
  /** Multiplies the distance that fits the sphere in view. */
  rangeScale?: number;
  /** Closest distance in meters (default 50). */
  minRange?: number;
}

export interface GeoViewerOptions extends GlobeOptions {
  container: HTMLElement;
  /** Skip WebGPU and use the WebGL 2 backend. */
  forceWebGL?: boolean;
  /**
   * GPU tier deciding the memory budgets and default quality (frame buffers,
   * globe cache, 3D Tiles; see `core/gpuProfile.ts`). Default: guessed from
   * the adapter, never `ultra`.
   */
  gpuTier?: GpuTier;
  /** 4x MSAA (default from the GPU tier: off on `low`). */
  antialias?: boolean;
  initialView?: ViewPosition;
  /** View `navigation.home()` returns to (default: `initialView`). */
  homeView?: ViewPosition;
  /** Cloud layer settings; clouds stay hidden unless `visible: true`. */
  clouds?: CloudOptions;
  /**
   * Contribution culling of small devices and components (M2.3); off unless
   * `enabled: true`. Change later with `viewer.indoor.culling.configure()`.
   */
  contributionCulling?: ContributionCullingOptions;
  /**
   * Floor ambient occlusion (M3.4, default on): floors darken softly along walls and under
   * devices. Change later with `viewer.indoor.ambientOcclusion.configure()`.
   */
  ambientOcclusion?: FloorOcclusionOptions;
  /** Upper bound of the canvas pixel ratio (default from the GPU tier: 1 / 1.5 / 2 / 2). */
  maxPixelRatio?: number;
  /**
   * Folder URL (ending with `/`) of the Draco glTF decoder files (`draco_decoder.js`,
   * `draco_wasm_wrapper.js`, `draco_decoder.wasm`), e.g. on a CDN or in the host's public
   * folder. Default: the copy shipped with three.js, which the host's bundler picks up.
   */
  decoderPath?: string;
  /**
   * Folder URL (ending with `/`) of the Basis transcoder files for KTX2 textures
   * (`basis_transcoder.js`, `basis_transcoder.wasm`). Default: the copy shipped with three.js.
   */
  transcoderPath?: string;
  /**
   * Language of the text the SDK shows by itself (default `'zh-CN'`): property names added to
   * BIM entities, default point layer names. Error messages are always English with a `code`
   * (`TerraViewError`).
   */
  locale?: LocaleId;
  /** Overrides individual texts of `locale`. */
  messages?: ViewerMessageOverrides;
  /**
   * Frames per second once the view has been quiet for a second (default 10): nothing loading,
   * no camera motion, input or transition. Saves most of the CPU and GPU time a static view
   * costs (docs/api.md §1.8). 0 draws every animation frame; other values are kept within
   * 10–60 (below 10 the saving is unreliable and time-based motion would slow down).
   */
  idleFrameRate?: number;
  /**
   * Still supersampling (default on): once the view has been still for a second, the next
   * frames are drawn with sub-pixel camera offsets and averaged (16 samples with MSAA, 32
   * without), then nothing is drawn until something changes (docs/api.md §1.8). `false`: still
   * views are drawn at `idleFrameRate` instead. Change later through `viewer.supersampling`.
   */
  supersampling?: boolean | SupersamplingOptions;
  /** Exposure, contrast and saturation (default neutral); change later through `viewer.colorGrading`. */
  colorGrading?: ColorGradingOptions;
  /**
   * Sun shadows of buildings and devices while `lighting` is on (M3.9; default from the GPU
   * tier: on, off on `low`). `false` turns them off; change later through `viewer.shadows`.
   */
  shadows?: boolean | SunShadowOptions;
  /** Order-independent transparency of buildings (M3.9, WebGPU; default from the GPU tier: `ultra` only); change later through `viewer.transparency`. */
  transparency?: TransparencyOptions;
}

export interface RendererInfo {
  backend: 'WebGPU' | 'WebGL2';
  reversedDepth: boolean;
  highPrecision: boolean;
  timestampQuery: boolean;
  adapter: string;
  /** GPU tier in effect, and whether it was guessed from the adapter or given (`gpuTier`). */
  tier: GpuTier;
  tierSource: 'auto' | 'option';
  /** MSAA samples of the canvas (1 = none) and its pixel ratio. */
  samples: number;
  pixelRatio: number;
}

/**
 * Estimated memory use in bytes (`viewer.memory`). Browsers report neither
 * the video memory in use nor its size: these are sums over what the viewer
 * itself allocated, good for comparing settings, not exact.
 */
export interface MemoryReport {
  /** Canvas color / depth targets (with MSAA) and the pick buffer. */
  framebuffers: number;
  /** Globe tiles: imagery and overlay textures, meshes. */
  globe: number;
  /** 3D Tiles content uploaded to the GPU. */
  tilesGpu: number;
  /**
   * Buildings: glTF models (floor, device and exterior models; `indoor.modelBytes`) and the
   * floor ambient occlusion textures (`indoor.ambientOcclusion.bytes`).
   */
  buildings: number;
  /** Sun shadow map (`shadows.bytes`; allocated the first time shadows are drawn). */
  shadows: number;
  /** Gaussian splat layers: splat data, spherical harmonics and sort buffers (`SplatLayer.gpuBytes`). */
  splats: number;
  /** Sum of the above: the viewer's video memory, without generated building geometry, labels and the browser's own share. */
  gpuTotal: number;
  /** Decoded 3D Tiles content in the tile cache (mostly system memory; includes what is on the GPU) and its limit. */
  tilesCache: number;
  tilesCacheMax: number;
}

/**
 * @advanced Diagnostics of a viewer at one moment (`viewer.snapshot()`, roadmap M5.1): plain
 * JSON-serializable values to attach to a bug report or hand to a tool. The shape may grow
 * between minor versions.
 */
export interface ViewerSnapshot {
  /** When it was taken (ISO 8601) and the simulated date driving the sun. */
  time: string;
  date: string;
  info: RendererInfo;
  stats: FrameStats;
  memory: MemoryReport;
  load: LoadState;
  view: Required<ViewPosition>;
  scene: { lighting: boolean; atmosphere: boolean; showGlobe: boolean; showStars: boolean; clouds: boolean; timeMultiplier: number };
  globe: GlobeStats & { shown: boolean };
  tilesets: { id: number; name: string; visible: boolean; active: boolean; pending: number; errorScale: number; memory: TilesMemoryStats }[];
  layers: { vector: number; points: number; markers: MarkerStats };
  /** Gaussian splat layers: whether each is loaded, shown and drawn right now, splats drawn, file facts, video memory. */
  splats: { id: number; name: string; ready: boolean; visible: boolean; active: boolean; gpuBytes: number; stats: SplatLayerStats | null }[];
  indoor: {
    buildings: number;
    /** Entered level (id and type), null on the globe. */
    current: { id: string; type: string } | null;
    selected: string | null;
    modelBytes: number;
    ambientOcclusion: { enabled: boolean; floors: number; bytes: number };
    culling: { enabled: boolean; candidates: number; culled: number };
  };
  post: {
    effects: { name: string; stage: PostStage; active: boolean }[];
    samples: number;
    supersampling: boolean;
    transitionMs: number;
    /** Order-independent transparency: wanted, possible on this backend, drawn in the last frame. */
    transparency: { orderIndependent: boolean; supported: boolean; active: boolean };
  };
  /** Lights of buildings and 3D Tiles: sun color (linear RGB) and intensity, hemisphere and sky probe intensities. */
  lights: { sunColor: [number, number, number]; sunIntensity: number; hemisphere: number; skyProbe: number };
  /** Sun shadows: settings, whether they were drawn, meters per shadow map texel (0 while not drawn). */
  shadows: { enabled: boolean; active: boolean; mapSize: number; texelSize: number; maxDistance: number };
}

export interface FrameStats {
  /** Frames drawn per second (the idle frame rate while `throttled`, 0 while `still`). */
  fps: number;
  /** CPU time of a frame, ms (smoothed; frames that draw nothing count too). */
  frameMs: number;
  gpuMs: number | null;
  /** Draw calls and triangles of the last scene pass drawn. */
  drawCalls: number;
  triangles: number;
  /** Frames are currently updated at `idleFrameRate` because the view has been quiet. */
  throttled: boolean;
  /**
   * The view is still and its picture is final (supersampled): frames keep updating the viewer
   * at the idle rate but draw nothing (`frame` events continue). False with supersampling off.
   */
  still: boolean;
  /** Supersampling samples averaged in the picture on the canvas (0 while frames are drawn live). */
  samples: number;
}

export interface ViewerEvents extends Record<string, unknown> {
  /** After every frame update, also those of a still view that draw nothing (`stats.still`). */
  frame: FrameStats;
  'tilesets-changed': Tiles3DLayer[];
  'vectors-changed': GeoJsonLayer[];
  'points-changed': PointLayer[];
  /** A Gaussian splat layer was added, became ready, failed or was removed. */
  'splats-changed': SplatLayer[];
  /** A point marker of a point layer was clicked. */
  'point-click': { point: PointRecord; layer: PointLayer; event: MouseEvent };
  /** Something failed to load (one event per failure the SDK reports, see `ViewerError`). */
  error: ViewerError;
  /** `loadState` changed: emitted at most once per frame, after the frame's loads were scheduled. */
  'load-progress': LoadState;
  /**
   * `loadState.idle` became true: everything for the current view has loaded. Emitted again
   * after each later burst of loading (camera moves, new layers), and once at startup even
   * when there was nothing to load.
   */
  idle: LoadState;
}

/** Where a `ViewerError` comes from. */
export type ViewerErrorSource = 'imagery' | 'terrain' | 'tileset' | 'geojson' | 'points' | 'splats';

/**
 * A load failure, on `viewer.events` 'error'. One place to listen for what otherwise arrives
 * per layer (their own `error` events, which still fire) or per globe channel.
 *
 * - `imagery`: the base imagery keeps failing (`imagery-unreachable`, once per provider).
 * - `terrain`: terrain tiles keep failing (`terrain-unreachable`, once per terrain source).
 * - `tileset`: a 3D Tiles root tileset failed to load (`tileset-load-failed`); `layer` is set.
 * - `geojson`, `points`: a layer's data could not be loaded or parsed; `layer` is set.
 * - `splats`: a Gaussian splat file could not be loaded or decoded (`splat-load-failed`,
 *   `splat-invalid`, `splat-format-unsupported`); `layer` is set.
 */
export interface ViewerError {
  source: ViewerErrorSource;
  /** A `TerraViewError` with a `code` when the SDK raised it, else the original error (network, parsing). */
  error: Error;
  layer?: Tiles3DLayer | GeoJsonLayer | PointLayer | SplatLayer;
}

export interface FeaturePick {
  hit: FeatureHit;
  layer: GeoJsonLayer;
  /** Picked ground position (radians / meters), null when picked through a label. */
  position: Cartographic | null;
}

export interface SurfacePick {
  point: Vector3;
  source: 'globe' | 'tiles' | 'entity' | 'splats';
  distance: number;
  entity?: BimEntity;
  tileset?: Tiles3DLayer;
  /** The Gaussian splat layer hit and the index of the splat (`source: 'splats'`; always a CPU ray). */
  splats?: SplatLayer;
  splatIndex?: number;
  /** World unit normal facing the camera (GPU pick buffer only; flat per triangle). */
  normal?: Vector3;
  /** How the pick was answered: the GPU pick buffer or a CPU ray. */
  via?: 'buffer' | 'ray';
}
