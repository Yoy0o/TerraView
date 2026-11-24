/**
 * Volumetric clouds near the ground (`viewer.clouds.volumetric`): a linear-stage post effect
 * that ray-marches a layer of cumulus between two spheres around the camera's local center of
 * curvature, at a reduced resolution, and composes it over the scene with its depth.
 *
 * Technique (Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn", 2015;
 * Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite", 2016), in
 * fragment passes (TSL, so WebGPU and the WebGL 2 fallback both run it):
 *
 * 1. Weather (a 512² map around the camera, drawn again only when the camera, the wind or the
 *    cloud settings moved it): where clouds are and how tall, from a cell field and clusters of
 *    tileable noise, scaled by the cloud shell's own density (`CloudLayer.densityNode`) so the
 *    clouds seen from space are where they are seen from below.
 * 2. Cloud shadows (lighting on): sunlight transmittance through the layer, orthographic along
 *    the sun around the camera, read by every receiver (`lighting/cloudShadows`).
 * 3. Trace (after the scene pass, a quarter of the history's pixels per frame, 2 × 2
 *    interleaved): march from the camera to the scene depth through the layer, striding over empty
 *    space and stepping by the pixel footprint inside clouds (noise octaves finer than the
 *    footprint fade out: the noise volume has no mipmaps), light march toward the sun with a
 *    multiple-scattering approximation, sky light by height; the aerial perspective of the
 *    atmosphere at the clouds' mean distance.
 * 4. Resolve: the history (half resolution at most) keeps the pixels it already had,
 *    reprojected with the clouds' distance, the camera's motion and the wind (the shell's drift
 *    counts as wind), clamped to the new samples around them; this frame's pixels blend in.
 *    Pixels whose scene depth no longer matches drop their history.
 * 5. Compose (the effect's `build`): the history upsampled with scene-depth weights, so cloud
 *    edges stay off buildings in front of them.
 *
 * The node graphs of these passes are built in `cloudNodes.ts`; this file owns the render
 * targets, the frame state (wind, weather anchor, reprojection pose) and decides what to draw.
 *
 * Precision: positions are relative to the camera (or the map centers) in meters; noise
 * coordinates of those origins are taken modulo their period in float64 on the CPU, heights use
 * the cancellation-free sphere formulas of `volumetricCloudMath`. Nothing ECEF-sized reaches the
 * GPU. All uniforms belong to this instance (no state shared between viewers) except the cloud
 * shadow receivers', which each viewer binds before it renders.
 */
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Matrix4,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  RenderTarget,
  RepeatWrapping,
  UnsignedByteType,
  Vector3,
  type DepthTexture,
  type PerspectiveCamera,
  type TextureDataType,
} from 'three';
import { texture } from 'three/tsl';
import { NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { shIrradiance, type Vec3 } from '../atmosphere/atmosphereModel';
import type { Ellipsoid } from '../core/Ellipsoid';
import { smoothstep as smoothstepNum } from '../core/math';
import type { TSLNode } from '../core/tsl';
import { bindCloudShadows, type CloudShadowBinding } from '../lighting/cloudShadows';
import type { PostEffect, PostFrame, PostInputs } from '../post/PostPipeline';
import type { CloudLayer } from './CloudLayer';
import {
  composeNode,
  cloudShadowNode,
  createCloudUniforms,
  makeOrigin,
  resolveNodes,
  traceNodes,
  weatherBakeNode,
  WEATHER_SIZE,
  type CloudShaderInputs,
  type Origin,
} from './cloudNodes';
import {
  CLOUD_NOISE_SIZE,
  CLOUD_SCALES,
  CLOUD_SHADOW_RANGE,
  INTERLEAVE_SLOTS,
  WEATHER_SLACK,
  historySize,
  localEarthRadius,
  periodicFraction,
  stepGrowth,
  volumetricFade,
  weatherExtent,
} from './volumetricCloudMath';

/** Volumetric cloud settings of the GPU tier (`GpuProfile.clouds`). */
export interface VolumetricCloudQuality {
  historyPixels: number;
  steps: number;
  lightSteps: number;
  shadowMapSize: number;
}

/** What a frame of clouds needs to know (`VolumetricClouds.update`). */
export interface VolumetricCloudFrame {
  /** Seconds since the last frame. */
  dt: number;
  camera: PerspectiveCamera;
  /** Camera height above the ellipsoid, meters. */
  cameraHeight: number;
  /** Real sun lighting (`viewer.lighting`); otherwise a studio light from overhead. */
  lighting: boolean;
  /** Unit vector toward the sun (world). */
  sun: Vector3;
  /** Sunlight and sky light (SH, radiance) where the view is, while lighting is on. */
  sunColor: Vec3 | null;
  sh: readonly Vec3[] | null;
  /** Nothing to draw clouds over (local scene, studio backdrop). */
  suppressed: boolean;
  /** Drawing buffer size, pixels. */
  width: number;
  height: number;
}

/** Evolution of the shapes, meters of noise travel per meter of wind. */
const EVOLUTION_RATE = 0.2;
/** Studio light (lighting off): white sun from overhead, bluish sky. */
const STUDIO_SUN: Vec3 = [1, 0.98, 0.95];
const STUDIO_AMBIENT_TOP: Vec3 = [0.3, 0.36, 0.46];
const STUDIO_AMBIENT_BOTTOM: Vec3 = [0.15, 0.16, 0.18];
/** Light the clouds keep at night (moon and city glow, roughly). */
const NIGHT_AMBIENT: Vec3 = [0.003, 0.0035, 0.005];

// -----------------------------------------------------------------------------
// The noise volume: built once per page in a Worker, shared by every viewer (read only).

let noiseData: Uint8Array | null = null;
let noisePromise: Promise<Uint8Array> | null = null;
let noiseWorker: Worker | null = null;
let noiseUsers = 0;

function requestNoise(): Promise<Uint8Array> {
  noiseUsers++;
  if (noiseData) return Promise.resolve(noiseData);
  if (noisePromise) return noisePromise;
  // No main-thread fallback: without Workers the globe does not build its tiles either.
  noisePromise = new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL('./cloudNoise.worker.ts', import.meta.url), { type: 'module', name: 'cloud-noise' });
    noiseWorker = worker;
    worker.onmessage = (e: MessageEvent<{ data: Uint8Array }>) => {
      worker.terminate();
      noiseWorker = null;
      noiseData = e.data.data;
      resolve(noiseData);
    };
    worker.onerror = (e) => {
      worker.terminate();
      noiseWorker = null;
      noisePromise = null;
      reject(e);
    };
    worker.postMessage({ size: CLOUD_NOISE_SIZE });
  });
  return noisePromise;
}

