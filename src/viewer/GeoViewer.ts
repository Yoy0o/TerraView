/**
 * The viewer (`GeoViewer`): creates the renderer, the scene and every subsystem, wires them
 * together and exposes the public API. The work is in its parts, which get what they need
 * through narrow host interfaces and never import this file:
 *
 *   ViewerEnvironment  sun, atmosphere and star uniforms, lights, shadow fit, cloud frame state
 *   FrameLoop          per-frame update and draw, idle pacing, renders outside the loop, stats
 *   ViewerPicking      picks under the cursor, along view rays and for camera gestures
 *   ViewerLayers       3D Tiles / GeoJSON / point layers, glTF loading, ground heights
 *   diagnostics        memory estimate, snapshot, GPU detection
 *   viewerState        the state they share; viewerTypes: the public types
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  LightProbe,
  NeutralToneMapping,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { mix, positionWorldDirection, vec3 } from 'three/tsl';
import { atmosphereUniforms, skyColorNode } from '../atmosphere/AtmosphereNodes';
import { StarField } from '../atmosphere/Stars';
import { CloudLayer } from '../clouds/CloudLayer';
import { VolumetricClouds } from '../clouds/VolumetricClouds';
import { cartographic, Ellipsoid, type Cartographic } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { classifyGpu, effectivePixelRatio, gpuProfile, type GpuProfile } from '../core/gpuProfile';
import { DEG2RAD } from '../core/math';
import { DEFAULT_LOCALE, resolveMessages, type LocaleId, type ViewerMessages } from '../core/i18n';
import { Globe } from '../globe/Globe';
import { OverlayCompositor } from '../globe/OverlayCompositor';
import { BimEntity } from '../indoor/BimEntity';
import { FloorOcclusionBaker } from '../indoor/FloorOcclusion';
import { IndoorManager } from '../indoor/IndoorManager';
import { SunShadows, sunShadowFactor } from '../lighting/SunShadows';
import { LocalScene } from '../local/LocalScene';
import { RegionDimEffect } from '../local/RegionDimEffect';
import { RegionWalls } from '../local/RegionWalls';
import { MarkerManager } from '../markers/MarkerManager';
import type { PointLayer, PointLayerOptions } from '../markers/PointLayer';
import { ColorGrading, ColorGradingEffect } from '../post/ColorGrading';
import { EffectMarks } from '../post/EffectMarks';
import { GlowEffect } from '../post/GlowEffect';
import { LevelTransition } from '../post/LevelTransition';
import { OutlineEffect } from '../post/OutlineEffect';
import { PostPipeline } from '../post/PostPipeline';
import { Supersampling } from '../post/Supersampling';
import { Transparency } from '../post/Transparency';
import { ViewerEffects } from '../post/ViewerEffects';
import type { Tiles3DLayer, Tiles3DLayerOptions } from '../tiles3d/Tiles3DLayer';
import type { FeatureHighlightStyle, TileFeature } from '../tiles3d/tileFeatures';
import type { GeoJsonLayer, GeoJsonLayerOptions } from '../vector/GeoJsonLayer';
import { LabelManager } from '../vector/LabelManager';
import type { FeatureHit } from '../vector/types';
import { VectorService } from '../vector/VectorService';
import { getHeadingPitch, lookAtHeadingPitchRange } from './cameraMath';
import { describeAdapter, detectGpuHints, memoryReport, viewerSnapshot } from './diagnostics';
import { FrameLoop } from './FrameLoop';
import { DEFAULT_IDLE_FRAME_RATE, FramePacer, normalizeIdleFrameRate } from './framePacing';
import { GlobeCameraController, type AutoOrbitOptions, type ControllerHost } from './GlobeCameraController';
import { IndoorBackdrop, studioSkyNode } from './IndoorBackdrop';
import { installIndoorBehaviors } from './indoorBehaviors';
import { InteractionManager, type PickInfo } from './InteractionManager';
import type { IntroSpinOptions } from './IntroAnimation';
import type { LoadState } from './loadState';
import { NavigationControls } from './NavigationControls';
import { OcclusionProxies } from './OcclusionProxies';
import { PickBuffer } from './PickBuffer';
import type { SurfaceHeight, SurfaceHeightOptions } from './SurfaceHeight';
import { ViewerEnvironment } from './ViewerEnvironment';
import { ViewerLayers } from './ViewerLayers';
import { checkViewerOptions } from './viewerOptions';
import { ViewerPicking } from './ViewerPicking';
import { createViewerState } from './viewerState';
import type {
  FeaturePick,
  FrameStats,
  GeoViewerOptions,
  MemoryReport,
  RendererInfo,
  SphereFlightOptions,
  SurfacePick,
  TargetView,
  ViewerEvents,
  ViewerSnapshot,
  ViewPosition,
} from './viewerTypes';

const DEFAULT_VIEW: ViewPosition = { longitude: 110, latitude: 28, height: 1.8e7 };

const _localPoint = new Vector3();
const CENTER_NDC = new Vector2(0, 0);
/** Input on the container that wakes the frame loop up (passive listeners; the camera and interaction handle the input itself). */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;

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
  /**
   * Clouds (hidden by default: `clouds.visible = true`): an animated layer over the imagery
   * seen from far away, volumetric clouds near the ground (`clouds.set({ volumetric })`).
   */
  readonly clouds: CloudLayer;
  /** @internal Volumetric clouds near the ground (a post effect; settings in `clouds`). */
  private readonly volumetricClouds: VolumetricClouds;
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

  /** Scene switches, simulated time and per-frame camera facts shared by the viewer's parts. */
  private readonly state = createViewerState();
  private readonly container: HTMLElement;
  /** What `adoptContainer` changed on the host's element, undone by `dispose()`. */
  private containerRestore: (() => void) | null = null;
  private resizeObserver: ResizeObserver;
  /** Idle frame-rate throttling (P2.1a). */
  private readonly pacer: FramePacer;
  private intersectionObserver: IntersectionObserver | null = null;
  /** Objects and entities drawn with outlines or glow. */
  private readonly marks: EffectMarks;
  /**
   * Input on the container wakes the frame loop up to the full rate. It does not change the
   * picture by itself (what it leads to does: camera motion, hover, selection), so a still,
   * supersampled view stays as it is while the pointer moves over it.
   */
  private readonly onInput = () => this.wake();
  /** The viewer's parts (see the file header). */
  private readonly environment: ViewerEnvironment;
  private readonly frameLoop: FrameLoop;
  private readonly picking: ViewerPicking;
  private readonly layers: ViewerLayers;

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
    this.globe.setOverlaySource(this.overlays);
    this.scene.add(this.globe.group);
    this.labels = new LabelManager(this.ellipsoid);
    this.labels.heightProvider = (lon, lat) => (this.state.showGlobe ? this.globe.getHeight(lon, lat) : 0);
    this.scene.add(this.labels.group);
    this.scene.add(this.stars.mesh);
    this.clouds = new CloudLayer(this.ellipsoid, { volumetric: profile.clouds.volumetric });
    this.clouds.onChange = () => {
      this.updateSunCasting();
      this.requestRender();
    };
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
        const s = this.layers.surface.query(lon, lat);
        return s.reliable ? s.height : null;
      },
      flyToView: (view, duration) => this.flyToTarget({ target: view.target, heading: view.heading, pitch: view.pitch, range: view.range, duration }),
      getCameraPose: () => {
        const { heading, pitch } = this.getView();
        // What the view is centered on, so flying back can keep it in frame.
        const target = this.picking.gesturePick(CENTER_NDC)?.clone();
        return { position: this.camera.position.clone(), heading, pitch, target };
      },
      flyToPose: (pose, duration) =>
        this.controller.flyTo({ position: pose.position.clone(), heading: pose.heading * DEG2RAD, pitch: pose.pitch * DEG2RAD }, duration, { lookAt: pose.target }),
      beginTransition: () => this.frameLoop.beginLevelTransition(),
      setTilesetsVisible: (visible) => this.layers.setTilesetsSuppressed(!visible),
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
    this.volumetricClouds = new VolumetricClouds(renderer, this.clouds, this.ellipsoid, profile.clouds);
    this.volumetricClouds.onReady = () => this.requestRender();
    this.postProcessing.add(this.volumetricClouds);
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
      if (toggled) this.updateSunCasting();
      this.requestRender();
    });
    this.updateSunCasting();
    // Building and device surfaces (entity meshes and device batches) blend order-independently.
    this.postProcessing.oitTest = (object) => object.userData.entity !== undefined || (object as { isBatchMesh?: boolean }).isBatchMesh === true;
    this.transparency = new Transparency(
      this.postProcessing,
      () => this.requestRender(),
      { orderIndependent: profile.orderIndependentTransparency, supported: isWebGPU },
      options.transparency,
    );
    this.indoor.modelBytesTarget = this.gpu.indoor.modelBytesTarget;
    this.indoor.modelUnloadDelayMs = this.gpu.indoor.unloadDelayMs;
    if (options.contributionCulling) this.indoor.culling.configure(options.contributionCulling);
    // Integer render targets and async read back: WebGPU only; WebGL keeps casting rays.
    this.pickBuffer =
      this.info.backend === 'WebGPU' ? new PickBuffer<Tiles3DLayer>({ renderer, scene: this.scene, camera: this.camera, classify: (o) => this.picking.classifyPick(o) }) : null;
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
      pick: (ndc) => this.picking.gesturePick(ndc),
      groundHeight: (lon, lat) => this.layers.collisionGround(lon, lat),
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
    // The parts: one object of references, each part takes what its host interface names.
    const parts = {
      state: this.state,
      renderer,
      scene: this.scene,
      camera: this.camera,
      ellipsoid: this.ellipsoid,
      container: this.container,
      info: this.info,
      gpu: this.gpu,
      messages: this.messages,
      stats: this.stats,
      events: this.events,
      pacer: this.pacer,
      globe: this.globe,
      controller: this.controller,
      clouds: this.clouds,
      volumetricClouds: this.volumetricClouds,
      stars: this.stars,
      sunLight: this.sunLight,
      skyLight: this.skyLight,
      skyProbe: this.skyProbe,
      shadows: this.shadows,
      indoor: this.indoor,
      backdrop: this.backdrop,
      localScene: this.localScene,
      interaction: this.interaction,
      labels: this.labels,
      vectors: this.vectors,
      markers: this.markers,
      marks: this.marks,
      overlays: this.overlays,
      postProcessing: this.postProcessing,
      supersampling: this.supersampling,
      levelTransition: this.levelTransition,
      pickBuffer: this.pickBuffer,
      tilesets: this.tilesets,
      vectorLayers: this.vectorLayers,
      pointLayers: this.pointLayers,
      decoderPath: options.decoderPath ?? '',
      transcoderPath: options.transcoderPath ?? '',
      requestRender: () => this.requestRender(),
      wake: () => this.wake(),
      flyToBBox: (bbox: [number, number, number, number], duration?: number) => this.flyToBBox(bbox, duration),
      updateBuildingsInRegion: () => this.updateBuildingsInRegion(),
    };
    this.layers = new ViewerLayers(parts);
    this.picking = new ViewerPicking({ ...parts, surface: this.layers.surface });
    this.environment = new ViewerEnvironment(parts);
    this.frameLoop = new FrameLoop({ ...parts, surface: this.layers.surface, environment: this.environment, layers: this.layers });
    // Camera motion of any origin (gestures, flights, animations, inertia, auto-orbit) keeps the full frame rate.
    this.controller.events.on('change', () => this.requestRender());
    // A gesture starting changes nothing yet (a click without a drag must not discard a supersampled view).
    this.controller.events.on('interactionstart', () => this.wake());
    for (const type of ['tilesets-changed', 'vectors-changed', 'points-changed'] as const) this.events.on(type, () => this.requestRender());
    // Labels sit above the canvas: their clicks reach the interaction listeners as clicks on the entity.
    this.markers.eventProxy = (type, marker, event) => {
      const entity = marker.options.userData?.entity;
      if (!(entity instanceof BimEntity)) return;
      const p = marker.options.position;
      const point = typeof p === 'function' ? (p()?.clone() ?? null) : p.clone();
      this.interaction.dispatchProxy(type, entity, event, { marker, point });
    };
    // Default indoor interactions; a building added restarts the ground probe of suppressed 3D Tiles.
    this.indoor.events.on('buildings-changed', () => this.layers.extendGroundProbe());
    installIndoorBehaviors(this.interaction, this.indoor);

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
        if (visible && !this.frameLoop.onScreen) this.requestRender();
        this.frameLoop.onScreen = visible;
      });
      this.intersectionObserver.observe(this.container);
    }
    void renderer.setAnimationLoop((t: number) => this.frameLoop.tick(t));
  }

  // ---------------------------------------------------------------------------
  // Scene settings

  get lighting(): boolean {
    return this.state.lighting;
  }

  /** Real sun position and day/night shading (otherwise imagery is shown unlit). */
  set lighting(v: boolean) {
    this.state.lighting = v;
    this.requestRender();
  }

  get atmosphere(): boolean {
    return this.state.atmosphere;
  }

  set atmosphere(v: boolean) {
    this.state.atmosphere = v;
    this.requestRender();
  }

  get showGlobe(): boolean {
    return this.state.showGlobe;
  }

  set showGlobe(v: boolean) {
    this.state.showGlobe = v;
    this.requestRender();
    this.globe.group.visible = v;
    if (v) this.frameLoop.globeShown();
  }

  get showStars(): boolean {
    return this.state.showStars;
  }

  set showStars(v: boolean) {
    this.state.showStars = v;
    this.requestRender();
    this.stars.mesh.visible = v;
  }

  /**
   * Show the studio backdrop (ground grid, gradient sky) inside a building
   * when nothing else is drawn around it: globe hidden and no active 3D Tiles.
   */
  get indoorBackdrop(): boolean {
    return this.state.indoorBackdrop;
  }

  set indoorBackdrop(v: boolean) {
    this.state.indoorBackdrop = v;
  }

  /** Simulated date driving the sun and star positions. */
  get date(): Date {
    return this.state.date;
  }

  set date(v: Date) {
    this.state.date = v;
  }

  /** Simulated seconds per real second (0 = paused). */
  get timeMultiplier(): number {
    return this.state.timeMultiplier;
  }

  set timeMultiplier(v: number) {
    this.state.timeMultiplier = v;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics

  /** Estimated memory use of the viewer's own allocations, in bytes (see `MemoryReport`). */
  get memory(): MemoryReport {
    return memoryReport(this);
  }

  /**
   * @advanced Diagnostics of the viewer as of the last frame, JSON-serializable (`ViewerSnapshot`,
   * roadmap M5.1): `JSON.stringify(viewer.snapshot())` for a bug report.
   */
  snapshot(): ViewerSnapshot {
    return viewerSnapshot(this);
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

  /** Closest surface hit (buildings, 3D Tiles or globe) at normalized device coordinates. */
  pick(ndc: Vector2, options: { buffer?: boolean } = {}): SurfacePick | null {
    return this.picking.pick(ndc, options);
  }

  /** What lies under a client-space pixel (used by the interaction manager). */
  pickAt(clientX: number, clientY: number): PickInfo {
    return this.picking.pickAt(clientX, clientY);
  }

  /**
   * The 3D Tiles feature under a client-space pixel: its feature ID and properties from
   * `EXT_mesh_features` / `EXT_structural_metadata` or the batch table (b3dm, i3dm). Null when
   * the closest surface there is not a 3D Tiles layer, or its content has no readable feature
   * IDs there (no metadata, or feature ID textures, which are not read). Casts a CPU ray.
   * In interaction listeners use `event.tileFeature()`, which reuses the event's pick.
   */
  pickTileFeature(clientX: number, clientY: number): TileFeature | null {
    return this.picking.pickTileFeature(clientX, clientY);
  }

  /**
   * Highlights a picked 3D Tiles feature (null clears): its triangles are tinted in the tile
   * it was picked on (default `#ffd23f` at 50 % opacity). One feature at a time across all
   * layers. Feature IDs only exist within one tile's content, so the highlight goes away when
   * that tile is unloaded or replaced by another level of detail; removing the layer clears it.
   */
  highlightTileFeature(feature: TileFeature | null, style?: FeatureHighlightStyle): void {
    this.layers.highlightTileFeature(feature, style);
  }

  /** The feature set by `highlightTileFeature`, or null (also after its tile was unloaded). */
  get highlightedTileFeature(): TileFeature | null {
    return this.layers.highlightedTileFeature;
  }

  /** Cartographic position (radians) under a client-space pixel. */
  pickCartographic(clientX: number, clientY: number): Cartographic | null {
    return this.picking.pickCartographic(clientX, clientY);
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
    return this.layers.surfaceHeight(longitude, latitude, options);
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
    return this.picking.pickReferenceSurface(ndc);
  }

  // ---------------------------------------------------------------------------
  // Local scene

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
      globeShown: () => this.state.showGlobe,
      setGlobeShown: (shown) => {
        this.showGlobe = shown;
      },
      lighting: () => this.state.lighting,
      sunDirection: () => atmosphereUniforms.lightDirection.value,
      groundHeight: (lon, lat) => {
        const s = this.layers.surface.query(lon, lat);
        return { height: s.height, reliable: s.reliable };
      },
      tilesHeight: (lon, lat) => this.layers.raycastTilesVertical(lon, lat)?.height ?? null,
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

  // ---------------------------------------------------------------------------
  // 3D Tiles

  addTileset(options: Tiles3DLayerOptions): Tiles3DLayer {
    return this.layers.addTileset(options);
  }

  removeTileset(layer: Tiles3DLayer): void {
    this.layers.removeTileset(layer);
  }

  // ---------------------------------------------------------------------------
  // GeoJSON / vector layers

  addGeoJson(options: GeoJsonLayerOptions): GeoJsonLayer {
    return this.layers.addGeoJson(options);
  }

  removeGeoJson(layer: GeoJsonLayer): void {
    this.layers.removeGeoJson(layer);
  }

  // ---------------------------------------------------------------------------
  // Point markers (点位)

  /**
   * Adds a point marker layer: GeoJSON points, record arrays or a
   * `{ points, style, rules }` document (see docs/agents/markers.md).
   */
  addPoints(options: PointLayerOptions): PointLayer {
    return this.layers.addPoints(options);
  }

  removePoints(layer: PointLayer): void {
    this.layers.removePoints(layer);
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
  pickFeature(clientX: number, clientY: number): Promise<FeaturePick | null> {
    return this.picking.pickFeature(clientX, clientY);
  }

  /** Highlights a picked feature (null clears). */
  highlightFeature(hit: FeatureHit | null): void {
    this.layers.highlightFeature(hit);
  }

  /**
   * The feature set by `highlightFeature`, or null. `layerId` is the
   * `GeoJsonLayer.id`; removing that layer clears the highlight.
   */
  get highlightedFeature(): { layerId: number; featureId: number } | null {
    return this.layers.highlightedFeature;
  }

  /** The canvas the viewer draws into, inside the container. Focus it (or the container) to enable the camera keys. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Loads a glTF / GLB (Draco, KTX2 and meshopt supported) for building and equipment models. */
  loadModel(uri: string): Promise<Object3D> {
    return this.layers.loadModel(uri);
  }

  /**
   * Draws the current view and copies it into a new 2D canvas (screenshots).
   * Rendering and copying happen in the same task: a WebGL drawing buffer is
   * only readable there. HTML markers are not part of the copy.
   */
  captureFrame(): HTMLCanvasElement {
    const source = this.renderer.domElement;
    this.frameLoop.renderOutsideFrame();
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

  /** What is still loading, as of the last frame (see `LoadState`; the 'load-progress' and 'idle' events). */
  get loadState(): Readonly<LoadState> {
    return this.frameLoop.loadState;
  }

  /**
   * The sun light runs the shared shadow node (`sunShadowFactor`) while building shadows or cloud
   * shadows are wanted; lit materials rebuild once when this flips.
   */
  private updateSunCasting(): void {
    // Also called while the constructor sets the cloud options, before the shadows exist.
    const shadows = this.shadows as SunShadows | undefined;
    if (!shadows) return;
    this.sunLight.castShadow = shadows.enabled || (this.volumetricClouds?.wantsShadows ?? false);
  }

  dispose(): void {
    this.frameLoop.dispose();
    void this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    for (const type of INPUT_EVENTS) this.container.removeEventListener(type, this.onInput);
    this.controller.dispose();
    this.interaction.dispose();
    for (const layer of [...this.tilesets]) this.removeTileset(layer);
    for (const layer of [...this.vectorLayers]) this.removeGeoJson(layer);
    for (const layer of [...this.pointLayers]) this.removePoints(layer);
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
