/**
 * Layers of a viewer and the ground they stand on: 3D Tiles, GeoJSON, point and Gaussian splat
 * layers (add, remove, highlights), glTF loading with the shared decoders, the ground height every "stand on
 * the ground" query uses (`viewer.surfaceHeight`: terrain with the globe, vertical rays onto
 * 3D Tiles without it) and the ground the camera may not pass (collision).
 */
import { Raycaster, Vector3, type Object3D, type PerspectiveCamera, type Scene, type Sphere } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { cartographic, type Ellipsoid } from '../core/Ellipsoid';
import type { EventEmitter } from '../core/EventEmitter';
import type { GpuProfile } from '../core/gpuProfile';
import type { ViewerMessages } from '../core/i18n';
import { DEG2RAD } from '../core/math';
import type { Globe } from '../globe/Globe';
import type { IndoorManager } from '../indoor/IndoorManager';
import type { LocalScene } from '../local/LocalScene';
import type { MarkerManager } from '../markers/MarkerManager';
import { PointLayer, type PointLayerOptions } from '../markers/PointLayer';
import { SplatLayer, type SplatLayerOptions } from '../splats/SplatLayer';
import type { NodeMaterialLibrary } from '../tiles3d/nodeMaterials';
import { Tiles3DLayer, type LoaderKit, type TileFeature, type Tiles3DLayerOptions } from '../tiles3d/Tiles3DLayer';
import type { FeatureHighlightStyle } from '../tiles3d/tileFeatures';
import { GeoJsonLayer, type GeoJsonLayerOptions } from '../vector/GeoJsonLayer';
import type { LabelManager } from '../vector/LabelManager';
import type { FeatureHit } from '../vector/types';
import type { VectorService } from '../vector/VectorService';
import { SurfaceHeightQuery, type SurfaceHeight, type SurfaceHeightOptions, type SurfaceSample } from './SurfaceHeight';
import type { RendererInfo, SphereFlightOptions, ViewerEvents, ViewPosition } from './viewerTypes';
import { enteredBuilding, type ViewerState } from './viewerState';

/** What the layers read of their viewer; the layer arrays are the viewer's own (`viewer.tilesets` ...). */
export interface LayersHost {
  readonly state: ViewerState;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly info: RendererInfo;
  readonly gpu: GpuProfile;
  readonly messages: ViewerMessages;
  readonly events: EventEmitter<ViewerEvents>;
  readonly globe: Globe;
  readonly indoor: IndoorManager;
  readonly localScene: LocalScene;
  readonly vectors: VectorService;
  readonly labels: LabelManager;
  readonly markers: MarkerManager;
  readonly tilesets: Tiles3DLayer[];
  readonly vectorLayers: GeoJsonLayer[];
  readonly pointLayers: PointLayer[];
  readonly splatLayers: SplatLayer[];
  /** `GeoViewerOptions.decoderPath` / `transcoderPath` ('' for the copies shipped with three.js). */
  readonly decoderPath: string;
  readonly transcoderPath: string;
  requestRender(): void;
  flyToBBox(bbox: [number, number, number, number], duration?: number): Promise<void>;
  flyToSphere(sphere: Sphere, heading?: number, pitch?: number, duration?: number, options?: SphereFlightOptions): Promise<void>;
  getView(): Required<ViewPosition>;
}

/** Vertical surface rays start this high above the ellipsoid (meters; above any building or photogrammetry)… */
const SURFACE_RAY_TOP = 10_000;
/** …and reach this far below it (Dead Sea shore, ellipsoid below the geoid). */
const SURFACE_RAY_BOTTOM = 1_000;
/** How long suppressed 3D Tiles keep loading for a building still waiting for ground, after the last loading activity, ms. */
const GROUND_PROBE_MS = 15_000;

const _carto = cartographic();
const _dir = new Vector3();
const _localPoint = new Vector3();

export class ViewerLayers {
  /** Unified ground height: terrain with the globe, 3D Tiles without it (`surfaceHeight`). */
  readonly surface: SurfaceHeightQuery;
  /** 3D Tiles are suppressed inside a building (indoor level control). */
  tilesetsSuppressed = false;
  /** Until when suppressed 3D Tiles keep loading for buildings still waiting for ground (`performance.now()` ms). */
  probeUntil = 0;
  /** Vertical rays onto 3D Tiles for `surfaceHeight` (separate from the pointer raycaster). */
  private readonly surfaceRaycaster = new Raycaster();
  private loaders: LoaderKit | null = null;
  private gltfLoader: GLTFLoader | null = null;