function releaseNoise(): void {
  noiseUsers = Math.max(0, noiseUsers - 1);
  // The last viewer is gone while the noise is still being built: stop the Worker.
  if (noiseUsers === 0 && noiseWorker) {
    noiseWorker.terminate();
    noiseWorker = null;
    noisePromise = null;
  }
}

// -----------------------------------------------------------------------------

function colorTarget(width: number, height: number, count: number, type: TextureDataType, filter: typeof LinearFilter | typeof NearestFilter): RenderTarget {
  const rt = new RenderTarget(width, height, {
    count,
    type,
    format: RGBAFormat,
    depthBuffer: false,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    generateMipmaps: false,
  });
  return rt;
}

function quadMaterial(name: string): NodeMaterial {
  const m = new NodeMaterial();
  m.name = name;
  m.blending = NoBlending;
  m.depthTest = false;
  m.depthWrite = false;
  m.toneMapped = false;
  return m;
}

interface Pose {
  position: Vector3;
  rotation: Matrix3;
  projection: Matrix4;
  forward: Vector3;
}

const _v = new Vector3();
const _v2 = new Vector3();

export class VolumetricClouds implements PostEffect {
  readonly name = 'volumetric-clouds';
  readonly stage = 'linear' as const;
  /** Before glow and the level transition: highlights stay on top, the transition dissolves the clouds too. */
  readonly order = -50;
  readonly graphVersion = 0;

  private readonly u = createCloudUniforms();
  private readonly camOrigin = makeOrigin();
  private readonly shadowOrigin = makeOrigin();

