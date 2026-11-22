/**
 * A 3D Gaussian splatting scene placed on the globe (`viewer.addSplats`): loads a `.ply`,
 * `.splat` or `.spz` file in a Worker, keeps it within the GPU tier's splat budget, anchors
 * it at a longitude / latitude / height with heading, pitch, roll and scale, and draws it
 * with three.js's `GaussianSplat` (WebGPU compute sort; CPU sort on the WebGL backend).
 *
 * What this class adds to the three.js object: placement in ECEF with float64 matrices,
 * following the ground, linear-light output for the HDR scene pass, opacity / fade,
 * hiding when too small on screen, cropping, CPU picking through a hierarchy (`raycast`),
 * memory accounting and release of the GPU buffers. See docs/agents/splats.md.
 */
import { Group, Matrix4, Sphere, Vector3, type PerspectiveCamera, type Ray } from 'three';
import { Fn, sRGBTransferEOTF, uniform, vec4 } from 'three/tsl';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from 'three/addons/utils/GaussianSplatUtils.js';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { Ellipsoid } from '../core/Ellipsoid';
import { TerraViewError, type TerraViewErrorCode } from '../core/errors';
import { EventEmitter } from '../core/EventEmitter';
import type { SplatQuality } from '../core/gpuProfile';
import { clamp, DEG2RAD, smoothstep } from '../core/math';
import { cropSplats, selectSplats, splatGpuBytes, type SplatBounds, type SplatCrop, type SplatData, type SplatShDegree } from './splatData';
import type { SplatFormat } from './splatFormats';
import { raycastSplats, type SplatIndex } from './splatIndex';
import { boxToLocal, resolvePivot, rotate3, screenRadius, sphereInView, splatModelMatrix, upAxisMatrix, type SplatPivot, type SplatUpAxis } from './splatPlacement';
import type { SplatLoadMessage, SplatLoadRequest, SplatLoadResult, SplatWorkerInput } from './splat.worker';

/** Where a splat layer stands and how it is turned and sized. Angles in degrees, lengths in meters. */
export interface SplatPlacement {
  /** Degrees east / north (WGS84). */
  longitude: number;
  latitude: number;
  /** Meters above `heightReference`. */
  height: number;
  /**
   * What `height` is measured from: the WGS84 ellipsoid, or the ground under the position
   * (`viewer.surfaceHeight`: terrain, or 3D Tiles without the globe), followed as it loads.
   */
  heightReference: 'ellipsoid' | 'ground';
  /** Degrees clockwise from north. */
  heading: number;
  /** Degrees about the east axis (positive lifts the north side). */
  pitch: number;
  /** Degrees about the north axis (positive lifts the west side). */
  roll: number;
  /** Meters per unit of the file (trained scenes have no real-world scale unless aligned). */
  scale: number;
}