  constructor(private readonly viewer: LayersHost) {
    this.surface = new SurfaceHeightQuery({
      globeShown: () => viewer.state.showGlobe,
      terrain: (lon, lat) => {
        const s = viewer.globe.sampleHeight(lon, lat);
        return s && { height: s.height, resolution: s.cellSize };
      },
      tilesActive: () => viewer.tilesets.some((l) => l.measurable),
      raycastTiles: (lon, lat) => this.raycastTilesVertical(lon, lat),
      now: () => performance.now(),
    });
  }

  /** `viewer.surfaceHeight` (degrees in). */
  surfaceHeight(longitude: number, latitude: number, options?: SurfaceHeightOptions): SurfaceHeight {
    const outside = this.groundOutsideRegion(longitude * DEG2RAD, latitude * DEG2RAD);
    if (outside !== null) return outside;
    return this.surface.query(longitude * DEG2RAD, latitude * DEG2RAD, options);
  }

  /** Outside a local scene that hides its surroundings, the ground is the base of its walls (radians in). */
  private groundOutsideRegion(lon: number, lat: number): SurfaceHeight | null {
    const ls = this.viewer.localScene;
    if (!ls.hidesOutside) return null;
    const p = this.viewer.ellipsoid.cartographicToCartesian(lon, lat, ls.groundOutside, _localPoint);
    if (ls.showsWorld(p, 0)) return null;
    return { height: ls.groundOutside, resolution: 0, source: 'ellipsoid', reliable: true, held: false };
  }

