import {
  Color,
  DirectionalLight,
  HemisphereLight,
  LightProbe,
  LinearSRGBColorSpace,
  Matrix4,
  NeutralToneMapping,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  type Ray,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { mix, positionWorldDirection, vec3 } from 'three/tsl';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AtmosphereLighting, type AtmosphereLight } from '../atmosphere/AtmosphereLighting';
import { atmosphereUniforms, skyColorNode, Z_SCALE } from '../atmosphere/AtmosphereNodes';
import { CloudLayer, type CloudOptions } from '../atmosphere/CloudLayer';
import { StarField } from '../atmosphere/Stars';
import { cartographic, Ellipsoid, type Cartographic } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { classifyGpu, effectivePixelRatio, estimateFramebufferBytes, gpuProfile, type GpuHints, type GpuProfile, type GpuTier } from '../core/gpuProfile';
import { clamp, DEG2RAD, smoothstep } from '../core/math';
import { greenwichMeanSiderealTime, sunDirectionECEF } from '../core/SunPosition';
import { DEFAULT_LOCALE, resolveMessages, type LocaleId, type ViewerMessageOverrides, type ViewerMessages } from '../core/i18n';
import { Globe, type GlobeOptions, type GlobeStats } from '../globe/Globe';
import { OverlayCompositor } from '../globe/OverlayCompositor';
import { BimEntity } from '../indoor/BimEntity';
import type { Building } from '../indoor/Building';
import type { ContributionCullingOptions } from '../indoor/ContributionCulling';
import { FloorOcclusionBaker, type FloorOcclusionOptions } from '../indoor/FloorOcclusion';
import { IndoorManager } from '../indoor/IndoorManager';
import { MarkerManager, type MarkerStats } from '../markers/MarkerManager';
import { PointLayer, type PointLayerOptions } from '../markers/PointLayer';
import type { PointRecord } from '../markers/points';
import { SplatLayer, type SplatLayerOptions, type SplatLayerStats } from '../splats/SplatLayer';
import { Tiles3DLayer, type LoaderKit, type Tiles3DLayerOptions, type TilesMemoryStats, type TilesViewState } from '../tiles3d/Tiles3DLayer';
import type { NodeMaterialLibrary } from '../tiles3d/nodeMaterials';
import { resolveTileFeature, type FeatureHighlightStyle, type TileFeature } from '../tiles3d/tileFeatures';
import { GeoJsonLayer, type GeoJsonLayerOptions } from '../vector/GeoJsonLayer';
import { lonLatToMerc } from '../vector/geometry';
import { LabelManager } from '../vector/LabelManager';
import { SunShadows, sunShadowFactor, type ShadowCaster, type SunShadowOptions } from '../lighting/SunShadows';
import type { FeatureHit } from '../vector/types';
import { VectorService } from '../vector/VectorService';
import { cameraDirection, getHeadingPitch, lookAtHeadingPitchRange } from './cameraMath';
import { GlobeCameraController, type AutoOrbitOptions, type ControllerHost } from './GlobeCameraController';
import { ColorGrading, ColorGradingEffect } from '../post/ColorGrading';
import { EffectMarks } from '../post/EffectMarks';
import { GlowEffect } from '../post/GlowEffect';
import { LevelTransition } from '../post/LevelTransition';
import { OutlineEffect } from '../post/OutlineEffect';
import type { ColorGradingOptions } from '../post/postMath';
import { PostPipeline, type PostStage } from '../post/PostPipeline';
import { Supersampling, type SupersamplingOptions } from '../post/Supersampling';
import { Transparency, type TransparencyOptions } from '../post/Transparency';
import { ViewerEffects } from '../post/ViewerEffects';
import { tileDebugUniforms } from '../globe/TileMaterial';
import { IndoorBackdrop, studioSkyNode } from './IndoorBackdrop';
import { LocalScene } from '../local/LocalScene';
import { RegionDimEffect } from '../local/RegionDimEffect';
import { RegionWalls } from '../local/RegionWalls';
import { InteractionManager, type PickInfo } from './InteractionManager';
import type { IntroSpinOptions } from './IntroAnimation';
import { NavigationControls } from './NavigationControls';
import { OcclusionProxies } from './OcclusionProxies';
import { PickBuffer, type PickTarget } from './PickBuffer';
import { checkViewerOptions } from './viewerOptions';
import { SurfaceHeightQuery, type SurfaceHeight, type SurfaceHeightOptions, type SurfaceSample } from './SurfaceHeight';
import { LoadTracker, summarizeLoad, type LoadState } from './loadState';
import { cloudFrameRate, DEFAULT_IDLE_FRAME_RATE, drawMode, FramePacer, MAX_IDLE_FRAME_RATE, normalizeIdleFrameRate } from './framePacing';

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

const DEFAULT_VIEW: ViewPosition = { longitude: 110, latitude: 28, height: 1.8e7 };

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

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

const _ndc = new Vector2();
const _v = new Vector3();
const _dir = new Vector3();
const _carto = cartographic();
const _lightPoint = new Vector3();
const _shadowOrigin = new Vector3();
const _shadowUp = new Vector3();
const _localPoint = new Vector3();
const CENTER_NDC = new Vector2(0, 0);
/**
 * Hemisphere light kept at night with `lighting` on (fades out by day): the sky alone lights
 * buildings to almost nothing then, and interiors should stay readable.
 */
const NIGHT_FILL = 0.25;
/** Vertical surface rays start this high above the ellipsoid (meters; above any building or photogrammetry)… */
const SURFACE_RAY_TOP = 10_000;
/** …and reach this far below it (Dead Sea shore, ellipsoid below the geoid). */
const SURFACE_RAY_BOTTOM = 1_000;
/** Input on the container that wakes the frame loop up (passive listeners; the camera and interaction handle the input itself). */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;
/** How long suppressed 3D Tiles keep loading for a building still waiting for ground, after the last loading activity, ms. */
const GROUND_PROBE_MS = 15_000;
/**
 * A gap between animation frames longer than this means they were paused (hidden page, sleep): the
 * view is drawn again. Above the roughly 1 s rAF interval of occluded windows in automated browsers.
 */
const RESUME_GAP_MS = 2000;

/**
 * WebGPU-first 3D globe viewer.
 *
 * World space is ECEF (meters, +Z north). `renderer.highPrecision` computes
 * model-view matrices in float64 on the CPU, and each tile carries its own
 * origin (RTC), so geometry stays jitter-free from orbit down to street level.
 * Depth uses a reversed-Z float buffer when available.
 */