export interface SplatLayerOptions {
  /** File to load (`.ply`, `.splat`, `.spz`); or pass the bytes as `data`. */
  url?: string;
  /** The file's bytes (a dropped file); the buffer is handed to the Worker and detached. */
  data?: ArrayBuffer;
  /** Format when neither the content nor the name tells (`.splat` has no magic number). */
  format?: SplatFormat;
  name?: string;
  /** Request headers and credentials mode for `url`. */
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  /** Where the pivot goes: degrees, and meters above `heightReference`. */
  position: { longitude: number; latitude: number; height?: number };
  /** Default: `'ground'` when `position.height` is omitted, else `'ellipsoid'`. */
  heightReference?: 'ellipsoid' | 'ground';
  /** Degrees clockwise from north (default 0). */
  heading?: number;
  /** Degrees (default 0); see `SplatPlacement`. */
  pitch?: number;
  roll?: number;
  /** Meters per file unit (default 1). */
  scale?: number;
  /** Which way is up in the file (default `'-y'`, the 3DGS / COLMAP convention). */
  upAxis?: SplatUpAxis;
  /** The point of the scene put on `position` (default `'bottom'`). */
  pivot?: SplatPivot;
  /** 0..1 (default 1). */
  opacity?: number;
  /** Multiplies the colors in linear light (default 1). */
  brightness?: number;
  /**
   * Most splats to keep; the least important ones (small and transparent) are dropped while
   * loading. Default from the GPU tier (`viewer.gpu.splats`), lower on the WebGL backend.
   */
  maxSplats?: number;
  /** Highest spherical harmonics degree to keep, 0–3 (default from the GPU tier). */
  maxShDegree?: number;
  /** Show only the splats inside a box or sphere (see `SplatLayer.crop`). */
  crop?: SplatCrop | null;
  /**
   * The layer is not drawn while the scene is smaller than this on screen (radius in
   * pixels, default 3) and fades in up to twice that size. 0 always draws it.
   */
  minScreenSize?: number;
  /** Fade-in after loading, milliseconds (default 400; 0 shows it at once). */
  fadeDuration?: number;
  /** Stay visible inside buildings (default false: hidden with the 3D Tiles while an indoor level is entered). */
  showIndoors?: boolean;
  /** Take part in picking: interaction events, zoom to cursor, orbit pivot (default true). */
  pickable?: boolean;
  /** Share of splats ignored on either side of each axis when measuring the scene (default 0.01; see `SplatBounds`). */
  boundsTrim?: number;
}

/** Facts about the loaded file. */
export interface SplatLayerStats {
  format: SplatFormat;
  /** Splats and spherical harmonics degree in the file. */
  sourceCount: number;
  sourceShDegree: number;
  /** Splats loaded (within the budget) and drawn (after `crop`), and the degree kept. */
  loadedCount: number;
  count: number;
  shDegree: SplatShDegree;
  fileBytes: number;
  /** Decode, budget and index time in the Worker, ms. */
  decodeMs: number;
}

export interface SplatLayerEvents extends Record<string, unknown> {
  /** The file is decoded and on its way to the GPU. `sphere`: the scene's bounds in world (ECEF) space. */
  ready: { sphere: Sphere; stats: SplatLayerStats };
  /** Loading failed. `error` is a `TerraViewError` (`splat-load-failed`, `splat-invalid`, `splat-format-unsupported`). */
  error: { message: string; error: Error };
  /** Download progress: bytes so far and in total (0 when the server does not say). */
  progress: { loaded: number; total: number };
  /** Something to draw changed: loaded, `visible`, `opacity`, `brightness`, `crop`, placement. */
  change: void;
  /** The layer moved (`setPlacement`, or the ground under it became known). */
  moved: void;
}

/** A pick on a splat layer. */
export interface SplatHit {
  layer: SplatLayer;
  /** World (ECEF) position. */
  point: Vector3;
  /** Meters from the ray origin. */
  distance: number;
  /** Index of the splat among those loaded (the same whatever the `crop`). */
  index: number;
}

/** What a layer needs from its viewer. */
export interface SplatLayerHost {
  ellipsoid: Ellipsoid;
  quality: SplatQuality;
  /** WebGPU backend (compute sort); false on the WebGL fallback (CPU sort). */
  webgpu: boolean;
  /** Reliable ground height at a position (radians), meters above the ellipsoid; null while unknown. */
  groundHeight(longitude: number, latitude: number): number | null;
  flyToSphere(sphere: Sphere, heading?: number, pitch?: number, duration?: number): Promise<void>;
}

/** The splat sort's depth range spans the core bounds times this: stray splats beyond share the last bins. */
const SORT_RANGE_SCALE = 1.25;
const DEFAULT_MIN_SCREEN_SIZE = 3;
const WEBGL_MAX_SPLATS = 600_000;

let nextId = 1;
const _matrix = new Matrix4();
const _enu = new Matrix4();
const _inverse = new Matrix4();
const _origin = new Vector3();
const _direction = new Vector3();
const _center = new Vector3();