  /** Highest active 3D Tiles surface on the vertical through a position (radians), with the hit tile's geometric error. */
  raycastTilesVertical(lon: number, lat: number): SurfaceSample | null {
    const rc = this.surfaceRaycaster;
    const cosLat = Math.cos(lat);
    _dir.set(cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat));
    // From well above the tallest buildings and photogrammetry, straight down.
    this.viewer.ellipsoid.cartographicToCartesian(lon, lat, SURFACE_RAY_TOP, rc.ray.origin);
    rc.ray.direction.copy(_dir).negate();
    rc.near = 0;
    rc.far = SURFACE_RAY_TOP + SURFACE_RAY_BOTTOM;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rc as any).firstHitOnly = true;
    let best: SurfaceSample | null = null;
    let bestDistance = Infinity;
    for (const layer of this.viewer.tilesets) {
      if (!layer.measurable) continue;
      const hit = rc.intersectObject(layer.group, true)[0];
      if (!hit || hit.distance >= bestDistance) continue;
      bestDistance = hit.distance;
      const tile = hit.object.userData.tile as { geometricError?: number } | undefined;
      const height = this.viewer.ellipsoid.cartesianToCartographic(hit.point, _carto)?.height;
      if (height === undefined) continue;
      best = { height, resolution: tile?.geometricError ?? Infinity };
    }
    return best;
  }

  /**
   * Ground height for camera collision (`surfaceHeight`). Only data whose grid
   * spacing / geometric error is fine relative to the camera's height counts:
   * coarse or interpolated surfaces (common while streaming) would otherwise
   * shove the camera up. Without the globe and without reliable 3D Tiles the
   * floor is 0 m.
   */
  collisionGround(lon: number, lat: number): number | null {
    // Beside a local scene: no diving below the base of its walls.
    const outside = this.groundOutsideRegion(lon, lat);
    if (outside) return outside.height;
    // Without the globe the entered building's ground is the floor of the world (no diving under the backdrop).
    const building = this.viewer.state.showGlobe ? null : enteredBuilding(this.viewer.indoor);
    if (building) return building.groundHeight;
    const unknown = this.viewer.state.showGlobe ? null : 0;
    const coarse = this.surface.query(lon, lat, { maxCellSize: Infinity });
    if (coarse.source === 'ellipsoid') return unknown;
    this.viewer.state.viewGround = coarse.height;
    const c = this.viewer.ellipsoid.cartesianToCartographic(this.viewer.camera.position, _carto);
    const above = (c?.height ?? 0) - coarse.height;
    const fine = this.surface.query(lon, lat, { maxCellSize: Math.max(50, above * 1.5) });
    return fine.reliable ? fine.height : unknown;
  }

  addTileset(options: Tiles3DLayerOptions): Tiles3DLayer {
    const layer = new Tiles3DLayer(options, this.getLoaders(), this.viewer.ellipsoid, this.viewer.gpu.tiles);
    layer.tiles.setCamera(this.viewer.camera);
    layer.tiles.setResolutionFromRenderer(this.viewer.camera, this.viewer.renderer as never);
    if (options.level) this.viewer.indoor.bindings.bind(layer, options.level, { showing: () => layer.ready && layer.visible });
    layer.suppressed = this.hiddenByLevel(layer, false);
    layer.events.on('ready', () => this.extendGroundProbe());
    layer.events.on('error', ({ error }) => this.viewer.events.emit('error', { source: 'tileset', error, layer }));
    // Tiles loaded, `visible` or `heightOffset` set.
    layer.events.on('change', () => this.viewer.requestRender());
    // Heights measured on a tileset that moved are out of date.
    layer.events.on('moved', () => this.surface.clearHeld());
    this.viewer.scene.add(layer.group);
    this.viewer.tilesets.push(layer);
    this.viewer.localScene.attachLayer(layer);
    this.surface.clearHeld();
    this.viewer.events.emit('tilesets-changed', this.viewer.tilesets);
    return layer;
  }

  removeTileset(layer: Tiles3DLayer): void {
    const i = this.viewer.tilesets.indexOf(layer);
    if (i < 0) return;
    this.viewer.tilesets.splice(i, 1);
    this.surface.clearHeld();
    this.viewer.indoor.bindings.unbind(layer);
    layer.dispose();
    this.viewer.events.emit('tilesets-changed', this.viewer.tilesets);
  }

  /** Restarts the window in which suppressed 3D Tiles keep loading for buildings without ground. */
  extendGroundProbe(): void {
    this.probeUntil = performance.now() + GROUND_PROBE_MS;
  }

  setTilesetsSuppressed(suppressed: boolean): void {
    if (suppressed === this.tilesetsSuppressed) return;
    this.tilesetsSuppressed = suppressed;
    if (suppressed) this.extendGroundProbe();
    for (const layer of this.viewer.tilesets) layer.suppressed = this.hiddenByLevel(layer, false);
  }

  /**
   * Whether the level the view is in hides a layer: by its level binding when it has one
   * (`indoor.bindings`), else by the rule for context layers (hidden with the 3D Tiles while
   * an indoor level is entered, unless the layer stays indoors).
   */
  hiddenByLevel(layer: object, showIndoors: boolean): boolean {
    const binding = this.viewer.indoor.bindings.get(layer);
    return binding ? !binding.shown : this.tilesetsSuppressed && !showIndoors;
  }

  addGeoJson(options: GeoJsonLayerOptions): GeoJsonLayer {
    const layer = new GeoJsonLayer(options, this.viewer.vectors, this.viewer.labels);
    this.viewer.vectorLayers.push(layer);
    layer.events.on('ready', () => this.viewer.events.emit('vectors-changed', this.viewer.vectorLayers));
    layer.events.on('error', ({ error }) => this.viewer.events.emit('error', { source: 'geojson', error, layer }));
    // Visibility, style and label style (labels are not part of the overlay version).
    layer.events.on('change', () => this.viewer.requestRender());
    this.viewer.events.emit('vectors-changed', this.viewer.vectorLayers);
    return layer;
  }

  removeGeoJson(layer: GeoJsonLayer): void {
    const i = this.viewer.vectorLayers.indexOf(layer);
    if (i < 0) return;
    this.viewer.vectorLayers.splice(i, 1);
    layer.dispose();
    this.viewer.events.emit('vectors-changed', this.viewer.vectorLayers);
  }

  /** `viewer.addPoints`. */
  addPoints(options: PointLayerOptions): PointLayer {
    const layer = new PointLayer(options, {
      messages: this.viewer.messages,
      ellipsoid: this.viewer.ellipsoid,
      markers: this.viewer.markers,
      // Detailed queries need reliable data; the coarse one takes any estimate, but not the 0 m of "no data".
      groundHeight: (lon, lat, maxCellSize) => {
        const s = this.surface.query(lon, lat, { maxCellSize: maxCellSize ?? Infinity });
        return s.reliable ? s.height : null;
      },
      flyToBBox: (bbox) => void this.viewer.flyToBBox(bbox),
    });
    this.viewer.pointLayers.push(layer);
    layer.events.on('ready', () => this.viewer.events.emit('points-changed', this.viewer.pointLayers));
    layer.events.on('error', ({ error }) => {
      this.viewer.events.emit('points-changed', this.viewer.pointLayers);
      this.viewer.events.emit('error', { source: 'points', error, layer });
    });
    layer.events.on('click', (e) => this.viewer.events.emit('point-click', e));
    this.viewer.events.emit('points-changed', this.viewer.pointLayers);
    return layer;
  }

  removePoints(layer: PointLayer): void {
    const i = this.viewer.pointLayers.indexOf(layer);
    if (i < 0) return;
    this.viewer.pointLayers.splice(i, 1);
    layer.dispose();
    this.viewer.events.emit('points-changed', this.viewer.pointLayers);
  }

  /** `viewer.addSplats`. */
  addSplats(options: SplatLayerOptions): SplatLayer {
    const viewer = this.viewer;
    const layer = new SplatLayer(options, {
      ellipsoid: viewer.ellipsoid,
      quality: viewer.gpu.splats,
      webgpu: viewer.info.backend === 'WebGPU',
      groundHeight: (lon, lat) => {
        const s = this.surface.query(lon, lat);
        return s.reliable ? s.height : null;
      },
      flyToSphere: (sphere, heading, pitch, duration) => viewer.flyToSphere(sphere, heading ?? viewer.getView().heading, pitch ?? -25, duration, { rangeScale: 1.1, minRange: 0.5 }),
      bindLevel: (bound, level) => {
        // The entity's geometry steps back only while the capture is really there to replace it.
        if (level) viewer.indoor.bindings.bind(bound, level, { showing: () => bound.ready && bound.visible });
        else viewer.indoor.bindings.unbind(bound);
        viewer.requestRender();
      },
    });
    layer.suppressed = this.hiddenByLevel(layer, layer.showIndoors);
    layer.events.on('ready', () => viewer.events.emit('splats-changed', viewer.splatLayers));
    layer.events.on('error', ({ error }) => {
      viewer.events.emit('splats-changed', viewer.splatLayers);
      viewer.events.emit('error', { source: 'splats', error, layer });
    });
    // Loaded, `visible`, `opacity`, `brightness`, `crop` or the placement set.
    layer.events.on('change', () => viewer.requestRender());
    viewer.scene.add(layer.group);
    viewer.splatLayers.push(layer);
    viewer.events.emit('splats-changed', viewer.splatLayers);
    return layer;
  }

  removeSplats(layer: SplatLayer): void {
    const i = this.viewer.splatLayers.indexOf(layer);
    if (i < 0) return;
    this.viewer.splatLayers.splice(i, 1);
    this.viewer.indoor.bindings.unbind(layer);
    layer.dispose();
    this.viewer.events.emit('splats-changed', this.viewer.splatLayers);
  }

  /**
   * Per frame: splat layers follow the ground or the frame of their level, fade in and are
   * hidden while too small on screen; the level the view is in shows or hides them
   * (`hiddenByLevel`), and outside a local scene that hides its surroundings they go with
   * everything else there.
   */
  updateSplats(dt: number, viewportHeight: number): void {
    const ls = this.viewer.localScene;
    for (const layer of this.viewer.splatLayers) {
      if (layer.framed) {
        const entity = this.viewer.indoor.bindings.get(layer)?.entity ?? null;
        entity?.group.updateWorldMatrix(true, false);
        if (layer.setFrame(entity ? entity.group.matrixWorld : null)) this.viewer.requestRender();
      }
      const outside = ls.hidesOutside && layer.ready && !ls.showsWorld(layer.boundingSphere.center, 0);
      layer.suppressed = outside || this.hiddenByLevel(layer, layer.showIndoors);
      if (layer.update(dt, this.viewer.camera, viewportHeight) || layer.animating) this.viewer.requestRender();
    }
  }

  /** Highlights a picked feature (null clears). */
  highlightFeature(hit: FeatureHit | null): void {
    this.viewer.vectors.setHighlight(hit);
    this.viewer.requestRender();
  }

  /** `viewer.highlightedFeature`. */
  get highlightedFeature(): { layerId: number; featureId: number } | null {
    return this.viewer.vectors.highlighted;
  }

  /** `viewer.highlightTileFeature`: one feature at a time across all layers. */
  highlightTileFeature(feature: TileFeature | null, style?: FeatureHighlightStyle): void {
    for (const layer of this.viewer.tilesets) if (layer !== feature?.layer && layer.highlighted) layer.setHighlight(null);
    if (feature && this.viewer.tilesets.includes(feature.layer)) feature.layer.setHighlight(feature, style);
    this.viewer.requestRender();
  }

  /** The feature set by `highlightTileFeature`, or null (also after its tile was unloaded). */
  get highlightedTileFeature(): TileFeature | null {
    for (const layer of this.viewer.tilesets) if (layer.highlighted) return layer.highlighted;
    return null;
  }

  private getLoaders(): LoaderKit {
    if (!this.loaders) {
      // Decoder binaries ship with three.js; its loaders reference them relative to their own
      // module, so the host's bundler copies them. `decoderPath` / `transcoderPath` point elsewhere.
      const dracoLoader = new DRACOLoader();
      if (this.viewer.decoderPath) dracoLoader.setDecoderPath(this.viewer.decoderPath);
      const ktxLoader = new KTX2Loader();
      if (this.viewer.transcoderPath) ktxLoader.setTranscoderPath(this.viewer.transcoderPath);
      ktxLoader.detectSupport(this.viewer.renderer as never);
      this.loaders = {
        dracoLoader,
        ktxLoader,
        meshoptDecoder: MeshoptDecoder,
        nodeLibrary: (this.viewer.renderer as unknown as { library: NodeMaterialLibrary }).library,
      };
    }
    return this.loaders;
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
}