export class GeoViewer {
  /** @advanced The three.js renderer (positioning DOM over the canvas, custom passes). */
  readonly renderer: WebGPURenderer;
  /**
   * @advanced The three.js scene. World space is ECEF meters: put added
   * meshes' origin in `position` near their geometry to keep float32 precision.
   */
  readonly scene = new Scene();
  /**
   * @advanced The camera, for projecting positions. Move it with `setView` /
   * `flyTo` / `navigation` / `controller.playAnimation`, not directly.
   */
  readonly camera: PerspectiveCamera;
  readonly ellipsoid = Ellipsoid.WGS84;
  /** @advanced Quadtree globe: imagery and terrain swaps, load tuning, `stats`. */
  readonly globe: Globe;
  readonly controller: GlobeCameraController;
  /** @internal */
  readonly stars = new StarField();
  /** Animated cloud layer over the imagery (hidden by default: `clouds.visible = true`). */
  readonly clouds: CloudLayer;
  /** UI-free navigation commands: zoom, rotate, tilt, home, orbit, fullscreen, screenshot, opening spin. */
  readonly navigation: NavigationControls;
  /** @internal */
  readonly sunLight = new DirectionalLight(0xffffff, 3);
  /** @internal */
  readonly skyLight = new HemisphereLight(0xbcd7ff, 0x4a4136, 1.1);
  /** @internal Sky and ground light from the atmosphere when `lighting` is on (M3.5); intensity 0 otherwise. */
  readonly skyProbe = new LightProbe(undefined, 0);
  readonly events = new EventEmitter<ViewerEvents>();
  readonly info: RendererInfo;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, gpuMs: null, drawCalls: 0, triangles: 0, throttled: false, still: false, samples: 0 };
  readonly tilesets: Tiles3DLayer[] = [];
  /** @internal Worker-backed vector pipeline (draped rasterization, queries). */
  readonly vectors = new VectorService();
  /** Raster overlay layers + rasterized vectors, draped over the base imagery. */
  readonly overlays = new OverlayCompositor(this.vectors);
  /** @internal */
  readonly labels: LabelManager;
  readonly vectorLayers: GeoJsonLayer[] = [];
  /** HTML markers / top cards (顶牌) anchored to world positions. */
  readonly markers: MarkerManager;
  /** @internal Occlusion queries behind markers with `occlusion: 'hide' | 'fade'` (M2.2). */
  readonly markerOcclusion: OcclusionProxies;
  /** Data-driven point marker layers (点位), drawn through `markers`. */
  readonly pointLayers: PointLayer[] = [];
  /** 3D Gaussian splatting scenes placed on the globe (`addSplats`). */
  readonly splatLayers: SplatLayer[] = [];
  /** Pointer events resolved to scene objects (click / dblclick / hover with selectors). */
  readonly interaction: InteractionManager;
  /** Buildings, floors, rooms and equipment; indoor level navigation. */
  readonly indoor: IndoorManager;
  /** @internal Ground grid and studio sky under a building shown without any ground (see `indoorBackdrop`). */
  readonly backdrop: IndoorBackdrop;
  /**
   * Local scene ("sandbox"): show one area of the globe on its own, with walls, a studio
   * background and the camera kept around it (`localScene.enter({ region })`). A mode of the
   * globe scene, independent of the indoor levels.
   */
  readonly localScene: LocalScene;
  /** Walls of the local scene. */
  private readonly regionWalls = new RegionWalls();
  /** "Dim outside" look of the local scene. */
  private readonly regionDim = new RegionDimEffect();
  /**
   * Outlines and glow of three.js objects, outline styles and the look of both effects
   * (entities: `entity.effects`; selection and hover: `indoor.selectOutline` / `hoverOutline`).
   */
  readonly effects: ViewerEffects;
  /**
   * @advanced Post-processing pipeline (M3.1): every frame goes through it; add custom
   * effects with `postProcessing.add(effect)` (see `PostEffect`).
   */
  readonly postProcessing: PostPipeline;
  /**
   * Still supersampling (M3.3): a still view is refined over a few frames, then not drawn until
   * something changes (`enabled`, `samples`; `GeoViewerOptions.supersampling`).
   */
  readonly supersampling: Supersampling;
  /** Exposure, contrast and saturation of the picture (`GeoViewerOptions.colorGrading`). */
  readonly colorGrading: ColorGrading;
  /**
   * Sun shadows (M3.9): buildings and devices shade themselves, the globe and 3D Tiles while
   * `lighting` is on and the sun is up (`enabled`, `intensity`, `softness`, `maxDistance`, `mapSize`).
   */
  readonly shadows: SunShadows;
  /** Order-independent transparency of buildings and devices (M3.9; `orderIndependent`, `supported`, `active`). */
  readonly transparency: Transparency;
  /**
   * @advanced Dissolve of the previous picture over level changes, reprojected with its depth as
   * the camera flies (`duration` in ms, 0 turns it off; `reproject`).
   */
  readonly levelTransition: LevelTransition;
  /**
   * @advanced GPU pick buffer (M2.1): hover and click picks read it while it matches
   * the current view, else cast CPU rays. Null on the WebGL backend.
   * Call `invalidate()` after changes its signature cannot see.
   */
  readonly pickBuffer: PickBuffer<Tiles3DLayer> | null;
  /**
   * Budgets of the GPU tier in effect (`info.tier`). 3D Tiles layers read
   * `gpu.tiles` when they are added; the globe values are applied at startup.
   */
  readonly gpu: GpuProfile;
  /** Language of the SDK's own display text (`GeoViewerOptions.locale`). */
  readonly locale: LocaleId;
  /** The SDK's own display text in effect: `locale` with `GeoViewerOptions.messages` merged over it. */
  readonly messages: ViewerMessages;
  /**
   * Show the studio backdrop (ground grid, gradient sky) inside a building
   * when nothing else is drawn around it: globe hidden and no active 3D Tiles.
   */
  indoorBackdrop = true;

  /** Simulated date driving the sun and star positions. */
  date = new Date();
  /** Simulated seconds per real second (0 = paused). */
  timeMultiplier = 0;

  private _lighting = false;
  private _atmosphere = true;
  /** Sun color and sky light at the view from the CPU atmosphere model (M3.5). */
  private readonly atmosphereLight = new AtmosphereLighting();
  /** Buildings casting sun shadows this frame (reused). */
  private readonly shadowCasters: (ShadowCaster & { matrix: Matrix4 })[] = [];
  private _showGlobe = true;
  private _showStars = true;
  private readonly container: HTMLElement;
  private readonly raycaster = new Raycaster();
  /** Vertical rays onto 3D Tiles for `surfaceHeight` (separate from the pointer raycaster). */
  private readonly surfaceRaycaster = new Raycaster();
  /** Unified ground height: terrain with the globe, 3D Tiles without it (`surfaceHeight`). */
  private readonly surface: SurfaceHeightQuery;
  private readonly cameraCarto: Cartographic = cartographic();
  /** Ground height under the camera from the last collision query (meters above the ellipsoid; 0 until known). */
  private viewGround = 0;
  /** Seconds the globe has been hidden, and whether its tile cache was released for it. */
  private globeHiddenFor = 0;
  private globeReleased = false;
  private loaders: LoaderKit | null = null;
  private decoderPath = '';
  private transcoderPath = '';
  /** What `adoptContainer` changed on the host's element, undone by `dispose()`. */
  private containerRestore: (() => void) | null = null;
  private gltfLoader: GLTFLoader | null = null;
  private tilesetsSuppressed = false;
  /** Until when suppressed 3D Tiles keep loading for buildings still waiting for ground (`performance.now()` ms). */
  private probeUntil = 0;
  private _loadState: LoadState = { globe: 0, tilesets: 0, layers: 0, pending: 0, idle: false };
  private readonly loadTracker = new LoadTracker();
  private lastTime = -1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private timestampPending = false;
  /** Idle frame-rate throttling (P2.1a). */
  private readonly pacer: FramePacer;
  /** Whether the container intersects the viewport; frames stop while it does not. */
  private onScreen = true;
  private intersectionObserver: IntersectionObserver | null = null;
  /** Objects and entities drawn with outlines or glow. */
  private readonly marks: EffectMarks;
  /** Draw calls and triangles of the last scene pass (not the post-processing or pick passes). */
  private sceneDrawCalls = 0;
  private sceneTriangles = 0;
  /** Overlay version seen by the last tick: raster overlays or GeoJSON changed when it moves. */
  private overlayVersion = -1;
  /**
   * What the last frame saw of things that change the picture without telling the viewer
   * (`pictureChanged`): camera matrices, drawing buffer size, globe surface, simulated date,
   * tone mapping, tile debug switches.
   */
  private readonly lastPicture = new Float64Array(32 + 8);
  /** `performance.now()` of the last frame drawn (live or sample). */
  private lastDrawAt = -Infinity;
  /** Timestamp of the last animation frame (run or skipped), to notice that frames resumed after a pause. */
  private lastAnimationFrame = -1;
  /**
   * Input on the container wakes the frame loop up to the full rate. It does not change the
   * picture by itself (what it leads to does: camera motion, hover, selection), so a still,
   * supersampled view stays as it is while the pointer moves over it.
   */
  private readonly onInput = () => this.wake();

  static async create(options: GeoViewerOptions): Promise<GeoViewer> {
    // Fail fast (before any GPU work) on what plain JavaScript hosts can get wrong.
    checkViewerOptions(options);
    // The tier decides MSAA, which is fixed once the renderer exists: look at the adapter first.
    const tier = options.gpuTier ?? classifyGpu(await detectGpuHints());
    const profile = gpuProfile(tier);
    const renderer = new WebGPURenderer({
      antialias: options.antialias ?? profile.antialias,
      reversedDepthBuffer: true,
      forceWebGL: options.forceWebGL ?? false,
      trackTimestamp: true,
      powerPreference: 'high-performance',
    } as ConstructorParameters<typeof WebGPURenderer>[0]);
    await renderer.init();
    return new GeoViewer(options, renderer, profile);
  }

  private constructor(options: GeoViewerOptions, renderer: WebGPURenderer, profile: GpuProfile) {
    this.container = options.container;
    this.pacer = new FramePacer(normalizeIdleFrameRate(options.idleFrameRate ?? DEFAULT_IDLE_FRAME_RATE), performance.now());
    this.renderer = renderer;
    this.gpu = profile;
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.messages = resolveMessages(this.locale, options.messages);
    this.adoptContainer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = renderer.backend as any;
    const isWebGPU = backend.isWebGPUBackend === true;
    // GPU timings are only read on WebGPU (`info.timestampQuery`); on WebGL the timer queries cost
    // a query per pass and warn when post-processing passes start them back to back.
    if (!isWebGPU) backend.trackTimestamp = false;
    // Float64 model-view matrices: required for planet-scale coordinates.
    renderer.highPrecision = true;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    const pixelRatio = effectivePixelRatio(window.devicePixelRatio, options.maxPixelRatio ?? profile.maxPixelRatio);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 1);
    renderer.domElement.classList.add('tv-canvas');
    renderer.domElement.tabIndex = 0;
    this.container.appendChild(renderer.domElement);
    if (options.decoderPath) this.decoderPath = options.decoderPath;
    if (options.transcoderPath) this.transcoderPath = options.transcoderPath;

    this.info = {
      backend: isWebGPU ? 'WebGPU' : 'WebGL2',
      reversedDepth: renderer.reversedDepthBuffer === true,
      highPrecision: renderer.highPrecision,
      timestampQuery: isWebGPU ? backend.trackTimestamp === true : false,
      adapter: describeAdapter(backend),
      tier: profile.tier,
      tierSource: options.gpuTier ? 'option' : 'auto',
      samples: Math.max(1, (renderer as unknown as { samples?: number }).samples ?? 1),
      pixelRatio,
    };

    this.camera = new PerspectiveCamera(50, 1, 1, 1e8);
    this.camera.name = 'GlobeCamera';

    this.globe = new Globe({
      ...options,
      maxCachedTiles: options.maxCachedTiles ?? profile.globe.maxCachedTiles,
      maxAnisotropy: options.maxAnisotropy ?? profile.globe.maxAnisotropy,
    });
    this.globe.reportError = (source, error) => this.events.emit('error', { source, error });
    this.surface = new SurfaceHeightQuery({
      globeShown: () => this._showGlobe,
      terrain: (lon, lat) => {
        const s = this.globe.sampleHeight(lon, lat);
        return s && { height: s.height, resolution: s.cellSize };
      },
      tilesActive: () => this.tilesets.some((l) => l.measurable),
      raycastTiles: (lon, lat) => this.raycastTilesVertical(lon, lat),
      now: () => performance.now(),
    });
    this.globe.setOverlaySource(this.overlays);
    this.scene.add(this.globe.group);
    this.labels = new LabelManager(this.ellipsoid);
    this.labels.heightProvider = (lon, lat) => (this._showGlobe ? this.globe.getHeight(lon, lat) : 0);
    this.scene.add(this.labels.group);
    this.scene.add(this.stars.mesh);
    this.clouds = new CloudLayer(this.ellipsoid);
    this.clouds.onChange = () => this.requestRender();
    if (options.clouds) this.clouds.set(options.clouds);
    this.scene.add(this.clouds.mesh);
    this.scene.add(this.sunLight, this.sunLight.target, this.skyLight, this.skyProbe);
    this.scene.background = new Color(0x000000);
    this.backdrop = new IndoorBackdrop(this.ellipsoid);
    this.scene.add(this.backdrop.group);
    const sky = skyColorNode(positionWorldDirection).add(vec3(0.0006, 0.0008, 0.0016));
    const studioSky = this.backdrop.backgroundNode(positionWorldDirection);

    this.markers = new MarkerManager(this.container, renderer.domElement);
    this.markerOcclusion = new OcclusionProxies(renderer);
    this.scene.add(this.markerOcclusion.group);
    this.markers.occlusion = this.markerOcclusion;
    this.indoor = new IndoorManager({
      messages: this.messages,
      // Entities changed from code (styles, visibility, moves), models arrived, indoor options set.
      contentChanged: (geometry) => {
        if (geometry) this.pickBuffer?.invalidate();
        // Visibility, transparency (casting) or placement may have changed (also during construction: optional).
        this.shadows?.invalidate();
        this.requestRender();
      },
      ellipsoid: this.ellipsoid,
      camera: this.camera,
      markers: this.markers,
      // Buildings follow the ground (terrain, or 3D Tiles without the globe) once it is reasonably
      // detailed; otherwise null keeps the height they have (no floating on coarse estimates, no drop
      // to 0 m while the tiles are suppressed inside the building).
      groundHeight: (lon, lat) => {
        const s = this.surface.query(lon, lat);
        return s.reliable ? s.height : null;
      },
      flyToView: (view, duration) => this.flyToTarget({ target: view.target, heading: view.heading, pitch: view.pitch, range: view.range, duration }),
      getCameraPose: () => {
        const { heading, pitch } = this.getView();
        // What the view is centered on, so flying back can keep it in frame.
        const target = this.gesturePick(CENTER_NDC)?.clone();
        return { position: this.camera.position.clone(), heading, pitch, target };
      },
      flyToPose: (pose, duration) =>
        this.controller.flyTo({ position: pose.position.clone(), heading: pose.heading * DEG2RAD, pitch: pose.pitch * DEG2RAD }, duration, { lookAt: pose.target }),
      beginTransition: () => this.beginLevelTransition(),
      setTilesetsVisible: (visible) => this.setTilesetsSuppressed(!visible),
      loadModel: (uri) => this.loadModel(uri),
      followMove: (delta) => this.controller.translate(delta),
      occlusionBaker: new FloorOcclusionBaker(renderer),
      ambientOcclusion: { maxResolution: profile.indoor.aoMaxResolution, ...options.ambientOcclusion },
    });
    this.scene.add(this.indoor.root);
    this.marks = new EffectMarks(this.scene);
    this.marks.extraSources = () => this.indoor.markedEntities;
    this.marks.onChange = () => this.requestRender();
    this.postProcessing = new PostPipeline(renderer, this.scene, this.camera);
    const outline = new OutlineEffect(this.marks);
    const glow = new GlowEffect(this.marks);
    const grading = new ColorGradingEffect();
    this.levelTransition = new LevelTransition(this.postProcessing, renderer, this.camera);
    this.postProcessing.add(glow);
    this.postProcessing.add(grading);
    this.postProcessing.add(this.levelTransition);
    this.postProcessing.add(outline);
    this.effects = new ViewerEffects(this.marks, outline, glow, () => this.requestRender());
    this.colorGrading = new ColorGrading(renderer, grading, () => this.requestRender());
    if (options.colorGrading) this.colorGrading.set(options.colorGrading);
    this.supersampling = new Supersampling(
      this.postProcessing,
      this.info.samples > 1,
      { changed: () => this.requestRender(), wake: () => this.wake() },
      options.supersampling,
    );
    // Sun shadows (M3.9): our own map, read by lit materials through the sun light's shadow node
    // (three's shadow passes are not used) and by globe tiles directly. `shadowMap.enabled` only
    // lets lit materials take the node; `castShadow` follows `shadows.enabled` (receivers rebuild once).
    renderer.shadowMap.enabled = true;
    (this.sunLight.shadow as unknown as { shadowNode: unknown }).shadowNode = sunShadowFactor();
    this.shadows = new SunShadows(renderer, profile.shadows, typeof options.shadows === 'boolean' ? { enabled: options.shadows } : (options.shadows ?? {}), (toggled) => {
      if (toggled) this.sunLight.castShadow = this.shadows.enabled;
      this.requestRender();
    });
    this.sunLight.castShadow = this.shadows.enabled;
    // Building and device surfaces (entity meshes and device batches) blend order-independently.
    this.postProcessing.oitTest = (object) => object.userData.entity !== undefined || (object as { isBatchMesh?: boolean }).isBatchMesh === true;
    this.transparency = new Transparency(
      this.postProcessing,
      () => this.requestRender(),
      { orderIndependent: profile.orderIndependentTransparency, supported: isWebGPU },
      options.transparency,
    );
    // Statistics of the scene pass alone (the pick buffer's signature and `stats`); the pick pass renders the scene later.
    this.scene.onAfterRender = (r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (r as any).info;
      this.sceneDrawCalls = info.render?.drawCalls ?? info.render?.calls ?? 0;
      this.sceneTriangles = info.render?.triangles ?? 0;
    };
    this.indoor.modelBytesTarget = this.gpu.indoor.modelBytesTarget;
    this.indoor.modelUnloadDelayMs = this.gpu.indoor.unloadDelayMs;
    if (options.contributionCulling) this.indoor.culling.configure(options.contributionCulling);
    // Integer render targets and async read back: WebGPU only; WebGL keeps casting rays.
    this.pickBuffer =
      this.info.backend === 'WebGPU' ? new PickBuffer<Tiles3DLayer>({ renderer, scene: this.scene, camera: this.camera, classify: (o) => this.classifyPick(o) }) : null;
    // Level changes show and hide content without necessarily changing the draw statistics.
    for (const type of ['enterLevel', 'leaveLevel', 'buildings-changed'] as const)
      this.indoor.events.on(type, () => {
        this.pickBuffer?.invalidate();
        this.shadows.invalidate();
      });
    // Level changes, selection and hover change what is drawn: back to the full frame rate.
    for (const type of ['beforeEnterLevel', 'enterLevel', 'leaveLevel', 'buildings-changed', 'select', 'hover'] as const) {
      this.indoor.events.on(type, () => this.requestRender());
    }

    const host: ControllerHost = {
      camera: this.camera,
      ellipsoid: this.ellipsoid,
      domElement: renderer.domElement,
      keyboardTarget: this.container,
      pick: (ndc) => this.gesturePick(ndc),
      groundHeight: (lon, lat) => this.collisionGround(lon, lat),
    };
    this.controller = new GlobeCameraController(host);
    this.interaction = new InteractionManager({
      domElement: renderer.domElement,
      pickAt: (x, y) => this.pickAt(x, y),
      toCartographic: (p) => this.ellipsoid.cartesianToCartographic(p),
    });
    this.controller.doubleClickHandler = (e) => this.interaction.dispatchDoubleClick(e);
    this.scene.add(this.regionWalls.mesh);
    this.postProcessing.add(this.regionDim);
    this.localScene = this.createLocalScene();
    // Background: the atmosphere, the studio sky of a building without ground, or the local scene's own.
    const ls = this.localScene;
    const localSky = mix(studioSkyNode(positionWorldDirection, ls.skyUp), ls.backgroundColor, ls.backgroundSolid);
    this.scene.backgroundNode = mix(mix(sky, studioSky, this.backdrop.amount), localSky, ls.backgroundAmount);
    // Camera motion of any origin (gestures, flights, animations, inertia, auto-orbit) keeps the full frame rate.
    this.controller.events.on('change', () => this.requestRender());
    // A gesture starting changes nothing yet (a click without a drag must not discard a supersampled view).
    this.controller.events.on('interactionstart', () => this.wake());
    for (const type of ['tilesets-changed', 'vectors-changed', 'points-changed', 'splats-changed'] as const) this.events.on(type, () => this.requestRender());
    // Labels sit above the canvas: their clicks reach the interaction listeners as clicks on the entity.
    this.markers.eventProxy = (type, marker, event) => {
      const entity = marker.options.userData?.entity;
      if (!(entity instanceof BimEntity)) return;
      const p = marker.options.position;
      const point = typeof p === 'function' ? (p()?.clone() ?? null) : p.clone();
      this.interaction.dispatchProxy(type, entity, event, { marker, point });
    };
    this.installIndoorBehaviors();

    const v = options.initialView ?? DEFAULT_VIEW;
    this.setView(v);
    this.navigation = new NavigationControls(this, this.container, options.homeView ?? v);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.requestRender();
    });
    this.resizeObserver.observe(this.container);
    this.resize();
    for (const type of INPUT_EVENTS) this.container.addEventListener(type, this.onInput, { passive: true });
    // Nothing to see while the container is scrolled away or not displayed: stop drawing.
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const visible = entries[entries.length - 1]?.isIntersecting ?? true;
        if (visible && !this.onScreen) this.requestRender();
        this.onScreen = visible;
      });
      this.intersectionObserver.observe(this.container);
    }
    void renderer.setAnimationLoop((t: number) => this.tick(t));
  }

  // ---------------------------------------------------------------------------
  // Scene settings

  get lighting(): boolean {
    return this._lighting;
  }

  /** Real sun position and day/night shading (otherwise imagery is shown unlit). */
  set lighting(v: boolean) {
    this._lighting = v;
    this.requestRender();
  }

  get atmosphere(): boolean {
    return this._atmosphere;
  }

  set atmosphere(v: boolean) {
    this._atmosphere = v;
    this.requestRender();
  }

  get showGlobe(): boolean {
    return this._showGlobe;
  }

  set showGlobe(v: boolean) {
    this._showGlobe = v;
    this.requestRender();
    this.globe.group.visible = v;
    if (v) {
      this.globeHiddenFor = 0;
      this.globeReleased = false;
    }
  }

  /** Estimated memory use of the viewer's own allocations, in bytes (see `MemoryReport`). */
  get memory(): MemoryReport {
    const canvas = this.renderer.domElement;
    const framebuffers = estimateFramebufferBytes({ width: canvas.width, height: canvas.height, samples: this.info.samples }) +
      (this.pickBuffer?.gpuBytes ?? 0) +
      this.postProcessing.gpuBytes;
    const globe = this.globe.gpuBytes;
    let tilesGpu = 0;
    let tilesCache = 0;
    let tilesCacheMax = 0;
    for (const layer of this.tilesets) {
      const m = layer.memory;
      tilesGpu += m.gpuBytes;
      // One cache for all tilesets.
      tilesCache = m.cachedBytes;
      tilesCacheMax = m.cacheMaxBytes;
    }
    const buildings = this.indoor.modelBytes + this.indoor.ambientOcclusion.bytes;
    const shadows = this.shadows.bytes;
    let splats = 0;
    for (const layer of this.splatLayers) splats += layer.gpuBytes;
    return { framebuffers, globe, tilesGpu, buildings, shadows, splats, gpuTotal: framebuffers + globe + tilesGpu + buildings + shadows + splats, tilesCache, tilesCacheMax };
  }

  /**
   * @advanced Diagnostics of the viewer as of the last frame, JSON-serializable (`ViewerSnapshot`,
   * roadmap M5.1): `JSON.stringify(viewer.snapshot())` for a bug report.
   */
  snapshot(): ViewerSnapshot {
    const indoor = this.indoor;
    const c = this.sunLight.color;
    return {
      time: new Date().toISOString(),
      date: this.date.toISOString(),
      info: { ...this.info },
      stats: { ...this.stats },
      memory: this.memory,
      load: { ...this._loadState },
      view: this.getView(),
      scene: {
        lighting: this._lighting,
        atmosphere: this._atmosphere,
        showGlobe: this._showGlobe,
        showStars: this._showStars,
        clouds: this.clouds.mesh.visible,
        timeMultiplier: this.timeMultiplier,
      },
      globe: { ...this.globe.stats, shown: this._showGlobe },
      tilesets: this.tilesets.map((l) => ({ id: l.id, name: l.name, visible: l.visible, active: l.active, pending: l.pending, errorScale: l.errorScale, memory: { ...l.memory } })),
      layers: { vector: this.vectorLayers.length, points: this.pointLayers.length, markers: { ...this.markers.stats } },
      splats: this.splatLayers.map((l) => ({ id: l.id, name: l.name, ready: l.ready, visible: l.visible, active: l.active, gpuBytes: l.gpuBytes, stats: l.stats && { ...l.stats } })),
      indoor: {
        buildings: indoor.buildings.length,
        current: indoor.current ? { id: indoor.current.id, type: indoor.current.type } : null,
        selected: indoor.selected?.id ?? null,
        modelBytes: indoor.modelBytes,
        ambientOcclusion: { enabled: indoor.ambientOcclusion.enabled, floors: indoor.ambientOcclusion.bakedFloors, bytes: indoor.ambientOcclusion.bytes },
        culling: { enabled: indoor.culling.enabled, ...indoor.culling.stats },
      },
      post: {
        effects: this.postProcessing.effects.map((e) => ({ name: e.name, stage: e.stage, active: e.active })),
        samples: this.postProcessing.samples,
        supersampling: this.supersampling.enabled,
        transitionMs: this.levelTransition.duration,
        transparency: { orderIndependent: this.transparency.orderIndependent, supported: this.transparency.supported, active: this.transparency.active },
      },
      lights: { sunColor: [c.r, c.g, c.b], sunIntensity: this.sunLight.intensity, hemisphere: this.skyLight.intensity, skyProbe: this.skyProbe.intensity },
      shadows: { enabled: this.shadows.enabled, active: this.shadows.active, mapSize: this.shadows.mapSize, texelSize: this.shadows.texelSize, maxDistance: this.shadows.maxDistance },
    };
  }

  get showStars(): boolean {
    return this._showStars;
  }

  set showStars(v: boolean) {
    this._showStars = v;
    this.requestRender();
    this.stars.mesh.visible = v;
  }

  // ---------------------------------------------------------------------------
  // Camera

  setView(v: ViewPosition): void {
    this.requestRender();
    const pos = this.ellipsoid.cartographicToCartesian(v.longitude * DEG2RAD, v.latitude * DEG2RAD, v.height);
    this.controller.setView(pos, (v.heading ?? 0) * DEG2RAD, (v.pitch ?? -90) * DEG2RAD);
  }

  flyTo(v: ViewPosition, duration?: number): Promise<void> {
    const position = this.ellipsoid.cartographicToCartesian(v.longitude * DEG2RAD, v.latitude * DEG2RAD, v.height);
    return this.controller.flyTo({ position, heading: (v.heading ?? 0) * DEG2RAD, pitch: (v.pitch ?? -90) * DEG2RAD }, duration);
  }

  /** Flies to look at a target from a heading / pitch / range. */
  flyToTarget(view: TargetView): Promise<void> {
    const t = view.target;
    const target = t instanceof Vector3 ? t.clone() : this.ellipsoid.cartographicToCartesian(t.longitude * DEG2RAD, t.latitude * DEG2RAD, t.height ?? 0);
    const heading = (view.heading ?? this.getView().heading) * DEG2RAD;
    const pitch = (view.pitch ?? -45) * DEG2RAD;
    const position = new Vector3();
    lookAtHeadingPitchRange(this.ellipsoid, target, heading, pitch, view.range ?? 500, position, new Quaternion());
    return this.controller.flyTo({ position, heading, pitch }, view.duration, { lookAt: target });
  }

  /** Fly so that a bounding sphere fills the view, looking at it from the south-east at 35 degrees. */
  flyToSphere(sphere: Sphere, heading = -30, pitch = -35, duration?: number, options: SphereFlightOptions = {}): Promise<void> {
    const fov = this.camera.getEffectiveFOV() * DEG2RAD;
    const range = Math.max((sphere.radius / Math.sin(fov / 2)) * (options.rangeScale ?? 1), options.minRange ?? 50) * 1.15;
    const position = new Vector3();
    const q = this.camera.quaternion.clone();
    lookAtHeadingPitchRange(this.ellipsoid, sphere.center, heading * DEG2RAD, pitch * DEG2RAD, range, position, q);
    return this.controller.flyTo({ position, heading: heading * DEG2RAD, pitch: pitch * DEG2RAD }, duration, { lookAt: sphere.center.clone() });
  }

  /** Flies to frame a building, floor, room or thing (ThingJS `camera.fit(obj)`). */
  flyToEntity(entity: BimEntity, options: { heading?: number; pitch?: number; rangeScale?: number; duration?: number } = {}): Promise<void> {
    const sphere = entity.worldBounds();
    if (!sphere) return Promise.resolve();
    return this.flyToSphere(sphere, options.heading ?? this.getView().heading, options.pitch ?? -40, options.duration, {
      rangeScale: options.rangeScale ?? 1.5,
      minRange: 4,
    });
  }

  /**
   * Orbits the camera around the view center (or a point) until interrupted
   * (ThingJS `rotateAround`). Does nothing (resolves at once) when the pivot
   * is farther than `navigation.autoRotate.orbitMaxDistance` from the camera:
   * from a global view it would just swing the planet around (use
   * `navigation.startAutoRotate()`, which spins the globe there instead).
   */
  startAutoOrbit(options: AutoOrbitOptions = {}): Promise<void> {
    const pivot = this.navigation.orbitPivot(options.pivot);
    if (!pivot) return Promise.resolve();
    return this.controller.startAutoOrbit({ ...options, pivot });
  }

  stopAutoOrbit(): void {
    this.controller.stopAutoOrbit();
  }

  /**
   * Opening animation: the globe spins and slows to a stop on the current
   * view (see `IntroSpinOptions`). Skipped below `minHeight`; any gesture or
   * flight interrupts it. Resolves true when it ran to the end.
   */
  playIntro(options?: IntroSpinOptions): Promise<boolean> {
    return this.navigation.playIntro(options);
  }

  /** Rotates the view back to north-up around the point at the screen center. */
  resetNorth(): void {
    const { heading } = this.getView();
    const delta = -(((heading + 180) % 360) - 180) * DEG2RAD;
    const pivot = this.pick(new Vector2(0, 0))?.point;
    if (pivot) {
      void this.controller.rotateHeadingAround(pivot, delta);
    } else {
      const v = this.getView();
      void this.flyTo({ ...v, heading: 0 }, 0.8);
    }
  }

  /** Current camera as degrees / meters. */
  getView(): Required<ViewPosition> {
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position) ?? cartographic();
    const hp = getHeadingPitch(this.ellipsoid, this.camera.position, this.camera.quaternion);
    return {
      longitude: c.longitude / DEG2RAD,
      latitude: c.latitude / DEG2RAD,
      height: c.height,
      heading: ((hp.heading / DEG2RAD) % 360 + 360) % 360,
      pitch: hp.pitch / DEG2RAD,
    };
  }

  // ---------------------------------------------------------------------------
  // Picking

  /**
   * Closest surface hit (buildings, 3D Tiles, Gaussian splats or globe) at normalized device
   * coordinates. `buffer: true` answers from the GPU pick buffer while it is fresh; splat
   * layers are not in that buffer and are always tested with a ray (`SplatLayer.raycast`).
   */
  pick(ndc: Vector2, options: { buffer?: boolean } = {}): SurfacePick | null {
    const surface = this.pickSurface(ndc, options);
    if (this.splatLayers.length === 0) return surface;
    // Splats in front of that surface (they write no depth, so neither the buffer nor the meshes know them).
    const ray = this.viewRay(ndc);
    const ls = this.localScene;
    let best = surface;
    for (const layer of this.splatLayers) {
      const hit = layer.raycast(ray, { maxDistance: best?.distance });
      if (!hit || (ls.hidesOutside && !ls.showsWorld(hit.point))) continue;
      best = { point: hit.point, source: 'splats', distance: hit.distance, splats: layer, splatIndex: hit.index, via: 'ray' };
    }
    return best;
  }

  /** Closest hit on what the pick buffer knows: buildings, 3D Tiles and the globe. */
  private pickSurface(ndc: Vector2, options: { buffer?: boolean }): SurfacePick | null {
    if (options.buffer) {
      const g = this.pickFromBuffer(ndc);
      if (g !== undefined) return g;
    }
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    let best: SurfacePick | null = null;
    // A local scene hiding its surroundings: what is clipped away cannot be hit either.
    const ls = this.localScene;
    const accept = ls.hidesOutside ? (p: Vector3) => ls.showsWorld(p) : undefined;
    const entity = this.indoor.pick(this.raycaster);
    if (entity) best = { point: entity.point.clone(), source: 'entity', distance: entity.distance, entity: entity.entity, via: 'ray' };
    // All hits, not just the first: the first may be clipped away.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (accept) (this.raycaster as any).firstHitOnly = false;
    for (const layer of this.tilesets) {
      if (!layer.active || !layer.ready) continue;
      const hit = this.raycaster.intersectObject(layer.group, true).find((h) => !accept || accept(h.point));
      if (hit && hit.distance < (best?.distance ?? Infinity)) {
        best = { point: hit.point.clone(), source: 'tiles', distance: hit.distance, tileset: layer, via: 'ray' };
      }
    }
    if (this._showGlobe) {
      const g = this.globe.raycast(this.raycaster.ray, accept);
      if (g && g.distance < (best?.distance ?? Infinity)) best = { point: g.point, source: 'globe', distance: g.distance, via: 'ray' };
    }
    return best;
  }

  /**
   * Pick from the GPU pick buffer; undefined when it cannot answer (no fresh
   * buffer, or a sample it cannot resolve), so the caller casts a ray.
   */
  private pickFromBuffer(ndc: Vector2): SurfacePick | null | undefined {
    const hit = this.pickBuffer?.lookup((ndc.x + 1) / 2, (1 - ndc.y) / 2);
    if (hit === undefined) return undefined;
    if (hit === null) return null;
    const base = { point: hit.point, distance: hit.distance, normal: hit.normal, via: 'buffer' as const };
    if (hit.target.kind === 'entity') {
      const entity = this.indoor.entityForHit(hit.object, hit.instanceId);
      return entity ? { ...base, source: 'entity', entity } : undefined;
    }
    if (hit.target.kind === 'tiles') return { ...base, source: 'tiles', tileset: hit.target.layer };
    return { ...base, source: 'globe' };
  }

  /** What a mesh stands for in the pick buffer: buildings, 3D Tiles and globe tiles; nothing else is pickable. */
  private classifyPick(object: Object3D): PickTarget<Tiles3DLayer> | null {
    for (let x: Object3D | null = object; x; x = x.parent) {
      if (x === this.indoor.root) return { kind: 'entity' };
      if (x === this.globe.group) return { kind: 'globe' };
      const layer = this.tilesets.find((l) => l.group === x);
      if (layer) return { kind: 'tiles', layer };
    }
    return null;
  }

  /** What lies under a client-space pixel (used by the interaction manager). */
  pickAt(clientX: number, clientY: number): PickInfo {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc, { buffer: true });
    const layer = hit?.source === 'tiles' ? (hit.tileset ?? null) : null;
    // Resolved on demand from the view ray of this pick: hovers that never ask cost no CPU ray.
    let feature: TileFeature | null | undefined = layer ? undefined : null;
    const ray = layer ? this.viewRay(_ndc).clone() : null;
    return {
      kind: hit ? hit.source : 'none',
      entity: hit?.entity ?? null,
      tileset: hit?.tileset ?? null,
      splats: hit?.splats ?? null,
      point: hit?.point ?? null,
      cartographic: hit ? this.ellipsoid.cartesianToCartographic(hit.point) : null,
      clientX,
      clientY,
      marker: null,
      tileFeature: () => (feature === undefined ? (feature = this.tileFeatureOnRay(ray!, layer!)) : feature),
    };
  }

  /**
   * The 3D Tiles feature under a client-space pixel: its feature ID and properties from
   * `EXT_mesh_features` / `EXT_structural_metadata` or the batch table (b3dm, i3dm). Null when
   * the closest surface there is not a 3D Tiles layer, or its content has no readable feature
   * IDs there (no metadata, or feature ID textures, which are not read). Casts a CPU ray.
   * In interaction listeners use `event.tileFeature()`, which reuses the event's pick.
   */
  pickTileFeature(clientX: number, clientY: number): TileFeature | null {
    return this.pickAt(clientX, clientY).tileFeature?.() ?? null;
  }

  /**
   * Highlights a picked 3D Tiles feature (null clears): its triangles are tinted in the tile
   * it was picked on (default `#ffd23f` at 50 % opacity). One feature at a time across all
   * layers. Feature IDs only exist within one tile's content, so the highlight goes away when
   * that tile is unloaded or replaced by another level of detail; removing the layer clears it.
   */
  highlightTileFeature(feature: TileFeature | null, style?: FeatureHighlightStyle): void {
    for (const layer of this.tilesets) if (layer !== feature?.layer && layer.highlighted) layer.setHighlight(null);
    if (feature && this.tilesets.includes(feature.layer)) feature.layer.setHighlight(feature, style);
    this.requestRender();
  }

  /** The feature set by `highlightTileFeature`, or null (also after its tile was unloaded). */
  get highlightedTileFeature(): TileFeature | null {
    for (const layer of this.tilesets) if (layer.highlighted) return layer.highlighted;
    return null;
  }

  /** The camera ray through normalized device coordinates (the shared raycaster's ray). */
  private viewRay(ndc: Vector2): Ray {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** First hit of a ray on a layer's tiles, resolved to a feature. */
  private tileFeatureOnRay(ray: Ray, layer: Tiles3DLayer): TileFeature | null {
    if (!layer.active || !layer.ready || !this.tilesets.includes(layer)) return null;
    this.raycaster.ray.copy(ray);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    const hit = this.raycaster.intersectObject(layer.group, true)[0];
    return hit ? resolveTileFeature(layer, hit) : null;
  }

  /** Cartographic position (radians) under a client-space pixel. */
  pickCartographic(clientX: number, clientY: number): Cartographic | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc, { buffer: true });
    return hit ? this.ellipsoid.cartesianToCartographic(hit.point) : null;
  }

  /** Building the indoor level is in, or null on the globe. */
  private currentBuilding(): Building | null {
    return (this.indoor.current?.closest('building') as Building | null) ?? null;
  }

  /**
   * Ground height at a position, in WGS84 ellipsoidal meters: what buildings,
   * points and the camera stand on. With the globe shown it is the terrain
   * (same as `globe.getHeight`); without the globe (e.g. Google 3D Tiles) the
   * visible 3D Tiles, measured with a vertical ray and held while the tiles
   * are suppressed or not loaded there. Always returns a value: `reliable`
   * tells whether the data is at least `maxCellSize` meters detailed (default
   * 150), `source: 'ellipsoid'` (0 m) means nothing is known.
   *
   * Tile rays have a per-frame time budget; queries beyond it get the held
   * result, so repeated queries converge over a few frames.
   *
   * @param longitude Degrees east.
   * @param latitude Degrees north.
   */
  surfaceHeight(longitude: number, latitude: number, options?: SurfaceHeightOptions): SurfaceHeight {
    const outside = this.groundOutsideRegion(longitude * DEG2RAD, latitude * DEG2RAD);
    if (outside !== null) return outside;
    return this.surface.query(longitude * DEG2RAD, latitude * DEG2RAD, options);
  }

  /** Outside a local scene that hides its surroundings, the ground is the base of its walls (radians in). */
  private groundOutsideRegion(lon: number, lat: number): SurfaceHeight | null {
    const ls = this.localScene;
    if (!ls.hidesOutside) return null;
    const p = this.ellipsoid.cartographicToCartesian(lon, lat, ls.groundOutside, _localPoint);
    if (ls.showsWorld(p, 0)) return null;
    return { height: ls.groundOutside, resolution: 0, source: 'ellipsoid', reliable: true, held: false };
  }

  /** Highest active 3D Tiles surface on the vertical through a position (radians), with the hit tile's geometric error. */
  private raycastTilesVertical(lon: number, lat: number): SurfaceSample | null {
    const rc = this.surfaceRaycaster;
    const cosLat = Math.cos(lat);
    _dir.set(cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat));
    // From well above the tallest buildings and photogrammetry, straight down.
    this.ellipsoid.cartographicToCartesian(lon, lat, SURFACE_RAY_TOP, rc.ray.origin);
    rc.ray.direction.copy(_dir).negate();
    rc.near = 0;
    rc.far = SURFACE_RAY_TOP + SURFACE_RAY_BOTTOM;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rc as any).firstHitOnly = true;
    let best: SurfaceSample | null = null;
    let bestDistance = Infinity;
    for (const layer of this.tilesets) {
      if (!layer.measurable) continue;
      const hit = rc.intersectObject(layer.group, true)[0];
      if (!hit || hit.distance >= bestDistance) continue;
      bestDistance = hit.distance;
      const tile = hit.object.userData.tile as { geometricError?: number } | undefined;
      const height = this.ellipsoid.cartesianToCartographic(hit.point, _carto)?.height;
      if (height === undefined) continue;
      best = { height, resolution: tile?.geometricError ?? Infinity };
    }
    return best;
  }

  /** Ellipsoidal height of the last 3D Tiles surface a gesture picked (reference ground without the globe). */
  private lastSurfaceHeight = 0;

  /** Surface under a gesture: the scene, else the reference ground when no globe is drawn. */
  private gesturePick(ndc: Vector2): Vector3 | null {
    const hit = this.pick(ndc);
    // In a local scene, empty space is handled by the camera bounds (region center, reference ground).
    if (this.localScene.hidesOutside) return hit?.point ?? null;
    if (hit) {
      if (hit.source === 'tiles' && !this._showGlobe) this.lastSurfaceHeight = this.ellipsoid.cartesianToCartographic(hit.point, _carto)?.height ?? this.lastSurfaceHeight;
      return hit.point;
    }
    return this.pickReferenceSurface(ndc);
  }

  /**
   * @internal Where a ray at normalized device coordinates meets the ground when no
   * globe is drawn (globe hidden, e.g. for Google 3D Tiles, and the tiles
   * suppressed inside a building): the ellipsoid raised to the entered
   * building's ground, or to the last 3D Tiles surface picked. Null with the
   * globe shown, above the horizon, or below the reference ground. Camera
   * gestures need this: with nothing under the cursor a drag used to grab a
   * point deep inside the planet and threw the camera thousands of kilometers.
   * Outside a building the height is the reliable `surfaceHeight` below the
   * camera, else the last 3D Tiles surface picked.
   */
  pickReferenceSurface(ndc: Vector2): Vector3 | null {
    if (this._showGlobe) return null;
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position, _carto);
    if (!c) return null;
    let height = this.currentBuilding()?.groundHeight;
    if (height === undefined) {
      const s = this.surface.query(c.longitude, c.latitude);
      height = s.reliable ? s.height : this.lastSurfaceHeight;
    }
    if (c.height <= height) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const t = this.ellipsoid.intersectRay(this.raycaster.ray, height);
    return t === null ? null : this.raycaster.ray.at(t, new Vector3());
  }

  /**
   * Ground height for camera collision (`surfaceHeight`). Only data whose grid
   * spacing / geometric error is fine relative to the camera's height counts:
   * coarse or interpolated surfaces (common while streaming) would otherwise
   * shove the camera up. Without the globe and without reliable 3D Tiles the
   * floor is 0 m.
   */
  private collisionGround(lon: number, lat: number): number | null {
    // Beside a local scene: no diving below the base of its walls.
    const outside = this.groundOutsideRegion(lon, lat);
    if (outside) return outside.height;
    // Without the globe the entered building's ground is the floor of the world (no diving under the backdrop).
    const building = this._showGlobe ? null : this.currentBuilding();
    if (building) return building.groundHeight;
    const unknown = this._showGlobe ? null : 0;
    const coarse = this.surface.query(lon, lat, { maxCellSize: Infinity });
    if (coarse.source === 'ellipsoid') return unknown;
    this.viewGround = coarse.height;
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position, _carto);
    const above = (c?.height ?? 0) - coarse.height;
    const fine = this.surface.query(lon, lat, { maxCellSize: Math.max(50, above * 1.5) });
    return fine.reliable ? fine.height : unknown;
  }

  // ---------------------------------------------------------------------------
  // Indoor defaults (ThingJS level behavior)

  /**
   * Double click enters the next level under the cursor (building → floor →
   * room / thing), right click or Esc goes back, hovering highlights. What a
   * pick acts on comes from the current level control (`indoor.filterObject`).
   */
  private installIndoorBehaviors(): void {
    const indoor = this.indoor;
    this.interaction.on(
      'dblclick',
      (e) => {
        const next = e.entity ? indoor.nextLevel(e.entity) : null;
        if (!next) return;
        e.preventDefault();
        void indoor.enter(next);
      },
      { tag: 'indoor' },
    );
    this.interaction.on(
      'rightclick',
      () => {
        if (indoor.current) void indoor.back();
      },
      { tag: 'indoor' },
    );
    // A label click selects its own entity (e.g. an alarm card seen from the globe); scene picks select the level unit.
    this.interaction.on('click', (e) => indoor.select(e.entity ? (e.marker ? e.entity : indoor.filterObject(e.entity)) : null), { tag: 'indoor' });
    // Hover picking costs a ray cast per frame of pointer motion: only while buildings exist.
    let hoverOn = false;
    indoor.events.on('buildings-changed', () => this.extendGroundProbe());
    indoor.events.on('buildings-changed', (buildings) => {
      const want = buildings.length > 0;
      if (want === hoverOn) return;
      hoverOn = want;
      if (want) {
        this.interaction.on(
          'mousemove',
          (e) => {
            const unit = e.entity ? indoor.filterObject(e.entity) : null;
            // The level the camera is in is not highlighted, nor a building from inside.
            indoor.setHovered(unit && unit !== indoor.current && !(unit.type === 'building' && indoor.current) ? unit : null);
          },
          { tag: 'indoor-hover' },
        );
        this.interaction.on('mouseleave', (e) => !e.entity && indoor.setHovered(null), { tag: 'indoor-hover' });
      } else {
        this.interaction.off('mousemove', 'indoor-hover');
        this.interaction.off('mouseleave', 'indoor-hover');
        indoor.setHovered(null);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 3D Tiles

  /** The local scene and what it needs from the viewer. */
  private createLocalScene(): LocalScene {
    const scene = new LocalScene({
      ellipsoid: this.ellipsoid,
      renderer: this.renderer,
      camera: this.camera,
      globe: this.globe,
      controller: this.controller,
      walls: this.regionWalls,
      dim: this.regionDim,
      tilesets: () => this.tilesets,
      globeShown: () => this._showGlobe,
      setGlobeShown: (shown) => {
        this.showGlobe = shown;
      },
      lighting: () => this._lighting,
      sunDirection: () => atmosphereUniforms.lightDirection.value,
      groundHeight: (lon, lat) => {
        const s = this.surface.query(lon, lat);
        return { height: s.height, reliable: s.reliable };
      },
      tilesHeight: (lon, lat) => this.raycastTilesVertical(lon, lat)?.height ?? null,
      getView: () => this.getView(),
      flyTo: (view, duration) => this.flyTo(view, duration),
      flyToSphere: (sphere, heading, pitch, duration, rangeScale) => this.flyToSphere(sphere, heading, pitch, duration, { rangeScale }),
      requestRender: () => this.requestRender(),
    });
    // Markers and labels whose anchor is clipped away go with it.
    this.markers.regionFilter = (p) => scene.showsWorld(p);
    this.labels.regionFilter = (p) => scene.showsWorld(p);
    // Double click on empty space around the area: back to its overview.
    this.interaction.on(
      'dblclick',
      (e) => {
        if (!scene.active || e.kind !== 'none') return;
        e.preventDefault();
        void scene.fit();
      },
      { tag: 'local-scene' },
    );
    scene.events.on('exit', () => this.updateBuildingsInRegion());
    return scene;
  }

  /** Buildings outside a local scene that hides its surroundings are hidden with them. */
  private updateBuildingsInRegion(): void {
    const ls = this.localScene;
    for (const b of this.indoor.buildings) {
      const hidden = ls.hidesOutside && !ls.showsWorld(_localPoint.setFromMatrixPosition(b.root.matrixWorld), 0);
      if (hidden === (b.root.userData.tvHiddenByRegion === true)) continue;
      b.root.userData.tvHiddenByRegion = hidden;
      b.root.visible = !hidden;
      this.pickBuffer?.invalidate();
      // Not through the entity: the shadow map would keep the hidden building's shadow.
      this.shadows.invalidate();
    }
  }

  addTileset(options: Tiles3DLayerOptions): Tiles3DLayer {
    const layer = new Tiles3DLayer(options, this.getLoaders(), this.ellipsoid, this.gpu.tiles);
    layer.tiles.setCamera(this.camera);
    layer.tiles.setResolutionFromRenderer(this.camera, this.renderer as never);
    layer.suppressed = this.tilesetsSuppressed;
    layer.events.on('ready', () => this.extendGroundProbe());
    layer.events.on('error', ({ error }) => this.events.emit('error', { source: 'tileset', error, layer }));
    // Tiles loaded, `visible` or `heightOffset` set.
    layer.events.on('change', () => this.requestRender());
    // Heights measured on a tileset that moved are out of date.
    layer.events.on('moved', () => this.surface.clearHeld());
    this.scene.add(layer.group);
    this.tilesets.push(layer);
    this.localScene.attachLayer(layer);
    this.surface.clearHeld();
    this.events.emit('tilesets-changed', this.tilesets);
    return layer;
  }

  removeTileset(layer: Tiles3DLayer): void {
    const i = this.tilesets.indexOf(layer);
    if (i < 0) return;
    this.tilesets.splice(i, 1);
    this.surface.clearHeld();
    layer.dispose();
    this.events.emit('tilesets-changed', this.tilesets);
  }

  // ---------------------------------------------------------------------------
  // Gaussian splats

  /**
   * Adds a 3D Gaussian splatting scene (`.ply`, `.splat`, `.spz`) at a position on the globe.
   * The file loads in a Worker; listen to the layer's `ready` / `error` events (or the viewer's
   * 'error'), then `layer.flyTo()`. Throws an `option-invalid` `TerraViewError` when `position`
   * or the source (`url` / `data`) is missing. See docs/api.md §1.13 and docs/agents/splats.md.
   */
  addSplats(options: SplatLayerOptions): SplatLayer {
    const layer = new SplatLayer(options, {
      ellipsoid: this.ellipsoid,
      quality: this.gpu.splats,
      webgpu: this.info.backend === 'WebGPU',
      groundHeight: (lon, lat) => {
        const s = this.surface.query(lon, lat);
        return s.reliable ? s.height : null;
      },
      flyToSphere: (sphere, heading, pitch, duration) => this.flyToSphere(sphere, heading ?? this.getView().heading, pitch ?? -25, duration, { rangeScale: 1.1, minRange: 0.5 }),
    });
    layer.suppressed = this.tilesetsSuppressed && !layer.showIndoors;
    layer.events.on('ready', () => this.events.emit('splats-changed', this.splatLayers));
    layer.events.on('error', ({ error }) => {
      this.events.emit('splats-changed', this.splatLayers);
      this.events.emit('error', { source: 'splats', error, layer });
    });
    // Loaded, `visible`, `opacity`, `brightness`, `crop` or the placement set.
    layer.events.on('change', () => this.requestRender());
    this.scene.add(layer.group);
    this.splatLayers.push(layer);
    this.events.emit('splats-changed', this.splatLayers);
    return layer;
  }

  removeSplats(layer: SplatLayer): void {
    const i = this.splatLayers.indexOf(layer);
    if (i < 0) return;
    this.splatLayers.splice(i, 1);
    layer.dispose();
    this.events.emit('splats-changed', this.splatLayers);
  }

  /**
   * Per frame: layers follow the ground, fade in and are hidden while too small on screen;
   * inside a building they go with the 3D Tiles (unless `showIndoors`), and outside a local
   * scene that hides its surroundings with everything else there.
   */
  private updateSplats(dt: number): void {
    const ls = this.localScene;
    const height = this.container.clientHeight;
    for (const layer of this.splatLayers) {
      const outside = ls.hidesOutside && layer.ready && !ls.showsWorld(layer.boundingSphere.center, 0);
      layer.suppressed = outside || (this.tilesetsSuppressed && !layer.showIndoors);
      if (layer.update(dt, this.camera, height) || layer.animating) this.requestRender();
    }
  }

  /** Restarts the window in which suppressed 3D Tiles keep loading for buildings without ground. */
  private extendGroundProbe(): void {
    this.probeUntil = performance.now() + GROUND_PROBE_MS;
  }

  private setTilesetsSuppressed(suppressed: boolean): void {
    if (suppressed === this.tilesetsSuppressed) return;
    this.tilesetsSuppressed = suppressed;
    if (suppressed) this.extendGroundProbe();
    for (const layer of this.tilesets) layer.suppressed = suppressed;
  }

  // ---------------------------------------------------------------------------
  // GeoJSON / vector layers

  addGeoJson(options: GeoJsonLayerOptions): GeoJsonLayer {
    const layer = new GeoJsonLayer(options, this.vectors, this.labels);
    this.vectorLayers.push(layer);
    layer.events.on('ready', () => this.events.emit('vectors-changed', this.vectorLayers));
    layer.events.on('error', ({ error }) => this.events.emit('error', { source: 'geojson', error, layer }));
    // Visibility, style and label style (labels are not part of the overlay version).
    layer.events.on('change', () => this.requestRender());
    this.events.emit('vectors-changed', this.vectorLayers);
    return layer;
  }

  removeGeoJson(layer: GeoJsonLayer): void {
    const i = this.vectorLayers.indexOf(layer);
    if (i < 0) return;
    this.vectorLayers.splice(i, 1);
    layer.dispose();
    this.events.emit('vectors-changed', this.vectorLayers);
  }

  // ---------------------------------------------------------------------------
  // Point markers (点位)

  /**
   * Adds a point marker layer: GeoJSON points, record arrays or a
   * `{ points, style, rules }` document (see docs/agents/markers.md).
   */
  addPoints(options: PointLayerOptions): PointLayer {
    const layer = new PointLayer(options, {
      messages: this.messages,
      ellipsoid: this.ellipsoid,
      markers: this.markers,
      // Detailed queries need reliable data; the coarse one takes any estimate, but not the 0 m of "no data".
      groundHeight: (lon, lat, maxCellSize) => {
        const s = this.surface.query(lon, lat, { maxCellSize: maxCellSize ?? Infinity });
        return s.reliable ? s.height : null;
      },
      flyToBBox: (bbox) => void this.flyToBBox(bbox),
    });
    this.pointLayers.push(layer);
    layer.events.on('ready', () => this.events.emit('points-changed', this.pointLayers));
    layer.events.on('error', ({ error }) => {
      this.events.emit('points-changed', this.pointLayers);
      this.events.emit('error', { source: 'points', error, layer });
    });
    layer.events.on('click', (e) => this.events.emit('point-click', e));
    this.events.emit('points-changed', this.pointLayers);
    return layer;
  }

  removePoints(layer: PointLayer): void {
    const i = this.pointLayers.indexOf(layer);
    if (i < 0) return;
    this.pointLayers.splice(i, 1);
    layer.dispose();
    this.events.emit('points-changed', this.pointLayers);
  }

  /** Flies to fit a [west, south, east, north] box in degrees (top-down view). */
  flyToBBox(bbox: [number, number, number, number], duration?: number): Promise<void> {
    const [w, s, e, n] = bbox;
    let lon = (w + e) / 2;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const lat = Math.max(-80, Math.min(80, (s + n) / 2));
    const widthM = Math.abs(e - w) * 111_320 * Math.cos(lat * DEG2RAD);
    const heightM = Math.abs(n - s) * 110_540;
    const fov = this.camera.getEffectiveFOV() * DEG2RAD;
    const fit = Math.max(heightM, widthM / Math.max(this.camera.aspect, 0.5), 1500);
    const height = Math.min((fit / (2 * Math.tan(fov / 2))) * 1.25, 2.2e7);
    return this.flyTo({ longitude: lon, latitude: lat, height, heading: 0, pitch: -90 }, duration);
  }

  /**
   * Vector feature under a client-space pixel: labels first, then draped
   * geometry at the picked ground position.
   */
  async pickFeature(clientX: number, clientY: number): Promise<FeaturePick | null> {
    if (this.vectorLayers.length === 0) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let hit: FeatureHit | null = null;
    let position: Cartographic | null = null;
    const label = this.labels.hitTest(clientX - rect.left, clientY - rect.top);
    if (label) hit = await this.vectors.getFeature(label.layerId, label.featureId);
    if (!hit) {
      _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const p = this.pick(_ndc, { buffer: true });
      if (!p) return null;
      position = this.ellipsoid.cartesianToCartographic(p.point);
      if (!position) return null;
      const [u, v] = lonLatToMerc(position.longitude / DEG2RAD, position.latitude / DEG2RAD);
      const sse = rect.height / (2 * Math.tan((this.camera.getEffectiveFOV() * DEG2RAD) / 2));
      const metersPerPx = this.camera.position.distanceTo(p.point) / sse;
      const pixelSize = metersPerPx / (EARTH_CIRCUMFERENCE * Math.max(Math.cos(position.latitude), 0.01));
      hit = await this.vectors.query(u, v, pixelSize, 5);
    }
    if (!hit) return null;
    const layer = this.vectorLayers.find((l) => l.id === hit.layerId);
    return layer ? { hit, layer, position } : null;
  }

  /** Highlights a picked feature (null clears). */
  highlightFeature(hit: FeatureHit | null): void {
    this.vectors.setHighlight(hit);
    this.requestRender();
  }

  /**
   * The feature set by `highlightFeature`, or null. `layerId` is the
   * `GeoJsonLayer.id`; removing that layer clears the highlight.
   */
  get highlightedFeature(): { layerId: number; featureId: number } | null {
    return this.vectors.highlighted;
  }

  private getLoaders(): LoaderKit {
    if (!this.loaders) {
      // Decoder binaries ship with three.js; its loaders reference them relative to their own
      // module, so the host's bundler copies them. `decoderPath` / `transcoderPath` point elsewhere.
      const dracoLoader = new DRACOLoader();
      if (this.decoderPath) dracoLoader.setDecoderPath(this.decoderPath);
      const ktxLoader = new KTX2Loader();
      if (this.transcoderPath) ktxLoader.setTranscoderPath(this.transcoderPath);
      ktxLoader.detectSupport(this.renderer as never);
      this.loaders = {
        dracoLoader,
        ktxLoader,
        meshoptDecoder: MeshoptDecoder,
        nodeLibrary: (this.renderer as unknown as { library: NodeMaterialLibrary }).library,
      };
    }
    return this.loaders;
  }

  /** The canvas the viewer draws into, inside the container. Focus it (or the container) to enable the camera keys. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Loads a glTF / GLB (Draco, KTX2 and meshopt supported) for building and equipment models. */
  async loadModel(uri: string): Promise<Object3D> {
    if (!this.gltfLoader) {
      const kit = this.getLoaders();
      const loader = new GLTFLoader();
      loader.setDRACOLoader(kit.dracoLoader);
      loader.setKTX2Loader(kit.ktxLoader);
      loader.setMeshoptDecoder(kit.meshoptDecoder);
      this.gltfLoader = loader;
    }
    const gltf = await this.gltfLoader.loadAsync(uri);
    return gltf.scene;
  }

  /**
   * Draws the current view and copies it into a new 2D canvas (screenshots).
   * Rendering and copying happen in the same task: a WebGL drawing buffer is
   * only readable there. HTML markers are not part of the copy.
   */
  captureFrame(): HTMLCanvasElement {
    const source = this.renderer.domElement;
    this.renderOutsideFrame();
    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = source.height;
    out.getContext('2d')?.drawImage(source, 0, 0);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Frame loop

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const layer of this.tilesets) layer.tiles.setResolutionFromRenderer(this.camera, this.renderer as never);
  }

  /**
   * Frames per second once the view has been quiet for a second (see
   * `GeoViewerOptions.idleFrameRate`): 0 draws every animation frame, other values are kept
   * within 10–60.
   */
  get idleFrameRate(): number {
    return this.pacer.idleFrameRate;
  }

  set idleFrameRate(value: number) {
    this.pacer.idleFrameRate = normalizeIdleFrameRate(value);
    this.wake();
  }

  /**
   * Draws the view again, at the full frame rate for at least a second (a still, supersampled
   * view is drawn live and refined again). The viewer notices changes made through the SDK
   * (input, camera motion, loading, level changes, layers, entity styles and visibility, cloud,
   * layer and grading settings; docs/api.md §1.8); call this after changing three.js objects
   * behind its back (objects added to `viewer.scene`, their transforms or materials), or the
   * change shows only with the next idle frame, and in a still view only with the next change.
   */
  requestRender(): void {
    this.pacer.markChange(performance.now());
  }

  /** Full frame rate for a second without redrawing a still picture (input, work outside the canvas). */
  private wake(): void {
    this.pacer.markWake(performance.now());
  }

  /** Per animation frame: update and draw, unless the view is quiet and throttled, or the container is off screen. */
  private tick(time: number): void {
    if (this.disposed) return;
    // Animation frames stop while the page is hidden (or the computer sleeps): draw again when they
    // resume rather than rely on the canvas still holding a still picture.
    if (this.lastAnimationFrame >= 0 && time - this.lastAnimationFrame > RESUME_GAP_MS) this.requestRender();
    this.lastAnimationFrame = time;
    if (!this.onScreen) return;
    this.checkPendingWork();
    const floor = this.idleFloorRate();
    // A still view being supersampled takes its samples at the full rate.
    const refining = this.supersampling.enabled && !this.supersampling.converged && this.pacer.isStill(performance.now(), floor);
    if (!this.pacer.shouldTick(time, floor, refining)) return;
    this.pacer.ticked(time);
    this.frame(time);
  }

  /**
   * Work left for the next frames although the camera may stand still, also when started from
   * code between two frames: overlays to composite again (the picture changes), markers to
   * place, point markers to create (per-frame budget) or select again (DOM only: a wake).
   * Checked on every animation frame, so such work starts at once and finishes at the full
   * frame rate instead of at the idle rate.
   */
  private checkPendingWork(): void {
    const version = this.overlays.version;
    if (version !== this.overlayVersion) this.requestRender();
    this.overlayVersion = version;
    if (this.markers.busy || this.pointLayers.some((l) => l.busy)) this.wake();
  }

  /**
   * Whether something changed the picture since the last frame without telling the viewer:
   * the camera (also moved or reshaped behind the controller's back), the drawing buffer size
   * (a resized canvas is cleared), the globe's tiles (a new selection, morphs, the wireframe
   * switch), the simulated date (sun and stars), tone mapping and the tile debug switches.
   * Cheap reads, so that a still view is not held on a picture that is out of date.
   */
  private pictureChanged(): boolean {
    const v = this.lastPicture;
    const cam = this.camera;
    const canvas = this.renderer.domElement;
    let changed = false;
    let i = 0;
    const put = (x: number) => {
      if (v[i] !== x) {
        v[i] = x;
        changed = true;
      }
      i++;
    };
    for (const x of cam.matrixWorld.elements) put(x);
    for (const x of cam.projectionMatrix.elements) put(x);
    put(canvas.width);
    put(canvas.height);
    put(this._showGlobe ? this.globe.surfaceSignature : 0);
    put(this.date.getTime());
    put(this.renderer.toneMapping);
    put(this.renderer.toneMappingExposure);
    put(tileDebugUniforms.showTileBorders.value as number);
    put(tileDebugUniforms.levelTint.value as number);
    return changed;
  }

  /** Frames per second that what still moves on its own needs while quiet: simulated time, cloud drift. */
  private idleFloorRate(): number {
    // Motion started from code since the last frame (flyTo, zoomBy, playAnimation...) shows at once.
    if (this.timeMultiplier !== 0 || this.controller.inMotion || this.postProcessing.animating) return MAX_IDLE_FRAME_RATE;
    if (!this.clouds.mesh.visible) return 0;
    const o = this.clouds.getOptions();
    return cloudFrameRate({
      speedDegPerSec: o.speed,
      layerRadius: this.ellipsoid.radii.x + o.height,
      distance: this.cameraCarto.height - o.height,
      fovDeg: this.camera.fov,
      viewportHeight: this.container.clientHeight,
    });
  }

  private frame(time: number): void {
    if (this.disposed) return;
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min((time - this.lastTime) / 1000, 0.25);
    this.lastTime = time;
    if (this.timeMultiplier !== 0) this.date = new Date(this.date.getTime() + dt * 1000 * this.timeMultiplier);

    // Camera collision queries the ground first thing in the frame.
    this.surface.beginFrame();
    this.controller.update(dt);
    this.updateClipPlanes();
    this.camera.updateMatrixWorld();
    this.updateEnvironment();
    // cameraCarto was refreshed by updateClipPlanes.
    this.clouds.update(dt, this.cameraCarto.height);

    const t0 = performance.now();
    if (this._showGlobe) this.globe.update(this.camera, this.container.clientHeight);
    else this.releaseHiddenGlobe(dt);
    const tilesView = this.tilesets.length > 0 ? this.tilesViewState() : undefined;
    // Entered a building before the 3D Tiles loaded (e.g. ?demo): keep them loading, undrawn, until it has ground.
    const probe = this.tilesetsSuppressed && !this._showGlobe && performance.now() < this.probeUntil && this.indoor.awaitingGround;
    for (const layer of this.tilesets) {
      layer.probe = probe;
      layer.update(dt, tilesView);
      // The window counts from the last loading activity, not from when the tiles were suppressed.
      if (probe && layer.tiles.loadProgress < 1) this.extendGroundProbe();
    }
    // The local scene's transition and walls follow this frame's globe and tiles.
    if (this.localScene.update(dt)) {
      // Clip and outside fade change what is drawn without changing the draw statistics.
      this.pickBuffer?.invalidate();
      this.requestRender();
    }
    if (this.localScene.engaged) {
      this.clouds.mesh.visible = false;
      this.updateBuildingsInRegion();
    }
    // Floor expansion and re-grounding move content without changing the draw statistics.
    if (this.indoor.update(dt)) {
      this.pickBuffer?.invalidate();
      this.shadows.invalidate();
      this.requestRender();
    }
    this.updateSplats(dt);
    const building = this.currentBuilding();
    const bare = this.indoorBackdrop && building !== null && !this._showGlobe && !this.tilesets.some((l) => l.active);
    if (this.backdrop.update(bare ? building : null, dt)) this.requestRender();
    this.interaction.update();
    if (this.labels.update(this.camera, this.container.clientWidth, this.container.clientHeight, dt)) this.requestRender();
    // Changes nothing reported: fades and morphs in progress, and what `pictureChanged` compares.
    const globeAnimating = this._showGlobe && !this.globe.freeze && this.globe.animating;
    if (globeAnimating || this.tilesets.some((l) => l.animating) || this.pictureChanged()) this.requestRender();

    this.marks.refresh();
    // Live, one more supersampling sample of a still view, or nothing (the still picture is complete).
    const now = performance.now();
    const mode = drawMode(this.pacer.isStill(now, this.idleFloorRate()), this.supersampling.enabled, this.postProcessing.samples, this.supersampling.samples);
    // The shadow map is drawn again only when its fit moved or the buildings changed.
    if (mode !== 'hold') this.shadows.render(this.indoor.root);
    if (mode === 'live') this.postProcessing.render();
    else if (mode === 'sample') this.postProcessing.renderSample();
    if (mode !== 'hold') this.lastDrawAt = now;
    // Point layers clamp to the terrain and cluster before the markers are placed.
    for (const layer of this.pointLayers) layer.update(this.camera, this.container.clientWidth, this.container.clientHeight);
    this.markers.update(this.camera, this.container.clientWidth, this.container.clientHeight);
    const drawCalls = this.sceneDrawCalls;
    const triangles = this.sceneTriangles;
    // After the main render, whose statistics are part of the pick buffer's scene signature; counted in the frame time.
    this.pickBuffer?.update(performance.now(), drawCalls, triangles, this._showGlobe ? this.globe.surfaceSignature : 0);
    this.updateStats(dt, performance.now() - t0, drawCalls, triangles, mode === 'hold');
    this.updateLoadState();
  }

  /** What is still loading, as of the last frame (see `LoadState`; the 'load-progress' and 'idle' events). */
  get loadState(): Readonly<LoadState> {
    return this._loadState;
  }

  private updateLoadState(): void {
    let tilesets = 0;
    for (const layer of this.tilesets) tilesets += layer.pending;
    let layers = 0;
    for (const layer of this.vectorLayers) if (!layer.ready && layer.error === null) layers++;
    for (const layer of this.pointLayers) if (!layer.ready && layer.error === null) layers++;
    for (const layer of this.splatLayers) if (!layer.ready && layer.error === null) layers++;
    const state = summarizeLoad({
      globe: this._showGlobe ? this.globe.stats : null,
      imageryUnreachable: this.globe.imageryError !== null,
      tilesets,
      layers,
    });
    this._loadState = state;
    if (!state.idle) this.requestRender();
    const { progress, idle } = this.loadTracker.step(state);
    if (progress) this.events.emit('load-progress', state);
    if (idle) this.events.emit('idle', state);
  }

  /**
   * A hidden globe is not updated, so its cache would keep its textures and
   * meshes on the GPU for as long as it stays hidden (typically under Google
   * 3D Tiles, which need that memory). Release it after a while; a quick
   * toggle keeps everything.
   */
  private releaseHiddenGlobe(dt: number): void {
    if (this.globeReleased) return;
    this.globeHiddenFor += dt;
    if (this.globeHiddenFor < this.gpu.globe.hiddenReleaseSeconds) return;
    this.globeReleased = true;
    this.globe.releaseHidden(this.gpu.globe.hiddenKeepTiles);
  }

  /** Camera height above the ground and tilt, for the distance falloff of 3D Tiles (cameraCarto is current). */
  private tilesViewState(): TilesViewState {
    const cam = this.camera;
    const up = this.ellipsoid.geodeticNormal(cam.position, _v);
    cameraDirection(cam.quaternion, _dir);
    const ground = this._showGlobe ? (this.globe.getHeight(this.cameraCarto.longitude, this.cameraCarto.latitude) ?? 0) : this.viewGround;
    return { altitude: Math.max(1, this.cameraCarto.height - ground), viewDotUp: _dir.dot(up) };
  }

  private updateClipPlanes(): void {
    const cam = this.camera;
    const c = this.ellipsoid.cartesianToCartographic(cam.position, this.cameraCarto);
    const ground = c && this._showGlobe ? (this.globe.getHeight(c.longitude, c.latitude) ?? 0) : 0;
    const altitude = Math.max(1, (c?.height ?? 0) - ground);
    const r = cam.position.length();
    const rMin = this.ellipsoid.minimumRadius - 500;
    const horizon = Math.sqrt(Math.max(r * r - rMin * rMin, 0));
    // Mountains and tall 3D tiles stay visible a little past the geometric horizon.
    const far = horizon + 400_000 + altitude * 0.5;
    const near = this.info.reversedDepth ? clamp(altitude * 0.002, 0.05, 5_000) : clamp(altitude * 0.05, 0.5, 200_000);
    if (Math.abs(cam.near - near) > near * 0.01 || Math.abs(cam.far - far) > far * 0.01) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Renders outside the frame loop (screenshots, transition captures). The atmosphere and label
   * uniforms are shared by every viewer on the page and hold whatever the last viewer to render
   * wrote: put this viewer's camera and settings back first.
   */
  /**
   * A level change is about to alter what is shown: capture the picture on screen (the
   * supersampled one when the view was still and nothing changed since) for the transition.
   */
  private beginLevelTransition(): void {
    if (this.disposed || !(this.levelTransition.duration > 0) || document.visibilityState === 'hidden') return;
    const fromHistory = this.postProcessing.samples > 0 && this.pacer.changedAt < this.lastDrawAt;
    if (!fromHistory) {
      // Drawn outside the frame loop: this viewer's shared uniforms first (see renderOutsideFrame).
      this.updateEnvironment();
      this.shadows.render(this.indoor.root);
      this.labels.syncCamera(this.camera);
      this.marks.refresh();
    }
    this.levelTransition.begin(fromHistory);
    this.requestRender();
  }

  private renderOutsideFrame(): void {
    // A supersampled picture that nothing has changed since is the view as it is: show it again
    // (better, and no scene pass). Otherwise draw live.
    if (this.postProcessing.samples > 0 && this.pacer.changedAt < this.lastDrawAt && this.postProcessing.present()) return;
    this.updateEnvironment();
    this.shadows.render(this.indoor.root);
    this.labels.syncCamera(this.camera);
    this.marks.refresh();
    this.postProcessing.render();
  }

  private updateEnvironment(): void {
    const u = atmosphereUniforms;
    const cam = this.camera;
    const sun = sunDirectionECEF(this.date, _v);
    u.lightDirection.value.copy(sun);
    const up = this.ellipsoid.geodeticNormal(cam.position, new Vector3());
    if (this._lighting) {
      u.sunDirection.value.copy(sun);
    } else {
      // "Studio" lighting: a virtual sun above the camera so the whole visible hemisphere glows.
      u.sunDirection.value.copy(cam.position).normalize();
    }
    u.cameraPositionKm.value.set(cam.position.x, cam.position.y, cam.position.z * Z_SCALE).multiplyScalar(0.001);
    const height = this.cameraCarto.height;
    u.cameraAltitudeKm.value = Math.max(height, 0) / 1000;
    u.lightingEnabled.value = this._lighting ? 1 : 0;
    u.uniformLighting.value = this._lighting ? 0 : 1;
    // A local scene on its studio background has no sky to haze the ground towards.
    u.atmosphereEnabled.value = this._atmosphere && !(this.localScene.backgroundAmount.value > 0.5) ? 1 : 0;
    u.groundHaze.value = this._lighting ? 0.7 : 0.5;

    // Stars: rotate with sidereal time, fade in when the sky is dark.
    this.stars.uniforms.siderealAngle.value = greenwichMeanSiderealTime(this.date);
    const space = smoothstep(30_000, 120_000, height);
    const sunAltitude = up.dot(sun);
    const night = this._lighting ? smoothstep(0.05, -0.2, sunAltitude) : 0;
    this.stars.uniforms.visibility.value = (this._atmosphere ? Math.max(space, night) : 1) * (1 - this.localScene.backgroundAmount.value);

    // Lights for 3D Tiles and buildings (globe tiles shade themselves).
    if (this._lighting) {
      // The sun's color and the sky light where the view is (the entered building, else the
      // ground under the camera), from the same atmosphere the globe is drawn with (M3.5).
      this.sunLight.position.copy(sun);
      const light = this.updateAtmosphereLight(sun);
      this.sunLight.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2], LinearSRGBColorSpace);
      this.sunLight.intensity = light.sunIntensity;
      this.skyProbe.intensity = 1;
      // A little fill at night so interiors stay readable (the sky alone gives next to nothing).
      this.skyLight.intensity = NIGHT_FILL * (1 - smoothstep(-0.15, 0.2, sunAltitude));
    } else {
      // Head light from above and behind the viewer.
      cameraDirection(cam.quaternion, _dir);
      this.sunLight.position.copy(up).addScaledVector(_dir, -0.7).normalize();
      this.sunLight.color.setRGB(1, 1, 1);
      this.sunLight.intensity = 2.4;
      this.skyLight.intensity = 1.2;
      this.skyProbe.intensity = 0;
    }
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.updateMatrixWorld();
    this.sunLight.target.updateMatrixWorld();
    this.skyLight.position.copy(up);
    this.skyLight.updateMatrixWorld();
    this.updateShadows(sun);
  }

  /**
   * Fits the sun shadow map to the buildings in view (M3.9) and writes this viewer's shadow
   * uniforms (shared by the viewers on the page). The map itself is drawn just before the scene.
   */
  private updateShadows(sun: Vector3): void {
    const casters = this.shadowCasters;
    const entered = this.currentBuilding();
    let focus: Building | null = entered;
    let nearest = Infinity;
    let n = 0;
    for (const b of this.indoor.buildings) {
      if (!b.root.visible || !b.visible) continue;
      const c = casters[n] ?? (casters[n] = { matrix: new Matrix4(), min: new Vector3(), max: new Vector3() });
      c.matrix.copy(b.root.matrixWorld);
      b.shadowBounds(c.min, c.max);
      n++;
      // The light frame hangs on the entered building, else on the nearest one (texels are snapped to it).
      if (!entered) {
        const d = _lightPoint.setFromMatrixPosition(c.matrix).distanceToSquared(this.camera.position);
        if (d < nearest) {
          nearest = d;
          focus = b;
        }
      }
    }
    casters.length = n;
    const origin = focus ? _shadowOrigin.setFromMatrixPosition(focus.root.matrixWorld) : _shadowOrigin.set(0, 0, 0);
    const cam = this.camera;
    const tanY = Math.tan((cam.fov * DEG2RAD) / 2) / cam.zoom;
    this.shadows.update({
      sun,
      lighting: this._lighting,
      casters,
      origin,
      up: this.ellipsoid.geodeticNormal(origin, _shadowUp),
      view: { matrixWorld: cam.matrixWorld, tanX: tanY * cam.aspect, tanY, near: cam.near },
    });
    this.shadows.bind();
  }

  /**
   * Sun color and sky light (SH) at the point the view is about (the entered building, else
   * the ground under the camera), recomputed when the sun or the point moved noticeably; the
   * SH goes into the light probe when it changed.
   */
  private updateAtmosphereLight(sun: Vector3): AtmosphereLight {
    const building = this.currentBuilding();
    const c = this.cameraCarto;
    let p: Vector3;
    if (building) {
      p = building.group.getWorldPosition(_lightPoint);
    } else {
      const ground = this._showGlobe ? (this.globe.getHeight(c.longitude, c.latitude) ?? 0) : this.viewGround;
      p = this.ellipsoid.cartographicToCartesian(c.longitude, c.latitude, Math.max(ground, 0), _lightPoint);
    }
    if (this.atmosphereLight.update([p.x, p.y, p.z], [sun.x, sun.y, sun.z])) {
      this.atmosphereLight.current!.sh.forEach((rgb, i) => this.skyProbe.sh.coefficients[i].set(rgb[0], rgb[1], rgb[2]));
    }
    return this.atmosphereLight.current!;
  }

  /** Frame statistics; draw calls and triangles are those of the scene pass (not the post-processing or pick passes). */
  private updateStats(dt: number, cpuMs: number, drawCalls: number, triangles: number, held: boolean): void {
    if (!held) this.fpsFrames++;
    this.fpsTime += dt;
    this.stats.drawCalls = drawCalls;
    this.stats.triangles = triangles;
    this.stats.throttled = this.pacer.throttled;
    this.stats.still = held;
    this.stats.samples = this.supersampling.sampleCount;
    this.stats.frameMs = this.stats.frameMs * 0.9 + cpuMs * 0.1;
    if (this.fpsTime >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      if (this.info.timestampQuery && !this.timestampPending) {
        this.timestampPending = true;
        this.renderer
          .resolveTimestampsAsync('render')
          .then((ms) => {
            if (typeof ms === 'number' && ms > 0) this.stats.gpuMs = ms;
          })
          .catch(() => undefined)
          .finally(() => {
            this.timestampPending = false;
          });
      }
    }
    this.events.emit('frame', this.stats);
  }

  dispose(): void {
    this.disposed = true;
    void this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    for (const type of INPUT_EVENTS) this.container.removeEventListener(type, this.onInput);
    this.controller.dispose();
    this.interaction.dispose();
    for (const layer of [...this.tilesets]) this.removeTileset(layer);
    for (const layer of [...this.vectorLayers]) this.removeGeoJson(layer);
    for (const layer of [...this.pointLayers]) this.removePoints(layer);
    for (const layer of [...this.splatLayers]) this.removeSplats(layer);
    this.localScene.dispose();
    this.regionWalls.dispose();
    this.indoor.dispose();
    this.pickBuffer?.dispose();
    this.postProcessing.dispose();
    this.shadows.dispose();
    this.marks.dispose();
    this.markers.dispose();
    this.markerOcclusion.dispose();
    this.backdrop.dispose();
    this.clouds.dispose();
    this.labels.dispose();
    this.vectors.dispose();
    this.globe.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.containerRestore?.();
    this.containerRestore = null;
  }

  /**
   * Prepares the host's container: the `tv-viewer` class (stylesheet scope), a positioning
   * context for the marker layer, and keyboard focus (a click on a
   * marker then focuses the container, so camera keys keep working). Only what is missing is
   * set, and `dispose()` puts it back.
   */
  private adoptContainer(): void {
    const el = this.container;
    const undo: (() => void)[] = [];
    if (!el.classList.contains('tv-viewer')) {
      el.classList.add('tv-viewer');
      undo.push(() => el.classList.remove('tv-viewer'));
    }
    if (getComputedStyle(el).position === 'static') {
      const previous = el.style.position;
      el.style.position = 'relative';
      undo.push(() => (el.style.position = previous));
    }
    if (!el.hasAttribute('tabindex')) {
      el.tabIndex = -1;
      const outline = el.style.outline;
      el.style.outline = 'none';
      undo.push(() => {
        el.removeAttribute('tabindex');
        el.style.outline = outline;
      });
    }
    this.containerRestore = () => undo.forEach((fn) => fn());
  }
}

/**
 * What the browser tells about the graphics hardware, read from a WebGPU
 * adapter requested the same way the renderer will request its own. Without
 * WebGPU only the CPU-side hints are filled in.
 */
async function detectGpuHints(): Promise<GpuHints> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const hints: GpuHints = {
    webgpu: false,
    vendor: '',
    architecture: '',
    fallbackAdapter: false,
    maxTextureSize: 0,
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? ''),
  };
  try {
    const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      const info: Partial<GPUAdapterInfo> & { isFallbackAdapter?: boolean } = adapter.info ?? {};
      hints.webgpu = true;
      hints.vendor = String(info.vendor ?? '').toLowerCase();
      hints.architecture = String(info.architecture ?? '').toLowerCase();
      hints.fallbackAdapter = (info.isFallbackAdapter ?? (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter) === true;
      hints.maxTextureSize = Number(adapter.limits?.maxTextureDimension2D ?? 0);
    }
  } catch {
    /* no adapter: the renderer falls back to WebGL 2 */
  }
  return hints;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeAdapter(backend: any): string {
  try {
    const info = backend.device?.adapterInfo ?? backend.adapter?.info;
    if (info) return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ').trim() || 'WebGPU adapter';
    const gl = backend.gl as WebGL2RenderingContext | undefined;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}