/**
 * A Gaussian splat scene on the globe, returned by `viewer.addSplats(options)`. The file
 * loads in the background: wait for the `ready` event (or check `ready` / `error`) before
 * using `stats`, `boundingSphere`, `localBounds` or `flyTo()`. Remove it with
 * `viewer.removeSplats(layer)`, which also frees its video memory.
 */
export class SplatLayer {
  readonly id = nextId++;
  readonly name: string;
  readonly events = new EventEmitter<SplatLayerEvents>();
  /** @advanced Holds the splat mesh; its matrix is the layer's placement (ECEF, float64). */
  readonly group = new Group();
  /** The file is decoded and the scene is in the view (drawn when `active`). */
  ready = false;
  /** Message of the load failure (see the `error` event), null otherwise. */
  error: string | null = null;
  /** Download progress 0..1 (1 once decoded; 0 while the size is unknown). */
  progress = 0;
  /** Facts about the file, null until `ready`. */
  stats: SplatLayerStats | null = null;
  /** Bounds of the scene in world (ECEF) space, without stray splats (valid once `ready`). */
  readonly boundingSphere = new Sphere();
  readonly showIndoors: boolean;
  pickable: boolean;
  /** See `SplatLayerOptions.minScreenSize`. */
  minScreenSize: number;

  private readonly host: SplatLayerHost;
  private readonly _placement: SplatPlacement;
  private _upAxis: SplatUpAxis;
  private readonly pivotOption: SplatPivot;
  /** Pivot in file coordinates (fixed when the file is loaded, so cropping does not move the scene). */
  private pivot: [number, number, number] = [0, 0, 0];
  private worker: Worker | null = null;
  /** Splats as loaded (within the budget) with their picking hierarchy, and what is drawn of them (`crop`). */
  private loaded: SplatData | null = null;
  private index: SplatIndex | null = null;
  private drawn: SplatData | null = null;
  /** Per loaded splat: 1 when it is drawn. Null without a crop. */
  private cropMask: Uint8Array | null = null;
  private bounds: SplatBounds | null = null;
  private mesh: GaussianSplat | null = null;
  private _crop: SplatCrop | null;
  private _visible = true;
  private _suppressed = false;
  private _opacity: number;
  /** Ground height in use for `heightReference: 'ground'` (meters above the ellipsoid; 0 until known). */
  private ground = 0;
  private fade = 1;
  private readonly fadeDuration: number;
  private screenFade = 1;
  /** Full bounds (all splats) in file coordinates: center and radius, for view culling. */
  private readonly fullCenter = new Vector3();
  private fullRadius = 0;
  /** Core bounds in file coordinates. */
  private readonly coreCenter = new Vector3();
  private coreRadius = 0;
  private readonly opacityUniform = uniform(1);
  private readonly brightnessUniform = uniform(1);
  private disposed = false;

  /** @internal Use `viewer.addSplats(options)`. */
  constructor(options: SplatLayerOptions, host: SplatLayerHost) {
    // Plain JavaScript hosts: fail here with a reason rather than in the Worker or with NaN matrices.
    const position = options?.position;
    if (!position || !Number.isFinite(position.longitude) || !Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90) {
      throw new TerraViewError('option-invalid', 'SplatLayerOptions.position must have longitude and latitude in degrees', { option: 'position', expected: '{ longitude, latitude, height? }' });
    }
    if (!options.url && !(options.data instanceof ArrayBuffer)) {
      throw new TerraViewError('option-invalid', 'SplatLayerOptions needs a url or data (ArrayBuffer)', { option: 'url', expected: 'a URL, or data: ArrayBuffer' });
    }
    this.host = host;
    this.name = options.name ?? (options.url ? decodeURIComponent(new URL(options.url, location.href).pathname.split('/').pop() ?? '') : '');
    this._upAxis = options.upAxis ?? '-y';
    this.pivotOption = options.pivot ?? 'bottom';
    this.showIndoors = options.showIndoors ?? false;
    this.pickable = options.pickable ?? true;
    this.minScreenSize = options.minScreenSize ?? DEFAULT_MIN_SCREEN_SIZE;
    this.fadeDuration = options.fadeDuration ?? 400;
    this._crop = options.crop ?? null;
    this._opacity = clamp(options.opacity ?? 1, 0, 1);
    this.brightnessUniform.value = Math.max(0, options.brightness ?? 1);
    this._placement = {
      longitude: options.position.longitude,
      latitude: options.position.latitude,
      height: options.position.height ?? 0,
      heightReference: options.heightReference ?? (options.position.height === undefined ? 'ground' : 'ellipsoid'),
      heading: options.heading ?? 0,
      pitch: options.pitch ?? 0,
      roll: options.roll ?? 0,
      scale: options.scale ?? 1,
    };
    this.group.name = `SplatLayer:${this.name}`;
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.load(options);
  }