  private noise: Data3DTexture | null = null;
  private noiseRequested = false;
  private disposed = false;
  private visibility = 0;
  private shadowStrength = 0;

  private weather = colorTarget(WEATHER_SIZE, WEATHER_SIZE, 1, UnsignedByteType, LinearFilter);
  private shadowMap: RenderTarget;
  private trace = colorTarget(1, 1, 2, HalfFloatType, NearestFilter);
  private history = [colorTarget(2, 2, 2, HalfFloatType, LinearFilter), colorTarget(2, 2, 2, HalfFloatType, LinearFilter)];
  /** Index of the history written last. */
  private current = 0;

  private readonly depthNode: TSLNode;
  private readonly traceColor: TSLNode;
  private readonly traceMeta: TSLNode;
  private readonly prevColor: TSLNode;
  private readonly prevMeta: TSLNode;
  private readonly histColor: TSLNode;
  private readonly histMeta: TSLNode;
  private readonly weatherNode: TSLNode;

  private traceQuad: QuadMesh | null = null;
  private resolveQuad: QuadMesh | null = null;
  private bakeQuad: QuadMesh | null = null;
  private shadowQuad: QuadMesh | null = null;
  private bakeDensityVersion = -1;

  // Wind and evolution (float64, accumulated).
  private readonly windOffset = new Vector3();
  private readonly evolutionOffset = new Vector3();
  private readonly windAtDraw = new Vector3();
  private readonly windDir = new Vector3();
  // Weather anchor.
  private readonly anchor = new Vector3();
  private readonly anchorEast = new Vector3();
  private readonly anchorNorth = new Vector3();
  private readonly anchorUp = new Vector3();
  private readonly windAtBake = new Vector3();
  private baked = false;
  private bakePending = false;
  private bakeKey = '';
  /** The shell's drift last frame (radians), null before the first. */
  private lastDrift: number | null = null;
  private extent = 0;
  // Camera frame of the last update.
  private readonly east = new Vector3();
  private readonly north = new Vector3();
  private readonly up = new Vector3();
  private previous: Pose | null = null;
  private historyOk = false;
  private frameIndex = 0;
  private historyW = 0;
  private historyH = 0;
  private readonly shadowBinding: CloudShadowBinding;
  private readonly shadowMatrix = new Matrix4();
  private readonly shadowCenter = new Vector3();
  private readonly shadowUp = new Vector3();

