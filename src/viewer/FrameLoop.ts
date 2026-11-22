/**
 * Frame loop of a viewer (P2.1a, P3.3): on every animation frame decides whether to update and
 * draw (idle throttling, still supersampled views, off-screen containers), then updates every
 * part in a fixed order and draws live, one more supersampling sample, or nothing. Also renders
 * outside the loop (screenshots, level transition captures) and keeps the frame statistics and
 * the load state.
 *
 * The order of the calls in `frame` matters (camera collision before the controller, clip
 * planes before the environment, shadow and cloud maps bound before the scene pass, the pick
 * buffer after it): change it only on purpose.
 */
import { Vector3, type PerspectiveCamera, type Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { CloudLayer } from '../clouds/CloudLayer';
import type { VolumetricClouds } from '../clouds/VolumetricClouds';
import type { Ellipsoid } from '../core/Ellipsoid';
import type { EventEmitter } from '../core/EventEmitter';
import type { GpuProfile } from '../core/gpuProfile';
import { clamp } from '../core/math';
import type { Globe } from '../globe/Globe';
import type { OverlayCompositor } from '../globe/OverlayCompositor';
import { tileDebugUniforms } from '../globe/TileMaterial';
import type { IndoorManager } from '../indoor/IndoorManager';
import type { SunShadows } from '../lighting/SunShadows';
import type { LocalScene } from '../local/LocalScene';
import type { MarkerManager } from '../markers/MarkerManager';
import type { PointLayer } from '../markers/PointLayer';
import type { EffectMarks } from '../post/EffectMarks';
import type { LevelTransition } from '../post/LevelTransition';
import type { PostPipeline } from '../post/PostPipeline';
import type { Supersampling } from '../post/Supersampling';
import type { SplatLayer } from '../splats/SplatLayer';
import type { Tiles3DLayer, TilesViewState } from '../tiles3d/Tiles3DLayer';
import type { GeoJsonLayer } from '../vector/GeoJsonLayer';
import type { LabelManager } from '../vector/LabelManager';
import { cameraDirection } from './cameraMath';
import { cloudFrameRate, drawMode, MAX_IDLE_FRAME_RATE, volumetricCloudFrameRate, type FramePacer } from './framePacing';
import type { GlobeCameraController } from './GlobeCameraController';
import type { IndoorBackdrop } from './IndoorBackdrop';
import type { InteractionManager } from './InteractionManager';
import { LoadTracker, summarizeLoad, type LoadState } from './loadState';
import type { PickBuffer } from './PickBuffer';
import type { SurfaceHeightQuery } from './SurfaceHeight';
import type { ViewerEnvironment } from './ViewerEnvironment';
import type { ViewerLayers } from './ViewerLayers';
import type { FrameStats, RendererInfo, ViewerEvents } from './viewerTypes';
import { enteredBuilding, type ViewerState } from './viewerState';

/** What the frame loop updates and draws: every part of its viewer. */
export interface FrameHost {
  readonly state: ViewerState;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly container: HTMLElement;
  readonly info: RendererInfo;
  readonly gpu: GpuProfile;
  /** `viewer.stats`, written every frame. */
  readonly stats: FrameStats;
  readonly events: EventEmitter<ViewerEvents>;
  readonly pacer: FramePacer;
  readonly globe: Globe;
  readonly controller: GlobeCameraController;
  readonly clouds: CloudLayer;
  readonly volumetricClouds: VolumetricClouds;
  readonly indoor: IndoorManager;
  readonly backdrop: IndoorBackdrop;
  readonly localScene: LocalScene;
  readonly interaction: InteractionManager;
  readonly labels: LabelManager;
  readonly markers: MarkerManager;
  readonly marks: EffectMarks;
  readonly overlays: OverlayCompositor;
  readonly postProcessing: PostPipeline;
  readonly supersampling: Supersampling;
  readonly levelTransition: LevelTransition;
  readonly shadows: SunShadows;
  readonly pickBuffer: PickBuffer<Tiles3DLayer> | null;
  readonly tilesets: readonly Tiles3DLayer[];
  readonly vectorLayers: readonly GeoJsonLayer[];
  readonly pointLayers: readonly PointLayer[];
  readonly splatLayers: readonly SplatLayer[];
  readonly surface: SurfaceHeightQuery;
  readonly environment: ViewerEnvironment;
  readonly layers: ViewerLayers;
  requestRender(): void;
  wake(): void;
  /** Hides the buildings outside a local scene that hides its surroundings. */
  updateBuildingsInRegion(): void;
}

/**
 * A gap between animation frames longer than this means they were paused (hidden page, sleep): the
 * view is drawn again. Above the roughly 1 s rAF interval of occluded windows in automated browsers.
 */
const RESUME_GAP_MS = 2000;

const _v = new Vector3();
const _dir = new Vector3();

export class FrameLoop {
  /** Whether the container intersects the viewport; frames stop while it does not. */
  onScreen = true;
  private disposed = false;
  private _loadState: LoadState = { globe: 0, tilesets: 0, layers: 0, pending: 0, idle: false };
  private readonly loadTracker = new LoadTracker();
  private lastTime = -1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private timestampPending = false;
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
  /** Seconds the globe has been hidden, and whether its tile cache was released for it. */
  private globeHiddenFor = 0;
  private globeReleased = false;

  constructor(private readonly viewer: FrameHost) {
    // Statistics of the scene pass alone (the pick buffer's signature and `stats`); the pick pass renders the scene later.
    viewer.scene.onAfterRender = (r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (r as any).info;
      this.sceneDrawCalls = info.render?.drawCalls ?? info.render?.calls ?? 0;
      this.sceneTriangles = info.render?.triangles ?? 0;
    };
  }

  /** The globe is shown again: a later hide counts from zero, and its released cache refills. */
  globeShown(): void {
    this.globeHiddenFor = 0;
    this.globeReleased = false;
  }

  /** Stops updating and drawing (`viewer.dispose()`). */
  dispose(): void {
    this.disposed = true;
  }

  /** Per animation frame: update and draw, unless the view is quiet and throttled, or the container is off screen. */
  tick(time: number): void {
    if (this.disposed) return;
    // Animation frames stop while the page is hidden (or the computer sleeps): draw again when they
    // resume rather than rely on the canvas still holding a still picture.
    if (this.lastAnimationFrame >= 0 && time - this.lastAnimationFrame > RESUME_GAP_MS) this.viewer.requestRender();
    this.lastAnimationFrame = time;
    if (!this.onScreen) return;
    this.checkPendingWork();
    const floor = this.idleFloorRate();
    // A still view being supersampled takes its samples at the full rate.
    const refining = this.viewer.supersampling.enabled && !this.viewer.supersampling.converged && this.viewer.pacer.isStill(performance.now(), floor);
    if (!this.viewer.pacer.shouldTick(time, floor, refining)) return;
    this.viewer.pacer.ticked(time);
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
    const version = this.viewer.overlays.version;
    if (version !== this.overlayVersion) this.viewer.requestRender();
    this.overlayVersion = version;
    if (this.viewer.markers.busy || this.viewer.pointLayers.some((l) => l.busy)) this.viewer.wake();
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
    const cam = this.viewer.camera;
    const canvas = this.viewer.renderer.domElement;
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
    put(this.viewer.state.showGlobe ? this.viewer.globe.surfaceSignature : 0);
    put(this.viewer.state.date.getTime());
    put(this.viewer.renderer.toneMapping);
    put(this.viewer.renderer.toneMappingExposure);
    put(tileDebugUniforms.showTileBorders.value as number);
    put(tileDebugUniforms.levelTint.value as number);
    return changed;
  }

  /** Frames per second that what still moves on its own needs while quiet: simulated time, cloud drift. */
  private idleFloorRate(): number {
    // Motion started from code since the last frame (flyTo, zoomBy, playAnimation...) shows at once.
    if (this.viewer.state.timeMultiplier !== 0 || this.viewer.controller.inMotion || this.viewer.postProcessing.animating) return MAX_IDLE_FRAME_RATE;
    let rate = 0;
    if (this.viewer.clouds.mesh.visible) {
      const o = this.viewer.clouds.getOptions();
      rate = cloudFrameRate({
        speedDegPerSec: o.speed,
        layerRadius: this.viewer.ellipsoid.radii.x + o.height,
        distance: this.viewer.state.cameraCarto.height - o.height,
        fovDeg: this.viewer.camera.fov,
        viewportHeight: this.viewer.container.clientHeight,
      });
    }
    if (this.viewer.volumetricClouds.visible) {
      // The wind moves the volumetric clouds (0 m/s: they hold still and the view can be still).
      const v = this.viewer.clouds.volumetricOptions;
      rate = Math.max(
        rate,
        volumetricCloudFrameRate({
          windSpeed: v.windSpeed,
          cameraHeight: this.viewer.state.cameraCarto.height,
          bottom: v.bottom,
          top: v.bottom + v.thickness,
          fovDeg: this.viewer.camera.fov,
          viewportHeight: this.viewer.container.clientHeight,
        }),
      );
    }
    return rate;
  }

  private frame(time: number): void {
    if (this.disposed) return;
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min((time - this.lastTime) / 1000, 0.25);
    this.lastTime = time;
    if (this.viewer.state.timeMultiplier !== 0) this.viewer.state.date = new Date(this.viewer.state.date.getTime() + dt * 1000 * this.viewer.state.timeMultiplier);

    // Camera collision queries the ground first thing in the frame.
    this.viewer.surface.beginFrame();
    this.viewer.controller.update(dt);
    this.updateClipPlanes();
    this.viewer.camera.updateMatrixWorld();
    this.viewer.environment.update();
    // cameraCarto was refreshed by updateClipPlanes.
    this.viewer.clouds.update(dt, this.viewer.state.cameraCarto.height);

    const t0 = performance.now();
    if (this.viewer.state.showGlobe) this.viewer.globe.update(this.viewer.camera, this.viewer.container.clientHeight);
    else this.releaseHiddenGlobe(dt);
    const tilesView = this.viewer.tilesets.length > 0 ? this.tilesViewState() : undefined;
    // Entered a building before the 3D Tiles loaded (e.g. ?demo): keep them loading, undrawn, until it has ground.
    const probe = this.viewer.layers.tilesetsSuppressed && !this.viewer.state.showGlobe && performance.now() < this.viewer.layers.probeUntil && this.viewer.indoor.awaitingGround;
    for (const layer of this.viewer.tilesets) {
      layer.probe = probe;
      layer.update(dt, tilesView);
      // The window counts from the last loading activity, not from when the tiles were suppressed.
      if (probe && layer.tiles.loadProgress < 1) this.viewer.layers.extendGroundProbe();
    }
    // The local scene's transition and walls follow this frame's globe and tiles.
    if (this.viewer.localScene.update(dt)) {
      // Clip and outside fade change what is drawn without changing the draw statistics.
      this.viewer.pickBuffer?.invalidate();
      this.viewer.requestRender();
    }
    if (this.viewer.localScene.engaged) {
      this.viewer.clouds.mesh.visible = false;
      this.viewer.updateBuildingsInRegion();
    }
    // Floor expansion and re-grounding move content without changing the draw statistics.
    if (this.viewer.indoor.update(dt)) {
      this.viewer.pickBuffer?.invalidate();
      this.viewer.shadows.invalidate();
      this.viewer.requestRender();
    }
    this.viewer.layers.updateSplats(dt, this.viewer.container.clientHeight);
    const building = enteredBuilding(this.viewer.indoor);
    const bare = this.viewer.state.indoorBackdrop && building !== null && !this.viewer.state.showGlobe && !this.viewer.tilesets.some((l) => l.active);
    if (this.viewer.backdrop.update(bare ? building : null, dt)) this.viewer.requestRender();
    this.viewer.interaction.update();
    if (this.viewer.labels.update(this.viewer.camera, this.viewer.container.clientWidth, this.viewer.container.clientHeight, dt)) this.viewer.requestRender();
    // Changes nothing reported: fades and morphs in progress, and what `pictureChanged` compares.
    const globeAnimating = this.viewer.state.showGlobe && !this.viewer.globe.freeze && this.viewer.globe.animating;
    if (globeAnimating || this.viewer.tilesets.some((l) => l.animating) || this.pictureChanged()) this.viewer.requestRender();

    this.viewer.marks.refresh();
    // Live, one more supersampling sample of a still view, or nothing (the still picture is complete).
    const now = performance.now();
    const mode = drawMode(this.viewer.pacer.isStill(now, this.idleFloorRate()), this.viewer.supersampling.enabled, this.viewer.postProcessing.samples, this.viewer.supersampling.samples);
    // The shadow map is drawn again only when its fit moved or the buildings changed.
    if (mode !== 'hold') {
      this.viewer.shadows.render(this.viewer.indoor.root);
      // Weather and cloud shadow maps, and this viewer's cloud shadows bound for the receivers.
      this.viewer.environment.updateVolumetricClouds(dt);
      this.viewer.volumetricClouds.renderMaps();
    }
    if (mode === 'live') this.viewer.postProcessing.render();
    else if (mode === 'sample') this.viewer.postProcessing.renderSample();
    if (mode !== 'hold') this.lastDrawAt = now;
    // Point layers clamp to the terrain and cluster before the markers are placed.
    for (const layer of this.viewer.pointLayers) layer.update(this.viewer.camera, this.viewer.container.clientWidth, this.viewer.container.clientHeight);
    this.viewer.markers.update(this.viewer.camera, this.viewer.container.clientWidth, this.viewer.container.clientHeight);
    const drawCalls = this.sceneDrawCalls;
    const triangles = this.sceneTriangles;
    // After the main render, whose statistics are part of the pick buffer's scene signature; counted in the frame time.
    this.viewer.pickBuffer?.update(performance.now(), drawCalls, triangles, this.viewer.state.showGlobe ? this.viewer.globe.surfaceSignature : 0);
    this.updateStats(dt, performance.now() - t0, drawCalls, triangles, mode === 'hold');
    this.updateLoadState();
  }

  /** What is still loading, as of the last frame (see `LoadState`; the 'load-progress' and 'idle' events). */
  get loadState(): Readonly<LoadState> {
    return this._loadState;
  }

  private updateLoadState(): void {
    let tilesets = 0;
    for (const layer of this.viewer.tilesets) tilesets += layer.pending;
    let layers = 0;
    for (const layer of this.viewer.vectorLayers) if (!layer.ready && layer.error === null) layers++;
    for (const layer of this.viewer.pointLayers) if (!layer.ready && layer.error === null) layers++;
    for (const layer of this.viewer.splatLayers) if (!layer.ready && layer.error === null) layers++;
    const state = summarizeLoad({
      globe: this.viewer.state.showGlobe ? this.viewer.globe.stats : null,
      imageryUnreachable: this.viewer.globe.imageryError !== null,
      tilesets,
      layers,
    });
    this._loadState = state;
    if (!state.idle) this.viewer.requestRender();
    const { progress, idle } = this.loadTracker.step(state);
    if (progress) this.viewer.events.emit('load-progress', state);
    if (idle) this.viewer.events.emit('idle', state);
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
    if (this.globeHiddenFor < this.viewer.gpu.globe.hiddenReleaseSeconds) return;
    this.globeReleased = true;
    this.viewer.globe.releaseHidden(this.viewer.gpu.globe.hiddenKeepTiles);
  }

  /** Camera height above the ground and tilt, for the distance falloff of 3D Tiles (cameraCarto is current). */
  private tilesViewState(): TilesViewState {
    const cam = this.viewer.camera;
    const up = this.viewer.ellipsoid.geodeticNormal(cam.position, _v);
    cameraDirection(cam.quaternion, _dir);
    const ground = this.viewer.state.showGlobe ? (this.viewer.globe.getHeight(this.viewer.state.cameraCarto.longitude, this.viewer.state.cameraCarto.latitude) ?? 0) : this.viewer.state.viewGround;
    return { altitude: Math.max(1, this.viewer.state.cameraCarto.height - ground), viewDotUp: _dir.dot(up) };
  }

  private updateClipPlanes(): void {
    const cam = this.viewer.camera;
    const c = this.viewer.ellipsoid.cartesianToCartographic(cam.position, this.viewer.state.cameraCarto);
    const ground = c && this.viewer.state.showGlobe ? (this.viewer.globe.getHeight(c.longitude, c.latitude) ?? 0) : 0;
    const altitude = Math.max(1, (c?.height ?? 0) - ground);
    const r = cam.position.length();
    const rMin = this.viewer.ellipsoid.minimumRadius - 500;
    const horizon = Math.sqrt(Math.max(r * r - rMin * rMin, 0));
    // Mountains and tall 3D tiles stay visible a little past the geometric horizon.
    const far = horizon + 400_000 + altitude * 0.5;
    const near = this.viewer.info.reversedDepth ? clamp(altitude * 0.002, 0.05, 5_000) : clamp(altitude * 0.05, 0.5, 200_000);
    if (Math.abs(cam.near - near) > near * 0.01 || Math.abs(cam.far - far) > far * 0.01) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * A level change is about to alter what is shown: capture the picture on screen (the
   * supersampled one when the view was still and nothing changed since) for the transition.
   */
  beginLevelTransition(): void {
    if (this.disposed || !(this.viewer.levelTransition.duration > 0) || document.visibilityState === 'hidden') return;
    const fromHistory = this.viewer.postProcessing.samples > 0 && this.viewer.pacer.changedAt < this.lastDrawAt;
    if (!fromHistory) {
      // Drawn outside the frame loop: this viewer's shared uniforms first (see renderOutsideFrame).
      this.viewer.environment.update();
      this.viewer.shadows.render(this.viewer.indoor.root);
      this.viewer.volumetricClouds.bind();
      this.viewer.labels.syncCamera(this.viewer.camera);
      this.viewer.marks.refresh();
    }
    this.viewer.levelTransition.begin(fromHistory);
    this.viewer.requestRender();
  }

  /**
   * Renders outside the frame loop (screenshots, transition captures). The atmosphere and label
   * uniforms are shared by every viewer on the page and hold whatever the last viewer to render
   * wrote: put this viewer's camera and settings back first.
   */
  renderOutsideFrame(): void {
    // A supersampled picture that nothing has changed since is the view as it is: show it again
    // (better, and no scene pass). Otherwise draw live.
    if (this.viewer.postProcessing.samples > 0 && this.viewer.pacer.changedAt < this.lastDrawAt && this.viewer.postProcessing.present()) return;
    this.viewer.environment.update();
    this.viewer.shadows.render(this.viewer.indoor.root);
    this.viewer.volumetricClouds.bind();
    this.viewer.labels.syncCamera(this.viewer.camera);
    this.viewer.marks.refresh();
    this.viewer.postProcessing.render();
  }

  /** Frame statistics; draw calls and triangles are those of the scene pass (not the post-processing or pick passes). */
  private updateStats(dt: number, cpuMs: number, drawCalls: number, triangles: number, held: boolean): void {
    if (!held) this.fpsFrames++;
    this.fpsTime += dt;
    this.viewer.stats.drawCalls = drawCalls;
    this.viewer.stats.triangles = triangles;
    this.viewer.stats.throttled = this.viewer.pacer.throttled;
    this.viewer.stats.still = held;
    this.viewer.stats.samples = this.viewer.supersampling.sampleCount;
    this.viewer.stats.frameMs = this.viewer.stats.frameMs * 0.9 + cpuMs * 0.1;
    if (this.fpsTime >= 0.5) {
      this.viewer.stats.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      if (this.viewer.info.timestampQuery && !this.timestampPending) {
        this.timestampPending = true;
        this.viewer.renderer
          .resolveTimestampsAsync('render')
          .then((ms) => {
            if (typeof ms === 'number' && ms > 0) this.viewer.stats.gpuMs = ms;
          })
          .catch(() => undefined)
          .finally(() => {
            this.timestampPending = false;
          });
      }
    }
    this.viewer.events.emit('frame', this.viewer.stats);
  }
}