  // ---------------------------------------------------------------------------
  // Loading

  private load(options: SplatLayerOptions): void {
    const quality = this.host.quality;
    const tierMax = this.host.webgpu ? quality.maxSplats : Math.min(quality.maxSplats, WEBGL_MAX_SPLATS);
    const request: SplatLoadRequest = {
      url: options.data ? undefined : new URL(options.url!, location.href).href,
      bytes: options.data,
      name: options.name ?? options.url ?? '',
      format: options.format,
      headers: options.headers,
      credentials: options.credentials,
      maxSplats: Math.max(1, Math.floor(options.maxSplats ?? tierMax)),
      maxShDegree: clamp(Math.floor(options.maxShDegree ?? quality.maxShDegree), 0, 3),
      boundsTrim: options.boundsTrim ?? 0.01,
    };
    const worker = new Worker(new URL('./splat.worker.ts', import.meta.url), { type: 'module', name: 'splats' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<SplatLoadMessage>) => {
      const message = event.data;
      if (message.type === 'progress') {
        this.progress = message.total > 0 ? Math.min(1, message.loaded / message.total) : 0;
        this.events.emit('progress', { loaded: message.loaded, total: message.total });
        return;
      }
      if (message.type === 'zstd') {
        // SPZ 4: the decoder is three.js's, which Workers must not import.
        const answer = (input: SplatWorkerInput, transfer: Transferable[] = []) => this.worker === worker && worker.postMessage(input, transfer);
        decompressZstd(message.bytes, message.size).then(
          (bytes) => answer({ zstd: message.id, bytes }, [bytes.buffer]),
          (e: unknown) => answer({ zstd: message.id, bytes: null, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      this.closeWorker();
      if (this.disposed) return;
      if (message.type === 'done') this.adopt(message.result);
      else {
        const code = message.code as TerraViewErrorCode | null;
        this.fail(code ? new TerraViewError(code, message.message, message.details) : new TerraViewError('splat-load-failed', message.message, { url: request.url ?? '', reason: message.message }));
      }
    };
    worker.onerror = (event) => {
      this.closeWorker();
      if (!this.disposed) this.fail(new TerraViewError('splat-load-failed', `Splat worker failed: ${event.message}`, { url: request.url ?? '', reason: event.message || 'worker error' }));
    };
    worker.postMessage(request, options.data ? [options.data] : []);
  }

  private closeWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private fail(error: TerraViewError): void {
    this.error = error.message;
    this.events.emit('error', { message: error.message, error });
  }

  private adopt(result: SplatLoadResult): void {
    const { data, bounds } = result;
    this.loaded = data;
    this.bounds = bounds;
    this.pivot = resolvePivot(this.pivotOption, bounds, this._upAxis);
    this.stats = {
      format: result.format,
      sourceCount: result.sourceCount,
      sourceShDegree: result.sourceShDegree,
      loadedCount: data.count,
      count: data.count,
      shDegree: data.shDegree,
      fileBytes: result.fileBytes,
      decodeMs: result.decodeMs,
    };
    this.progress = 1;
    this.index = result.index;
    this.rebuild();
    this.fade = this.fadeDuration > 0 ? 0 : 1;
    this.ready = true;
    this.events.emit('ready', { sphere: this.boundingSphere.clone(), stats: this.stats });
    this.events.emit('change', undefined);
  }

  /** Builds the mesh from the loaded splats and the crop. */
  private rebuild(): void {
    const loaded = this.loaded!;
    const bounds = this.bounds!;
    this.disposeMesh();
    let active = loaded;
    this.cropMask = null;
    if (this._crop) {
      const kept = cropSplats(loaded, this._crop, upAxisMatrix(this._upAxis), this.pivot);
      active = selectSplats(loaded, kept);
      // Picking keeps using the hierarchy of the loaded splats, skipping what the crop hides.
      this.cropMask = new Uint8Array(loaded.count);
      for (let k = 0; k < kept.length; k++) this.cropMask[kept[k]] = 1;
    }
    this.drawn = active;
    this.stats!.count = active.count;
    // The scene's extent stays that of the file: a crop must not move the pivot or the fade distances.
    this.fullCenter.set((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2);
    this.fullRadius = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2;
    this.coreCenter.set((bounds.coreMin[0] + bounds.coreMax[0]) / 2, (bounds.coreMin[1] + bounds.coreMax[1]) / 2, (bounds.coreMin[2] + bounds.coreMax[2]) / 2);
    this.coreRadius = Math.max(1e-6, Math.hypot(bounds.coreMax[0] - bounds.coreMin[0], bounds.coreMax[1] - bounds.coreMin[1], bounds.coreMax[2] - bounds.coreMin[2]) / 2);
    if (active.count > 0) {
      const sh: Record<string, Uint32Array> = {};
      if (active.sh1) sh.sh1 = active.sh1;
      if (active.sh2) sh.sh2 = active.sh2;
      if (active.sh3) sh.sh3 = active.sh3;
      const geometry = createGaussianSplatGeometry(active.centers, active.covariances, active.colors, sh);
      const mesh = new GaussianSplat(geometry);
      mesh.name = `Splats:${this.name}`;
      // The depth range of the sort follows this sphere: the core of the scene, so that far
      // stray splats do not spread the sort's bins thin. View culling is done per layer in `update`.
      mesh.boundingSphere = new Sphere(this.coreCenter.clone(), this.coreRadius * SORT_RANGE_SCALE);
      mesh.frustumCulled = false;
      // Picks go through `SplatLayer.raycast`; a ray cast through the scene must not loop over every splat.
      mesh.raycast = () => undefined;
      // Before other transparent surfaces (clouds, faded rooms): those blend over the splats.
      mesh.renderOrder = -1;
      const base = mesh.material.colorNode as TSLNode;
      const opacity = this.opacityUniform;
      const brightness = this.brightnessUniform;
      // Splat colors are display values; the scene pass is linear and tone mapped afterwards.
      mesh.material.colorNode = Fn(() => {
        const color = vec4(base).toVar();
        const linear: TSLNode = sRGBTransferEOTF(color.rgb);
        return vec4(linear.mul(brightness), color.a.mul(opacity));
      })();
      this.mesh = mesh;
      this.group.add(mesh);
    }
    this.updateMatrix();
    this.applyVisibility();
  }

  // ---------------------------------------------------------------------------
  // Placement

  /** Current placement (a copy). */
  get placement(): SplatPlacement {
    return { ...this._placement };
  }

  /** Moves, turns or resizes the layer; fields left out keep their value. */
  setPlacement(placement: Partial<SplatPlacement>): void {
    const p = this._placement;
    const previous = `${p.longitude},${p.latitude},${p.heightReference}`;
    Object.assign(p, placement);
    p.scale = Math.max(1e-6, p.scale);
    // Somewhere else: the ground there is not known yet (the old value stays until it is).
    if (`${p.longitude},${p.latitude},${p.heightReference}` !== previous) this.followGround();
    this.updateMatrix();
    this.events.emit('moved', undefined);
    this.events.emit('change', undefined);
  }

  /** Which way is up in the file (`SplatLayerOptions.upAxis`). */
  get upAxis(): SplatUpAxis {
    return this._upAxis;
  }

  /** Turns the scene to another axis convention; the pivot is taken again for it (a crop is applied again). */
  set upAxis(upAxis: SplatUpAxis) {
    if (upAxis === this._upAxis) return;
    this._upAxis = upAxis;
    if (this.bounds) {
      this.pivot = resolvePivot(this.pivotOption, this.bounds, upAxis);
      if (this._crop) this.rebuild();
      else this.updateMatrix();
    }
    this.events.emit('moved', undefined);
    this.events.emit('change', undefined);
  }

  /** Height of the pivot above the ellipsoid, meters. */
  get ellipsoidHeight(): number {
    const p = this._placement;
    return p.heightReference === 'ground' ? this.ground + p.height : p.height;
  }

  /** Takes the ground height under the layer when it is known; true when it changed. */
  private followGround(): boolean {
    const p = this._placement;
    if (p.heightReference !== 'ground') return false;
    const g = this.host.groundHeight(p.longitude * DEG2RAD, p.latitude * DEG2RAD);
    if (g === null || Math.abs(g - this.ground) < 0.01) return false;
    this.ground = g;
    return true;
  }

  private updateMatrix(): void {
    const p = this._placement;
    const anchor = this.host.ellipsoid.cartographicToCartesian(p.longitude * DEG2RAD, p.latitude * DEG2RAD, this.ellipsoidHeight, _center);
    this.host.ellipsoid.eastNorthUpToFixedFrame(anchor, _enu);
    _matrix.fromArray(splatModelMatrix({ upAxis: this._upAxis, pivot: this.pivot, heading: p.heading, pitch: p.pitch, roll: p.roll, scale: p.scale }));
    this.group.matrix.multiplyMatrices(_enu, _matrix);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
    this.boundingSphere.center.copy(this.coreCenter).applyMatrix4(this.group.matrix);
    this.boundingSphere.radius = this.coreRadius * p.scale;
  }

  /**
   * A point of the layer's local frame in world (ECEF) space. The local frame is what `crop`
   * uses: X east, Y north, Z up before heading / pitch / roll, in file units, origin at the pivot.
   */
  localToWorld(local: readonly [number, number, number], target = new Vector3()): Vector3 {
    const m = upAxisMatrix(this._upAxis);
    // Back to file coordinates (the inverse of the axis rotation), then through the model matrix.
    const x = m[0] * local[0] + m[3] * local[1] + m[6] * local[2] + this.pivot[0];
    const y = m[1] * local[0] + m[4] * local[1] + m[7] * local[2] + this.pivot[1];
    const z = m[2] * local[0] + m[5] * local[1] + m[8] * local[2] + this.pivot[2];
    return target.set(x, y, z).applyMatrix4(this.group.matrix);
  }

  /**
   * The scene's box in the local frame (see `localToWorld`), without stray splats: a starting
   * point for a crop. Null until `ready`.
   */
  get localBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!this.bounds) return null;
    const box = boxToLocal(this.bounds.coreMin, this.bounds.coreMax, this._upAxis);
    const p = rotate3(upAxisMatrix(this._upAxis), this.pivot);
    return { min: [box.min[0] - p[0], box.min[1] - p[1], box.min[2] - p[2]], max: [box.max[0] - p[0], box.max[1] - p[1], box.max[2] - p[2]] };
  }

  // ---------------------------------------------------------------------------
  // Display

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    if (v === this._visible) return;
    this._visible = v;
    this.applyVisibility();
    this.events.emit('change', undefined);
  }

  /** @internal Hidden by the viewer (inside a building, outside a local scene), whatever `visible` says. */
  get suppressed(): boolean {
    return this._suppressed;
  }

  set suppressed(v: boolean) {
    if (v === this._suppressed) return;
    this._suppressed = v;
    this.applyVisibility();
    this.events.emit('change', undefined);
  }

  /** Drawn right now: ready, visible, not suppressed and large enough on screen. */
  get active(): boolean {
    return this.group.visible;
  }

  get opacity(): number {
    return this._opacity;
  }

  /** 0..1. */
  set opacity(v: number) {
    const o = clamp(v, 0, 1);
    if (o === this._opacity) return;
    this._opacity = o;
    this.applyVisibility();
    this.events.emit('change', undefined);
  }

  get brightness(): number {
    return this.brightnessUniform.value;
  }

  /** Multiplies the colors in linear light (1 = as stored). */
  set brightness(v: number) {
    const b = Math.max(0, v);
    if (b === this.brightnessUniform.value) return;
    this.brightnessUniform.value = b;
    this.events.emit('change', undefined);
  }

  get crop(): SplatCrop | null {
    return this._crop;
  }

  /**
   * Shows only the splats whose center is inside a box or sphere given in the layer's local
   * frame (`localToWorld`; `localBounds` is the scene's own box); null shows all. Applied on
   * the CPU to the loaded splats and uploaded again (tens of milliseconds per million
   * splats, plus the upload): set it when a control is released, not while it is dragged.
   */
  set crop(crop: SplatCrop | null) {
    this._crop = crop;
    if (!this.loaded) return;
    this.rebuild();
    this.events.emit('change', undefined);
  }

  /** Estimated video memory of the splats drawn, bytes. */
  get gpuBytes(): number {
    return this.mesh && this.drawn ? splatGpuBytes(this.drawn.count, this.drawn.shDegree, this.host.webgpu) : 0;
  }

  private applyVisibility(): void {
    const shown = this.mesh !== null && this._visible && !this._suppressed && this._opacity > 0 && this.screenFade > 0;
    this.group.visible = shown;
    this.opacityUniform.value = this._opacity * this.fade * this.screenFade;
  }

  /**
   * @internal Per frame: follows the ground, advances the fade-in and decides whether the layer
   * is in view and large enough to draw. Returns true when the picture changes because of it.
   */
  update(dt: number, camera: PerspectiveCamera, viewportHeight: number): boolean {
    if (!this.mesh) return false;
    let changed = false;
    if (this.followGround()) {
      this.updateMatrix();
      this.events.emit('moved', undefined);
      changed = true;
    }
    if (this.fade < 1 && this._visible && !this._suppressed) {
      this.fade = Math.min(1, this.fade + (dt * 1000) / Math.max(1, this.fadeDuration));
      changed = true;
    }
    // In view and large enough on screen? (The camera moving is a change of its own.)
    const scale = this._placement.scale;
    _center.copy(this.fullCenter).applyMatrix4(this.group.matrix).applyMatrix4(camera.matrixWorldInverse);
    const radius = this.fullRadius * scale;
    const tanY = Math.tan((camera.fov * DEG2RAD) / 2) / camera.zoom;
    const inView = sphereInView(_center.x, _center.y, _center.z, radius, tanY * camera.aspect, tanY);
    let screenFade = 0;
    if (inView) {
      const pixels = screenRadius(this.boundingSphere.radius, camera.position.distanceTo(this.boundingSphere.center), camera.fov / camera.zoom, viewportHeight);
      screenFade = this.minScreenSize > 0 ? smoothstep(this.minScreenSize, this.minScreenSize * 2, pixels) : 1;
    }
    const before = this.opacityUniform.value;
    const shownBefore = this.group.visible;
    this.screenFade = screenFade;
    this.applyVisibility();
    return changed || before !== this.opacityUniform.value || shownBefore !== this.group.visible;
  }

  /** @internal The fade-in is running. */
  get animating(): boolean {
    return this.mesh !== null && this.fade < 1 && this._visible && !this._suppressed;
  }

  // ---------------------------------------------------------------------------
  // Picking

  /**
   * First surface of the splats on a world-space ray: where the opacity gathered along the
   * ray reaches `minOpacity` (default 0.5), so thin haze in front of a surface is passed
   * through. Null when the layer is not drawn, not `pickable`, or the ray misses.
   */
  raycast(ray: Ray, options: { minOpacity?: number; maxDistance?: number } = {}): SplatHit | null {
    if (!this.pickable || !this.group.visible || !this.loaded || !this.index) return null;
    const scale = this._placement.scale;
    // Cheap miss: the ray passes the whole scene by.
    _center.copy(this.fullCenter).applyMatrix4(this.group.matrix);
    if (ray.distanceSqToPoint(_center) > (this.fullRadius * scale) ** 2) return null;
    _inverse.copy(this.group.matrix).invert();
    _origin.copy(ray.origin).applyMatrix4(_inverse);
    // The model matrix scales uniformly: distances along the ray scale with it.
    _direction.copy(ray.direction).transformDirection(_inverse);
    const maxDistance = options.maxDistance === undefined ? undefined : options.maxDistance / scale;
    const hit = raycastSplats(this.loaded, this.index, [_origin.x, _origin.y, _origin.z], [_direction.x, _direction.y, _direction.z], { minOpacity: options.minOpacity, maxDistance, mask: this.cropMask });
    if (!hit) return null;
    const distance = hit.distance * scale;
    return { layer: this, point: ray.at(distance, new Vector3()), distance, index: hit.index };
  }

  /** Flies the camera to frame the scene (looking from the south-east unless a heading is given). */
  flyTo(options: { heading?: number; pitch?: number; duration?: number } = {}): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return this.host.flyToSphere(this.boundingSphere, options.heading, options.pitch, options.duration);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  private disposeMesh(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    this.mesh = null;
    this.group.remove(mesh);
    disposeGaussianSplat(mesh);
  }

  /** @internal Use `viewer.removeSplats(layer)`. */
  dispose(): void {
    this.disposed = true;
    this.closeWorker();
    this.disposeMesh();
    this.group.removeFromParent();
    this.loaded = null;
    this.drawn = null;
    this.index = null;
    this.cropMask = null;
    this.ready = false;
  }
}

/** The Zstandard decoder shipped with three.js (a small WebAssembly module), loaded on first use and shared. */
let zstdDecoder: Promise<{ decode(data: Uint8Array, size: number): Uint8Array }> | null = null;

async function decompressZstd(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  zstdDecoder ??= import('three/addons/libs/zstddec.module.js').then(async ({ ZSTDDecoder }) => {
    const decoder = new ZSTDDecoder();
    await decoder.init();
    return decoder;
  });
  // A copy: the decoder returns a view into its WebAssembly memory.
  return (await zstdDecoder).decode(bytes, size).slice();
}

/**
 * Releases what a three.js `GaussianSplat` holds on the GPU. The class has no `dispose()`:
 * its storage buffers (splat data, sort order and keys; on the WebGL backend each also has
 * a texture) and compute pipelines live in private fields, freed here by walking them for
 * storage buffer nodes, attributes and compute nodes.
 */
function disposeGaussianSplat(mesh: GaussianSplat): void {
  const internals = mesh as unknown as Record<string, unknown>;
  const seen = new Set<unknown>();
  const release = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const v = value as { isBufferAttribute?: boolean; isStorageBufferNode?: boolean; isComputeNode?: boolean; value?: unknown; pbo?: { dispose(): void }; dispose?: () => void };
    if (v.isStorageBufferNode) release(v.value);
    else if (v.isBufferAttribute || v.isComputeNode) {
      // The WebGL backend keeps a storage buffer in a texture next to the attribute.
      v.pbo?.dispose();
      v.dispose?.();
    }
  };
  release(internals._sphericalHarmonicsComputeNode);
  for (const holder of [internals._buffers, internals._sort]) {
    if (holder && typeof holder === 'object') for (const value of Object.values(holder)) release(value);
  }
  mesh.geometry.dispose();
  mesh.splatGeometry.dispose();
  mesh.material.dispose();
}