  /** Called when the noise arrives (the viewer draws again). */
  onReady: (() => void) | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly clouds: CloudLayer,
    private readonly ellipsoid: Ellipsoid,
    private readonly quality: VolumetricCloudQuality,
  ) {
    this.shadowMap = colorTarget(quality.shadowMapSize, quality.shadowMapSize, 1, UnsignedByteType, LinearFilter);
    this.weather.texture.name = 'cloud weather';
    this.shadowMap.texture.name = 'cloud shadow map';
    this.depthNode = texture(this.trace.textures[0]);
    this.traceColor = texture(this.trace.textures[0]);
    this.traceMeta = texture(this.trace.textures[1]);
    this.prevColor = texture(this.history[1].textures[0]);
    this.prevMeta = texture(this.history[1].textures[1]);
    this.histColor = texture(this.history[0].textures[0]);
    this.histMeta = texture(this.history[0].textures[1]);
    this.weatherNode = texture(this.weather.texture);
    this.shadowBinding = { texture: this.shadowMap.texture, worldToMap: this.shadowMatrix, strength: 0, bottom: 0, top: 0 };
  }

  /** Whether the clouds take part in this frame (noise ready, layer visible, camera low enough). */
  get active(): boolean {
    return this.noise !== null && this.visibility > 0.002 && !this.disposed;
  }

  /** Volumetric clouds are drawn (also tells the viewer to keep the frame rate the wind needs). */
  get visible(): boolean {
    return this.active;
  }

  /** Cloud shadows are wanted by the settings (the sun light then runs the shared shadow node). */
  get wantsShadows(): boolean {
    const o = this.clouds.volumetricOptions;
    return this.clouds.visible && o.enabled && o.shadows;
  }

  /** GPU bytes of the noise, the maps and the history (nothing is allocated before the clouds first show). */
  get gpuBytes(): number {
    if (!this.noise) return 0;
    let bytes = CLOUD_NOISE_SIZE ** 3 * 4 + WEATHER_SIZE * WEATHER_SIZE * 4 + this.shadowMap.width * this.shadowMap.height * 4;
    bytes += this.trace.width * this.trace.height * 16;
    for (const h of this.history) bytes += h.width * h.height * 16;
    return bytes;
  }

  /**
   * CPU work of a frame, before anything is drawn: visibility, wind, the weather anchor and the
   * uniforms of the camera and of the shadow map.
   */
  update(f: VolumetricCloudFrame): void {
    if (this.disposed) return;
    const o = this.clouds.volumetricOptions;
    const wanted = this.clouds.visible && o.enabled && !f.suppressed;
    this.visibility = wanted ? volumetricFade(f.cameraHeight, o.fadeHeights) : 0;
    if (this.visibility > 0.002 && !this.noiseRequested) this.loadNoise();
    if (!this.active) {
      this.shadowStrength = 0;
      // Back from space later: the drift meanwhile is not wind of one frame.
      this.lastDrift = null;
      return;
    }
    const u = this.u;
    const cam = f.camera.position;
    const carto = this.ellipsoid.cartesianToCartographic(cam);
    if (!carto) return;
    const radii = this.ellipsoid.radii;
    const radius = localEarthRadius(carto.latitude, radii.x, radii.z);
    this.ellipsoid.eastNorthUp(cam, this.east, this.north, this.up);
    const dt = Number.isFinite(f.dt) ? Math.max(0, f.dt) : 0;

    // Wind toward the heading, and the slow evolution of the shapes (both float64).
    const heading = (o.windHeading * Math.PI) / 180;
    this.windDir.copy(this.east).multiplyScalar(Math.sin(heading)).addScaledVector(this.north, Math.cos(heading));
    this.windOffset.addScaledVector(this.windDir, o.windSpeed * dt);
    this.evolutionOffset.addScaledVector(this.up, o.windSpeed * EVOLUTION_RATE * dt);
    // The shell's drift (it only advances while the shell shows, high up) moves its clouds east
    // about the polar axis: the same motion here, as more wind under the camera. Cells, shapes,
    // the weather map's shell density and the reprojection then all move together.
    const drift = this.clouds.weatherState.drift;
    if (this.lastDrift !== null && drift !== this.lastDrift) {
      let d = drift - this.lastDrift;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      const nadir = this.ellipsoid.cartographicToCartesian(carto.longitude, carto.latitude, 0, _v);
      const c = Math.cos(d);
      const s = Math.sin(d);
      this.windOffset.x += nadir.x * c - nadir.y * s - nadir.x;
      this.windOffset.y += nadir.x * s + nadir.y * c - nadir.y;
    }
    this.lastDrift = drift;

    const bottom = o.bottom;
    const top = o.bottom + o.thickness;
    u.radius.value = radius;
    u.bottom.value = bottom;
    u.thickness.value = o.thickness;
    u.density.value = o.density;
    u.maxDistance.value = o.maxDistance;
    u.fade.value = this.visibility;
    u.shear.value.copy(this.windDir).multiplyScalar(o.thickness * 0.35);
    u.lightBase.value = o.thickness * 0.02;
    const minStep = Math.max(20, o.thickness / 90);
    u.minStep.value = minStep;
    u.growth.value = stepGrowth(this.quality.steps * 0.85, minStep, o.maxDistance);
    u.maxStep.value = o.thickness * 0.14;
    const tanY = Math.tan(((f.camera.fov * Math.PI) / 180) / 2) / (f.camera.zoom || 1);
    const size = historySize(f.width, f.height, this.quality.historyPixels);
    u.pixelAngle.value = (2 * tanY) / size.height;
    u.cone.value = u.pixelAngle.value * 1.5;

    // Light: the sun (or the studio light overhead), sky light by height.
    const sun = f.lighting ? f.sun : this.up;
    u.sun.value.copy(sun).normalize();
    if (f.lighting && f.sunColor) {
      u.sunColor.value.set(f.sunColor[0], f.sunColor[1], f.sunColor[2]);
      const sh = f.sh;
      const top3 = sh ? shIrradiance(sh, this.up.x, this.up.y, this.up.z) : [0, 0, 0];
      const low3 = sh ? shIrradiance(sh, -this.up.x, -this.up.y, -this.up.z) : [0, 0, 0];
      u.ambientTop.value.set(top3[0] / Math.PI + NIGHT_AMBIENT[0], top3[1] / Math.PI + NIGHT_AMBIENT[1], top3[2] / Math.PI + NIGHT_AMBIENT[2]);
      u.ambientBottom.value.set(low3[0] / Math.PI + NIGHT_AMBIENT[0], low3[1] / Math.PI + NIGHT_AMBIENT[1], low3[2] / Math.PI + NIGHT_AMBIENT[2]);
    } else {
      u.sunColor.value.set(...STUDIO_SUN);
      u.ambientTop.value.set(...STUDIO_AMBIENT_TOP);
      u.ambientBottom.value.set(...STUDIO_AMBIENT_BOTTOM);
    }

    this.updateWeatherAnchor(cam, carto.longitude, carto.latitude, f.cameraHeight, o.maxDistance, bottom, top);
    this.setOrigin(this.camOrigin, cam, f.cameraHeight, radius, this.up);

    // Cloud shadows: lighting on, sun up.
    const sunUp = this.up.dot(f.sun);
    this.shadowStrength = f.lighting && o.shadows ? 0.9 * this.visibility * smoothstepNum(0.01, 0.12, sunUp) : 0;
    if (this.shadowStrength > 0) this.updateShadowFrame(carto.longitude, carto.latitude, radius, f.sun, bottom, top);
  }

  /**
   * GPU work before the scene pass: the weather map when it moved, the cloud shadow map, and
   * the binding of the shadow receivers (shared by the viewers on the page).
   */
  renderMaps(): void {
    if (!this.active || !this.traceQuad) {
      bindCloudShadows(null);
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    r.setMRT(null);
    try {
      if (this.clouds.densityVersion !== this.bakeDensityVersion) this.buildBake();
      if (this.bakePending) {
        r.setRenderTarget(this.weather);
        this.bakeQuad!.render(r);
        this.bakePending = false;
      }
      if (this.shadowStrength > 0) {
        r.setRenderTarget(this.shadowMap);
        this.shadowQuad!.render(r);
      }
    } finally {
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMRT);
    }
    this.bind();
  }

  /** Binds this viewer's cloud shadows to the shared receivers (before a render outside the frame loop too). */
  bind(): void {
    this.shadowBinding.strength = this.active ? this.shadowStrength : 0;
    bindCloudShadows(this.shadowBinding.strength > 0 ? this.shadowBinding : null);
  }

  prepare(frame: PostFrame): void {
    if (!this.traceQuad || !this.resolveQuad) return;
    const r = frame.renderer;
    const u = this.u;
    const cam = frame.camera;
    this.ensureTargets(frame.width, frame.height);
    this.depthNode.value = frame.depthTexture as DepthTexture;

    // This frame's camera (shifted while supersampling: its projection is used as it is).
    u.invProjection.value.copy(cam.projectionMatrixInverse);
    u.cameraRotation.value.setFromMatrix4(cam.matrixWorld);
    u.near.value = cam.near;
    u.far.value = cam.far;
    const slot = INTERLEAVE_SLOTS[this.frameIndex % INTERLEAVE_SLOTS.length];
    u.slot.value.set(slot[0], slot[1]);
    u.frame.value = this.frameIndex % 1024;

    // Reprojection from the previous drawn frame; a jump or a sharp turn starts over.
    const forward = _v.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const prev = this.previous;
    let valid = this.historyOk && prev !== null;
    if (prev) {
      const moved = prev.position.distanceTo(cam.position);
      const height = Math.max(this.camOrigin.height.value as number, 100);
      if (moved > Math.max(2000, height * 0.25) || prev.forward.dot(forward) < 0.75) valid = false;
      u.cameraDelta.value.subVectors(cam.position, prev.position);
      u.previousViewRotation.value.copy(prev.rotation).transpose();
      u.previousProjection.value.copy(prev.projection);
    }
    u.windDelta.value.subVectors(this.windOffset, this.windAtDraw);
    this.windAtDraw.copy(this.windOffset);
    u.historyValid.value = valid ? 1 : 0;

    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    r.setMRT(null);
    try {
      r.setRenderTarget(this.trace);
      this.traceQuad.render(r);
      const read = this.history[this.current];
      const write = this.history[1 - this.current];
      this.prevColor.value = read.textures[0];
      this.prevMeta.value = read.textures[1];
      r.setRenderTarget(write);
      this.resolveQuad.render(r);
      this.current = 1 - this.current;
      this.histColor.value = write.textures[0];
      this.histMeta.value = write.textures[1];
    } finally {
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMRT);
    }
    const pose = this.previous ?? { position: new Vector3(), rotation: new Matrix3(), projection: new Matrix4(), forward: new Vector3() };
    pose.position.copy(cam.position);
    pose.rotation.setFromMatrix4(cam.matrixWorld);
    pose.projection.copy(cam.projectionMatrix);
    pose.forward.copy(forward);
    this.previous = pose;
    this.historyOk = true;
    this.frameIndex++;
  }

  build(input: TSLNode, inputs: PostInputs): TSLNode {
    // Built with the pipeline, possibly before the noise arrives: the compose reads neither it nor the weather.
    return composeNode({ u: this.u, reversedDepth: this.renderer.reversedDepthBuffer === true }, input, inputs.sceneDepth, this.histColor, this.histMeta);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.noiseRequested) releaseNoise();
    this.weather.dispose();
    this.shadowMap.dispose();
    this.trace.dispose();
    for (const h of this.history) h.dispose();
    for (const q of [this.traceQuad, this.resolveQuad, this.bakeQuad, this.shadowQuad]) (q?.material as NodeMaterial | undefined)?.dispose();
    this.noise?.dispose();
    this.noise = null;
    if (this.shadowStrength > 0) bindCloudShadows(null);
  }

  // ---------------------------------------------------------------------------

  private loadNoise(): void {
    this.noiseRequested = true;
    requestNoise().then(
      (data) => {
        if (this.disposed) return;
        const tex = new Data3DTexture(data, CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE);
        tex.format = RGBAFormat;
        tex.type = UnsignedByteType;
        tex.wrapS = RepeatWrapping;
        tex.wrapT = RepeatWrapping;
        tex.wrapR = RepeatWrapping;
        tex.minFilter = LinearFilter;
        tex.magFilter = LinearFilter;
        tex.generateMipmaps = false;
        tex.unpackAlignment = 1;
        tex.name = 'cloud noise';
        tex.needsUpdate = true;
        this.noise = tex;
        this.buildMaterials();
        this.onReady?.();
      },
      (error) => console.warn('[VolumetricClouds] no cloud noise', error),
    );
  }

  /** History and trace targets for a drawing buffer size: new targets (bound textures must not be resized). */
  private ensureTargets(width: number, height: number): void {
    const size = historySize(width, height, this.quality.historyPixels);
    if (size.width === this.historyW && size.height === this.historyH) return;
    this.historyW = size.width;
    this.historyH = size.height;
    for (const h of this.history) h.dispose();
    this.trace.dispose();
    this.trace = colorTarget(size.width / 2, size.height / 2, 2, HalfFloatType, NearestFilter);
    this.history = [colorTarget(size.width, size.height, 2, HalfFloatType, LinearFilter), colorTarget(size.width, size.height, 2, HalfFloatType, LinearFilter)];
    this.traceColor.value = this.trace.textures[0];
    this.traceMeta.value = this.trace.textures[1];
    this.current = 0;
    this.histColor.value = this.history[0].textures[0];
    this.histMeta.value = this.history[0].textures[1];
    this.u.historySize.value.set(size.width, size.height);
    this.u.traceSize.value.set(size.width / 2, size.height / 2);
    this.historyOk = false;
  }

  /** What the shader parts read (`cloudNodes.ts`); the noise volume once it has arrived. */
  private shaderContext(): CloudShaderInputs {
    return {
      u: this.u,
      noise: this.noise!,
      weather: this.weatherNode,
      reversedDepth: this.renderer.reversedDepthBuffer === true,
      steps: this.quality.steps,
      lightSteps: this.quality.lightSteps,
    };
  }

  private setOrigin(origin: Origin, p: Vector3, height: number, radius: number, up: Vector3): void {
    const r0 = radius + height;
    origin.height.value = height;
    origin.r0.value = r0;
    origin.r0sq.value = r0 * r0;
    origin.up.value.copy(up);
    // East / north from the weather anchor, minus the wind's slide since the map was drawn.
    _v.subVectors(p, this.anchor);
    _v2.subVectors(this.windOffset, this.windAtBake);
    origin.enu.value.set(_v.dot(this.anchorEast) - _v2.dot(this.anchorEast), _v.dot(this.anchorNorth) - _v2.dot(this.anchorNorth));
    // Noise coordinates: wind-advected shapes that also travel slowly through the volume.
    const s = CLOUD_SCALES.shape;
    const d = CLOUD_SCALES.detail;
    const w = this.windOffset;
    const e = this.evolutionOffset;
    origin.shape.value.set(periodicFraction(p.x - w.x + e.x, s), periodicFraction(p.y - w.y + e.y, s), periodicFraction(p.z - w.z + e.z, s));
    origin.detail.value.set(periodicFraction(p.x - w.x + 2 * e.x, d), periodicFraction(p.y - w.y + 2 * e.y, d), periodicFraction(p.z - w.z + 2 * e.z, d));
  }

  /** Moves the weather map's anchor under the camera when it drifted away, or the wind or the settings changed it. */
  private updateWeatherAnchor(cam: Vector3, lon: number, lat: number, height: number, maxDistance: number, bottom: number, top: number): void {
    const extent = weatherExtent(maxDistance, height);
    // The shell's drift is not in the key: it moves the map like the wind does (see `update`).
    const { coverage } = this.clouds.weatherState;
    _v.subVectors(cam, this.anchor);
    const off = Math.hypot(_v.dot(this.anchorEast), _v.dot(this.anchorNorth));
    _v2.subVectors(this.windOffset, this.windAtBake);
    const slide = Math.hypot(_v2.dot(this.anchorEast), _v2.dot(this.anchorNorth));
    const key = `${coverage}/${bottom}/${top}/${this.clouds.densityVersion}`;
    const resized = this.extent === 0 || Math.abs(extent / this.extent - 1) > 0.2;
    if (this.baked && !resized && off < WEATHER_SLACK && slide < WEATHER_SLACK && key === this.bakeKey) return;
    this.baked = true;
    this.bakePending = true;
    this.bakeKey = key;
    this.extent = resized ? extent : this.extent;
    this.ellipsoid.cartographicToCartesian(lon, lat, 0, this.anchor);
    this.ellipsoid.eastNorthUp(this.anchor, this.anchorEast, this.anchorNorth, this.anchorUp);
    this.windAtBake.copy(this.windOffset);
    const u = this.u;
    u.weatherExtent.value = this.extent;
    u.weatherInv.value = 1 / this.extent;
    u.coverage.value = coverage;
    u.anchorDir.value.copy(this.anchor).normalize();
    u.anchorEast.value.copy(this.anchorEast);
    u.anchorNorth.value.copy(this.anchorNorth);
    u.enuRot.value.set(
      this.anchorEast.x, this.anchorEast.y, this.anchorEast.z,
      this.anchorNorth.x, this.anchorNorth.y, this.anchorNorth.z,
      this.anchorUp.x, this.anchorUp.y, this.anchorUp.z,
    );
    // Noise coordinates of the anchor at mid-layer, wind-advected as of now.
    const mid = _v.copy(this.anchor).addScaledVector(this.anchorUp, (bottom + top) / 2).sub(this.windOffset);
    const frac = (scale: number, out: Vector3) => out.set(periodicFraction(mid.x, scale), periodicFraction(mid.y, scale), periodicFraction(mid.z, scale));
    frac(CLOUD_SCALES.cells, u.bakeCells.value);
    frac(CLOUD_SCALES.clusters, u.bakeClusters.value);
    frac(CLOUD_SCALES.tops, u.bakeTops.value);
  }

  /** The cloud shadow map's frame: axes across the sun, center under the camera snapped to its texels. */
  private updateShadowFrame(lon: number, lat: number, radius: number, sun: Vector3, bottom: number, top: number): void {
    const u = this.u;
    const size = this.quality.shadowMapSize;
    const width = 2 * CLOUD_SHADOW_RANGE;
    const texel = width / size;
    const e1 = u.shadowE1.value.crossVectors(sun, this.up);
    if (e1.lengthSq() < 1e-8) e1.copy(this.east);
    e1.normalize();
    const e2 = u.shadowE2.value.crossVectors(e1, sun).normalize();
    // Nadir, moved across the sun's rays onto the texel grid (the map stays put as the camera moves).
    const center = this.ellipsoid.cartographicToCartesian(lon, lat, 0, this.shadowCenter);
    const c1 = center.dot(e1);
    const c2 = center.dot(e2);
    center.addScaledVector(e1, Math.round(c1 / texel) * texel - c1).addScaledVector(e2, Math.round(c2 / texel) * texel - c2);
    const carto = this.ellipsoid.cartesianToCartographic(center);
    const h = carto?.height ?? 0;
    const up = this.ellipsoid.geodeticNormal(center, this.shadowUp);
    this.setOrigin(this.shadowOrigin, center, h, radius, up);
    u.shadowWidth.value = width;
    // World → (u, v, height): across the sun's rays in map units, and height above the ellipsoid.
    this.shadowMatrix.set(
      e1.x / width, e1.y / width, e1.z / width, 0.5 - center.dot(e1) / width,
      e2.x / width, e2.y / width, e2.z / width, 0.5 - center.dot(e2) / width,
      up.x, up.y, up.z, h - center.dot(up),
      0, 0, 0, 1,
    );
    this.shadowBinding.bottom = bottom;
    this.shadowBinding.top = top;
  }

  // ---------------------------------------------------------------------------
  // Materials of the passes (node graphs in cloudNodes.ts)

  private buildMaterials(): void {
    this.buildBake();
    this.buildShadow();
    this.buildTrace();
    this.buildResolve();
  }

  /** Weather map: drawn again when the shell's density graph changed (`densityVersion`). */
  private buildBake(): void {
    const m = (this.bakeQuad?.material as NodeMaterial | undefined) ?? quadMaterial('Cloud weather');
    this.bakeDensityVersion = this.clouds.densityVersion;
    m.fragmentNode = weatherBakeNode(this.shaderContext(), (dir, footprint) => this.clouds.densityNode(dir, footprint));
    m.needsUpdate = true;
    if (!this.bakeQuad) this.bakeQuad = new QuadMesh(m);
    this.bakePending = true;
  }

  private buildShadow(): void {
    const m = quadMaterial('Cloud shadows');
    m.fragmentNode = cloudShadowNode(this.shaderContext(), this.shadowOrigin);
    this.shadowQuad = new QuadMesh(m);
  }

  private buildTrace(): void {
    const m = quadMaterial('Cloud trace');
    const nodes = traceNodes(this.shaderContext(), this.camOrigin, this.depthNode);
    m.colorNode = nodes.colorNode;
    m.outputNode = nodes.outputNode;
    this.traceQuad = new QuadMesh(m);
  }

  private buildResolve(): void {
    const m = quadMaterial('Cloud resolve');
    const nodes = resolveNodes(this.shaderContext(), {
      traceColor: this.traceColor,
      traceMeta: this.traceMeta,
      prevColor: this.prevColor,
      prevMeta: this.prevMeta,
      depth: this.depthNode,
    });
    m.colorNode = nodes.colorNode;
    m.outputNode = nodes.outputNode;
    this.resolveQuad = new QuadMesh(m);
  }
}
