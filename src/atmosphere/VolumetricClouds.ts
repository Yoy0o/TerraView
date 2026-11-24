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
  Vector2,
  Vector3,
  type DepthTexture,
  type PerspectiveCamera,
  type TextureDataType,
} from 'three';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  ivec2,
  max,
  min,
  mix,
  normalize,
  outputStruct,
  perspectiveDepthToViewZ,
  pow,
  property,
  screenCoordinate,
  screenUV,
  select,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { Ellipsoid } from '../core/Ellipsoid';
import { smoothstep as smoothstepNum } from '../core/math';
import { bindCloudShadows, type CloudShadowBinding } from '../lighting/cloudShadows';
import type { PostEffect, PostFrame, PostInputs } from '../post/PostPipeline';
import { aerialScatteringAlong, atmosphereUniforms } from './AtmosphereNodes';
import type { TSLNode } from '../core/tsl';
import { shIrradiance, type Vec3 } from './atmosphereModel';
import { CLOUD_NOISE_SIZE } from './volumetricCloudMath';
import type { CloudLayer } from './CloudLayer';
import {
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

/** Extinction per meter at density 1. */
const EXTINCTION = 0.05;
/** Single-scattering albedo of cloud droplets (nearly 1: clouds absorb little). */
const ALBEDO = 0.97;
/** Share of a fresh sample in its history pixel (the rest is the reprojected history). */
const FRESH_WEIGHT = 0.3;
/** Mean of a noise channel: what an octave too fine for the pixel fades to. */
const NOISE_MEAN = 0.5;
/** Footprint (m) assumed for light and shadow rays: their finest shape octaves are left out. */
const LIGHT_FOOTPRINT = 150;
/** Scene depth (km) standing for the sky: nothing drawn. */
const SKY_KM = 60_000;
/** Cloud distance (km) used to reproject pixels without clouds. */
const CLEAR_KM = 40;
/** Weather map texels per side. */
const WEATHER_SIZE = 512;
/** Steps through the layer per cloud shadow texel. */
const SHADOW_STEPS = 12;
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

function un(value: number | Vector2 | Vector3 | Matrix3 | Matrix4): TSLNode {
  return uniform(value as never) as TSLNode;
}

/** clamp() for integer vectors (the typed overloads only take float vectors). */
function clampI(v: TSLNode, lo: TSLNode, hi: TSLNode): TSLNode {
  return clamp(v, lo, hi);
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

/** Henyey-Greenstein phase times 4π (isotropic = 1). */
function hg(c: TSLNode, g: number): TSLNode {
  return float(1 - g * g).div(pow(max(float(1 + g * g).sub(c.mul(2 * g)), 1e-4), 1.5));
}

/** Two lobes (forward silver lining, soft back scatter), anisotropy scaled by k (multiple-scattering octaves). */
function cloudPhase(c: TSLNode, k: number): TSLNode {
  return mix(hg(c, -0.25 * k), hg(c, 0.8 * k), 0.6);
}

/** Uniforms of a point the cloud positions are relative to (the camera, the shadow map center). */
interface Origin {
  /** Height above the ellipsoid (m), R + height, (R + height)². */
  height: TSLNode;
  r0: TSLNode;
  r0sq: TSLNode;
  /** Vertical at the point (world). */
  up: TSLNode;
  /** Its east / north offset from the weather map's anchor, minus the wind's slide since the map was drawn (m). */
  enu: TSLNode;
  /** Its noise coordinates (fractions of a period) for the shape and the detail. */
  shape: TSLNode;
  detail: TSLNode;
}

function makeOrigin(): Origin {
  return {
    height: un(0),
    r0: un(6.371e6),
    r0sq: un(6.371e6 * 6.371e6),
    up: un(new Vector3(0, 0, 1)),
    enu: un(new Vector2()),
    shape: un(new Vector3()),
    detail: un(new Vector3()),
  };
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

  private readonly u = {
    radius: un(6.371e6),
    bottom: un(1500),
    thickness: un(2500),
    density: un(1),
    maxDistance: un(80_000),
    minStep: un(30),
    growth: un(0.05),
    cone: un(0.002),
    /** Angle a history pixel covers, radians. */
    pixelAngle: un(0.0017),
    maxStep: un(400),
    lightBase: un(50),
    shear: un(new Vector3()),
    sun: un(new Vector3(0, 0, 1)),
    sunColor: un(new Vector3(1, 1, 1)),
    ambientTop: un(new Vector3(0.3, 0.36, 0.46)),
    ambientBottom: un(new Vector3(0.15, 0.16, 0.18)),
    /** World → east / north / up of the weather anchor. */
    enuRot: un(new Matrix3()),
    weatherInv: un(1 / 200_000),
    fade: un(0),
    // Camera, for the trace and the resolve.
    invProjection: un(new Matrix4()),
    cameraRotation: un(new Matrix3()),
    near: un(1),
    far: un(2),
    slot: un(new Vector2()),
    frame: un(0),
    historySize: un(new Vector2(2, 2)),
    traceSize: un(new Vector2(1, 1)),
    // Reprojection.
    previousViewRotation: un(new Matrix3()),
    previousProjection: un(new Matrix4()),
    cameraDelta: un(new Vector3()),
    windDelta: un(new Vector3()),
    historyValid: un(0),
    // Weather bake.
    anchorDir: un(new Vector3(0, 0, 1)),
    anchorEast: un(new Vector3(1, 0, 0)),
    anchorNorth: un(new Vector3(0, 1, 0)),
    weatherExtent: un(200_000),
    bakeCells: un(new Vector3()),
    bakeClusters: un(new Vector3()),
    bakeTops: un(new Vector3()),
    coverage: un(0.5),
    // Cloud shadow map: the sun-perpendicular axes of the map plane and its width.
    shadowE1: un(new Vector3(1, 0, 0)),
    shadowE2: un(new Vector3(0, 1, 0)),
    shadowWidth: un(2 * CLOUD_SHADOW_RANGE),
  };
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
    const u = this.u;
    return Fn(() => {
      const z = this.sceneKm(inputs.sceneDepth.sample(screenUV).x);
      const pos: TSLNode = screenUV.mul(u.historySize).sub(0.5);
      const base: TSLNode = floor(pos);
      const f: TSLNode = pos.sub(base);
      const maxH = ivec2(u.historySize.sub(1));
      const sum = vec4(0).toVar();
      const wSum = float(0).toVar();
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const q = clampI(ivec2(base).add(ivec2(i, j)), ivec2(0, 0), maxH);
          const wb = (i === 1 ? f.x : f.x.oneMinus()).mul(j === 1 ? f.y : f.y.oneMinus());
          const w = wb.mul(sceneWeight(z, this.histMeta.load(q).y)).add(wb.mul(1e-5));
          sum.addAssign(this.histColor.load(q).mul(w));
          wSum.addAssign(w);
        }
      }
      const cloud = sum.div(max(wSum, 1e-8)).mul(u.fade);
      return vec4(input.rgb.mul(cloud.a.oneMinus()).add(cloud.rgb), input.a);
    })();
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

  /** Scene depth sample → view depth in km (`SKY_KM` where nothing was drawn). */
  private sceneKm(depth: TSLNode): TSLNode {
    const reversed = this.renderer.reversedDepthBuffer === true;
    const sky = reversed ? depth.lessThanEqual(0) : depth.greaterThanEqual(1);
    const viewZ = perspectiveDepthToViewZ(depth, this.u.near, this.u.far);
    return select(sky, float(SKY_KM), viewZ.negate().mul(0.001));
  }

  /** World direction of the view ray through a picture point (uv, v = 0 at the top). */
  private rayDirection(at: TSLNode): { world: TSLNode; view: TSLNode } {
    const u = this.u;
    const ndc = vec2(at.x.mul(2).sub(1), float(1).sub(at.y.mul(2)));
    const p = u.invProjection.mul(vec4(ndc, 0.5, 1));
    const view = normalize(p.xyz.div(p.w));
    return { world: normalize(u.cameraRotation.mul(view)), view };
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
  // Shader parts

  /** Height above the ellipsoid of a point `v` (world offset) from an origin: v·up and v·v given. */
  private heightAt(o: Origin, vu: TSLNode, vv: TSLNode): TSLNode {
    const q = vu.mul(o.r0).mul(2).add(vv);
    return o.height.add(q.div(sqrt(o.r0sq.add(q)).add(o.r0)));
  }

  /** Where a ray from height h0 (r0 = R + h0) with vertical cosine mu crosses height hs: (near, far, hit). */
  private roots(h0: TSLNode, r0: TSLNode, mu: TSLNode, hs: TSLNode): TSLNode {
    const b = r0.mul(mu);
    const c = h0.sub(hs).mul(h0.add(hs).add(this.u.radius.mul(2)));
    const d = b.mul(b).sub(c);
    const s = sqrt(max(d, 0));
    const q = b.add(select(b.greaterThanEqual(0), s, s.negate())).negate();
    const other = c.div(select(abs(q).greaterThan(1e-3), q, float(1e-3)));
    return vec3(min(q, other), max(q, other), select(d.greaterThanEqual(0), float(1), float(0)));
  }

  /** The nearest stretch of a ray inside the cloud layer: (start, end), end < start when it misses (see `cloudInterval`). */
  private interval(h0: TSLNode, r0: TSLNode, mu: TSLNode): TSLNode {
    const u = this.u;
    const top = u.bottom.add(u.thickness);
    const outer = this.roots(h0, r0, mu, top);
    const inner = this.roots(h0, r0, mu, u.bottom);
    const ground = this.roots(h0, r0, mu, float(0));
    const start = float(0).toVar();
    const end = outer.y.toVar();
    const ok = select(outer.z.greaterThan(0.5).and(outer.y.greaterThan(0)), float(1), float(0)).toVar();
    const innerAhead = inner.z.greaterThan(0.5).and(inner.x.greaterThan(0));
    If(h0.lessThan(u.bottom), () => {
      start.assign(max(inner.y, 0));
      ok.assign(ok.mul(inner.z));
    })
      .ElseIf(h0.greaterThan(top), () => {
        start.assign(max(outer.x, 0));
        If(innerAhead, () => {
          end.assign(inner.x);
        });
      })
      .Else(() => {
        If(innerAhead, () => {
          end.assign(inner.x);
        });
      });
    If(ground.z.greaterThan(0.5).and(ground.x.greaterThan(0)), () => {
      end.assign(min(end, ground.x));
    });
    return vec2(start, select(ok.greaterThan(0.5), end, float(-1)));
  }

  /** Weather at an east / north offset from the anchor: (presence 0–1, top 0–1), faded out at the map's border. */
  private weatherAt(enu: TSLNode): TSLNode {
    const u = this.u;
    const at = vec2(enu.x.mul(u.weatherInv).add(0.5), float(0.5).sub(enu.y.mul(u.weatherInv)));
    const w = this.weatherNode.sample(at).level(0);
    const border = min(min(at.x, at.y), min(at.x.oneMinus(), at.y.oneMinus()));
    return vec2(w.r.mul(smoothstep(0, 0.08, border)), w.g);
  }

  /**
   * Cloud density 0–1 at `v` (world offset from the origin), height fraction hf in the layer,
   * weather w. `footprint`: meters a history pixel covers there; noise octaves finer than about
   * two pixels fade to their mean (the volume has no mipmaps: they would sparkle), and the edge
   * detail is skipped entirely beyond its reach. null: no detail (light and shadow rays).
   */
  private densityAt(o: Origin, v: TSLNode, hf: TSLNode, w: TSLNode, footprint: TSLNode | null): TSLNode {
    const u = this.u;
    const noise = this.noise!;
    const lod = footprint ?? float(LIGHT_FOOTPRINT);
    // Flat base; tops at the weather's height (towers where it says so), lower toward the cloud's
    // edge along a round dome (√presence: not walls, not cones), tapering off near the top only.
    const topH = mix(float(0.4), float(1), w.y).mul(mix(float(0.25), float(1), sqrt(w.x)));
    const profile = smoothstep(0, 0.06, hf).mul(float(1).sub(smoothstep(topH.mul(0.7), topH, hf)));
    // Tops lean downwind (shear): the shape is looked up further upwind higher up.
    const s = texture3D(noise, o.shape.add(v.sub(u.shear.mul(hf)).mul(1 / CLOUD_SCALES.shape)), float(0));
    const lowFbm = worleyFbm(s, CLOUD_SCALES.shape, lod);
    // remap(Perlin-Worley, lowFbm − 1, 1, 0, 1): billows carved by the Worley octaves.
    const shape = s.r.sub(lowFbm).add(1).div(float(2).sub(lowFbm));
    const dens = clamp(shape.mul(profile).add(w.x).sub(1), 0, 1).toVar();
    if (footprint) {
      // The detail's coarsest octave has cells of a quarter period; past half of that, nothing is left.
      If(dens.greaterThan(0).and(footprint.lessThan(CLOUD_SCALES.detail / 8)), () => {
        const d = texture3D(noise, o.detail.add(v.mul(1 / CLOUD_SCALES.detail)), float(0));
        const hfbm = worleyFbm(d, CLOUD_SCALES.detail, footprint);
        // Wispy at the base, billowy higher up; less erosion as the detail fades out.
        const reach = float(1).sub(smoothstep(CLOUD_SCALES.detail / 16, CLOUD_SCALES.detail / 8, footprint));
        const erode = mix(hfbm, hfbm.oneMinus(), clamp(hf.mul(4), 0, 1)).mul(reach.mul(0.32));
        dens.assign(clamp(dens.sub(erode).div(erode.oneMinus()), 0, 1));
      });
    }
    return dens;
  }

  /** Optical depth toward the sun from `v` (offset from the origin; enuV its east / north from it). */
  private lightDepth(o: Origin, v: TSLNode, enuV: TSLNode, enuSun: TSLNode): TSLNode {
    const u = this.u;
    const tau = float(0).toVar();
    Loop(this.quality.lightSteps, ({ i }: { i: TSLNode }) => {
      const fi = float(i);
      const seg = u.lightBase.mul(pow(1.9, fi));
      const mid = u.lightBase.mul(pow(1.9, fi.add(1)).sub(1).div(0.9)).sub(seg.mul(0.5));
      const vl = v.add(u.sun.mul(mid));
      const hl = this.heightAt(o, dot(vl, o.up), dot(vl, vl));
      const hfl = hl.sub(u.bottom).div(u.thickness);
      If(hfl.greaterThanEqual(0).and(hfl.lessThanEqual(1)), () => {
        const wl = this.weatherAt(o.enu.add(enuV).add(enuSun.mul(mid)));
        If(wl.x.greaterThan(0.002), () => {
          tau.addAssign(this.densityAt(o, vl, hfl, wl, null).mul(seg));
        });
      });
    });
    return tau.mul(u.density.mul(EXTINCTION));
  }

  private buildMaterials(): void {
    this.buildBake();
    this.buildShadow();
    this.buildTrace();
    this.buildResolve();
  }

  /** Weather map: presence (r), tops (g), the shell's density (b, diagnostics). */
  private buildBake(): void {
    const u = this.u;
    const noise = this.noise!;
    const m = (this.bakeQuad?.material as NodeMaterial | undefined) ?? quadMaterial('Cloud weather');
    this.bakeDensityVersion = this.clouds.densityVersion;
    m.fragmentNode = Fn(() => {
      const t = uv();
      const x = t.x.sub(0.5).mul(u.weatherExtent);
      const y = float(0.5).sub(t.y).mul(u.weatherExtent);
      const local = u.anchorEast.mul(x).add(u.anchorNorth.mul(y));
      const invR = float(1).div(u.radius);
      const dir = normalize(u.anchorDir.add(local.mul(invR)));
      // The cloud shell's density here: the weather follows the clouds seen from space.
      const macro = this.clouds.densityNode(dir, u.weatherExtent.mul(1 / WEATHER_SIZE).mul(invR));
      const cellNoise = texture3D(noise, u.bakeCells.add(local.mul(1 / CLOUD_SCALES.cells)), float(0));
      // A coarse map (camera high up) drops cells smaller than two of its texels.
      const texel = u.weatherExtent.mul(1 / WEATHER_SIZE);
      const cellFade = (cells: number) => smoothstep(CLOUD_SCALES.cells / cells / 2, CLOUD_SCALES.cells / cells, texel);
      const cells = mix(cellNoise.g, NOISE_MEAN, cellFade(4)).mul(0.7).add(mix(cellNoise.b, NOISE_MEAN, cellFade(8)).mul(0.3));
      const clusters = texture3D(noise, u.bakeClusters.add(local.mul(1 / CLOUD_SCALES.clusters)), float(0)).r;
      const tops = texture3D(noise, u.bakeTops.add(local.mul(1 / CLOUD_SCALES.tops)), float(0)).r;
      const field = cells.mul(0.75).add(clusters.mul(0.35)).sub(0.1);
      // Scattered cumulus under a clear shell, broken to overcast under its thick clouds.
      const cov = u.coverage;
      const local01 = mix(cov.mul(0.55), min(cov.mul(1.3).add(0.1), 1), macro);
      const threshold = mix(float(0.72), float(0.18), local01);
      // A wide edge: the shape noise carves it into billows (a narrow one makes walls). Never
      // narrower than a few texels either, or the map's grid shows as steps along the edges.
      // Widened about its middle, so the share of sky covered stays.
      const soft = max(float(1), texel.div(600)).mul(0.13);
      const presence = smoothstep(threshold.add(0.03).sub(soft), threshold.add(0.03).add(soft), field);
      return vec4(presence, smoothstep(0.25, 0.85, tops), macro, 1);
    })();
    m.needsUpdate = true;
    if (!this.bakeQuad) this.bakeQuad = new QuadMesh(m);
    this.bakePending = true;
  }

  /** Cloud shadow map: sunlight transmittance through the layer along the sun's rays. */
  private buildShadow(): void {
    const u = this.u;
    const o = this.shadowOrigin;
    const m = quadMaterial('Cloud shadows');
    m.fragmentNode = Fn(() => {
      const t = uv();
      const q = u.shadowE1.mul(t.x.sub(0.5).mul(u.shadowWidth)).add(u.shadowE2.mul(t.y.sub(0.5).mul(u.shadowWidth)));
      const hq = this.heightAt(o, dot(q, o.up), dot(q, q));
      const r0q = u.radius.add(hq);
      // Vertical at q: the direction from the local center of curvature.
      const radial = normalize(o.up.mul(o.r0).add(q));
      const mu = dot(u.sun, radial);
      const span = this.interval(hq, r0q, mu);
      const tau = float(0).toVar();
      If(span.y.greaterThan(span.x), () => {
        const len = min(span.y.sub(span.x), u.thickness.mul(6));
        const ds = len.div(SHADOW_STEPS);
        const enuQ = u.enuRot.mul(q).xy;
        const enuSun = u.enuRot.mul(u.sun).xy;
        Loop(SHADOW_STEPS, ({ i }: { i: TSLNode }) => {
          const s = span.x.add(float(i).add(0.5).mul(ds));
          const v = q.add(u.sun.mul(s));
          const h = this.heightAt(o, dot(v, o.up), dot(v, v));
          const hf = h.sub(u.bottom).div(u.thickness);
          const w = this.weatherAt(o.enu.add(enuQ).add(enuSun.mul(s)));
          If(w.x.greaterThan(0.002).and(hf.greaterThanEqual(0)).and(hf.lessThanEqual(1)), () => {
            tau.addAssign(this.densityAt(o, v, hf, w, null).mul(ds));
          });
        });
      });
      const T: TSLNode = exp(tau.mul(u.density.mul(EXTINCTION)).negate());
      return vec4(T, T, T, 1);
    })();
    this.shadowQuad = new QuadMesh(m);
  }

  /** The ray march of a quarter of the history's pixels (MRT: color = (radiance, opacity), meta = (cloud km, scene km)). */
  private buildTrace(): void {
    const u = this.u;
    const o = this.camOrigin;
    const colorOut = property('vec4');
    const metaOut = property('vec4');
    const m = quadMaterial('Cloud trace');
    m.colorNode = Fn(() => {
      const px = floor(screenCoordinate.xy);
      const at = px.mul(2).add(u.slot).add(0.5).div(u.historySize);
      const { world: dir, view } = this.rayDirection(at);
      // Scene distance along the ray (the clouds stop at what is drawn).
      const z = this.sceneKm(this.depthNode.sample(at).r);
      const tScene = select(z.greaterThanEqual(SKY_KM * 0.5), float(1e12), z.mul(1000).div(max(view.z.negate(), 1e-4)));
      const mu = dot(dir, o.up);
      const span = this.interval(o.height, o.r0, mu);
      const start = span.x;
      const end = min(min(span.y, tScene), start.add(u.maxDistance));
      const L = vec3(0).toVar();
      const T = float(1).toVar();
      const dSum = float(0).toVar();
      If(end.greaterThan(start), () => {
        // Interleaved gradient noise, shifted every frame: the history averages the step jitter out.
        const ign = fract(fract(dot(px, vec2(0.06711056, 0.00583715))).mul(52.9829189).add(u.frame.mul(0.61803398875)));
        const t = start.add(max(u.minStep, start.mul(u.cone)).mul(ign)).toVar();
        const cosT = dot(dir, u.sun);
        const p0 = cloudPhase(cosT, 1);
        const p1 = cloudPhase(cosT, 0.5);
        const p2 = cloudPhase(cosT, 0.25);
        const enuDir = u.enuRot.mul(dir).xy;
        const enuSun = u.enuRot.mul(u.sun).xy;
        const capStep = u.maxStep.div(max(abs(mu), 0.08));
        // Strides (growing with the distance marched) over empty space; footprint-sized steps
        // inside clouds, entered by backing up the stride that hit one.
        const striding = float(1).toVar();
        const empty = float(0).toVar();
        const lastStep = float(0).toVar();
        Loop(this.quality.steps, () => {
          If(t.greaterThanEqual(end).or(T.lessThan(0.01)), () => {
            Break();
          });
          const v = dir.mul(t);
          const h = this.heightAt(o, t.mul(mu), t.mul(t));
          const hf = h.sub(u.bottom).div(u.thickness);
          const fine = min(max(u.minStep, t.mul(u.cone)), capStep);
          const stride = min(max(fine.mul(3), u.minStep.add(t.sub(start).mul(u.growth))), capStep.mul(2));
          const w = this.weatherAt(o.enu.add(enuDir.mul(t)));
          const dens = float(0).toVar();
          If(w.x.greaterThan(0.002).and(hf.greaterThanEqual(0)).and(hf.lessThanEqual(1)), () => {
            // No detail while striding: a hit test (erosion only removes density), and cheaper.
            dens.assign(this.densityAt(o, v, hf, w, select(striding.greaterThan(0.5), float(1e6), t.mul(u.pixelAngle))));
          });
          const hit = dens.greaterThan(0.0005);
          If(hit.and(striding.greaterThan(0.5)).and(lastStep.greaterThan(fine)), () => {
            t.assign(t.sub(lastStep).add(fine));
            lastStep.assign(fine);
            striding.assign(0);
            empty.assign(0);
          }).ElseIf(hit, () => {
            striding.assign(0);
            empty.assign(0);
            const step = fine;
            {
              const sigma = dens.mul(u.density.mul(EXTINCTION));
              const tau = this.lightDepth(o, v, enuDir.mul(t), enuSun);
              // Multiple scattering (Wrenninge's octaves): less extinction, softer phase, less energy.
              const ms = p0
                .mul(exp(tau.negate()))
                .add(p1.mul(exp(tau.mul(-0.35))).mul(0.6))
                .add(p2.mul(exp(tau.mul(-0.12))).mul(0.36))
                .div(1.96);
              // Powder: thin parts facing away from the sun are darker (the light has not scattered back yet).
              const powder = mix(float(1), float(1).sub(exp(sigma.mul(-160))), clamp(cosT.negate().mul(0.5).add(0.5), 0, 1).mul(0.5));
              const ambient = mix(u.ambientBottom, u.ambientTop, sqrt(clamp(hf, 0, 1)));
              const S = u.sunColor.mul(ms.mul(powder)).add(ambient).mul(ALBEDO);
              const stepT = exp(sigma.mul(step).negate());
              const a = T.mul(stepT.oneMinus());
              L.addAssign(S.mul(a));
              dSum.addAssign(a.mul(t));
              T.mulAssign(stepT);
            }
            t.addAssign(step);
            lastStep.assign(step);
          }).Else(() => {
            // A few empty samples in a row: back to striding.
            empty.addAssign(1);
            If(empty.greaterThanEqual(3), () => {
              striding.assign(1);
            });
            const step = select(striding.greaterThan(0.5), stride, fine);
            t.addAssign(step);
            lastStep.assign(step);
          });
        });
      });
      const alpha = clamp(T.oneMinus().div(0.99), 0, 1);
      const has = alpha.greaterThan(0.001);
      // Without clouds, where they would be: the middle of the ray's stretch in the layer (the
      // history moves with the wind there), else the scene or a default distance.
      const clear = select(end.greaterThan(start), start.add(end).mul(0.5), min(tScene, float(CLEAR_KM * 1000)));
      const dCloud = select(has, dSum.div(max(T.oneMinus(), 1e-6)), clear);
      // Far clouds thin out before the march's end (no visible cut).
      const far = float(1).sub(smoothstep(u.maxDistance.mul(0.65), u.maxDistance, dCloud.sub(start)));
      const color = vec4(L.mul(far), alpha.mul(far)).toVar();
      If(has.and(atmosphereUniforms.atmosphereEnabled.greaterThan(0.5)), () => {
        const s = aerialScatteringAlong(dir, dCloud);
        color.assign(vec4(color.rgb.mul(s.transmittance).add(s.inscatter.mul(atmosphereUniforms.groundHaze).mul(color.a)), color.a));
      });
      colorOut.assign(color);
      metaOut.assign(vec4(dCloud.mul(0.001), z, 0, 1));
      return vec4(0);
    })();
    m.outputNode = outputStruct(colorOut, metaOut);
    this.traceQuad = new QuadMesh(m);
  }

  /** Temporal resolve into the history (MRT: color, meta = (cloud km, scene km)). */
  private buildResolve(): void {
    const u = this.u;
    const colorOut = property('vec4');
    const metaOut = property('vec4');
    const m = quadMaterial('Cloud resolve');
    m.colorNode = Fn(() => {
      const px = floor(screenCoordinate.xy);
      const at = px.add(0.5).div(u.historySize);
      const tc = floor(px.mul(0.5));
      const sub = px.sub(tc.mul(2));
      const fresh = sub.x.equal(u.slot.x).and(sub.y.equal(u.slot.y));
      const tcI = ivec2(tc);
      const maxT = ivec2(u.traceSize.sub(1));
      const cur = this.traceColor.load(tcI);
      const curMeta = this.traceMeta.load(tcI);
      const z = this.sceneKm(this.depthNode.sample(at).r);
      // The new samples around: their range (history clamp) and a depth-aware estimate for this pixel.
      const lo = vec4(1e9).toVar();
      const hi = vec4(-1e9).toVar();
      const est = vec4(0).toVar();
      const estD = float(0).toVar();
      const wSum = float(0).toVar();
      const dSum = float(0).toVar();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = clampI(tcI.add(ivec2(dx, dy)), ivec2(0, 0), maxT);
          const c = this.traceColor.load(q);
          const mq = this.traceMeta.load(q);
          lo.assign(min(lo, c));
          hi.assign(max(hi, c));
          const off = vec2(q).mul(2).add(u.slot).sub(px);
          const w = exp(dot(off, off).mul(-0.35)).mul(sceneWeight(z, mq.y)).add(1e-6);
          est.addAssign(c.mul(w));
          // The distance the clouds move at: their own, mostly (cloud-free samples guess it).
          const wd = w.mul(c.a.add(0.05));
          estD.addAssign(mq.x.mul(wd));
          dSum.addAssign(wd);
          wSum.addAssign(w);
        }
      }
      est.divAssign(wSum);
      estD.divAssign(dSum);
      const spatial = select(fresh, cur, est);
      const spatialD = select(fresh, curMeta.x, estD);
      const outC = vec4(spatial).toVar();
      const outD = float(spatialD).toVar();
      If(u.historyValid.greaterThan(0.5), () => {
        // Where this pixel's clouds were in the previous picture: their distance, the camera's
        // motion and the wind (the point here now was upwind then).
        const { world: dir } = this.rayDirection(at);
        const p = dir.mul(spatialD.mul(1000)).add(u.cameraDelta).sub(u.windDelta);
        const clip = u.previousProjection.mul(vec4(u.previousViewRotation.mul(p), 1));
        const ndc = clip.xy.div(clip.w);
        const prevAt = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
        const inside = clip.w.greaterThan(0).and(prevAt.x.greaterThanEqual(0)).and(prevAt.y.greaterThanEqual(0)).and(prevAt.x.lessThanEqual(1)).and(prevAt.y.lessThanEqual(1));
        const h = this.prevColor.sample(prevAt).level(0);
        const hm = this.prevMeta.sample(prevAt).level(0);
        // The same surface behind (or sky) as then, else the history is someone else's.
        const same = inside.and(sceneWeight(z, hm.y).greaterThan(0.25));
        If(same, () => {
          const kept = clamp(h, lo.sub(0.004), hi.add(0.004));
          outC.assign(select(fresh, mix(cur, kept, 1 - FRESH_WEIGHT), kept));
          outD.assign(select(fresh, curMeta.x, hm.x));
        });
      });
      colorOut.assign(vec4(max(outC.rgb, vec3(0)), clamp(outC.a, 0, 1)));
      metaOut.assign(vec4(outD, z, 0, 1));
      return vec4(0);
    })();
    m.outputNode = outputStruct(colorOut, metaOut);
    this.resolveQuad = new QuadMesh(m);
  }
}

/**
 * How much two scene depths (km, `SKY_KM` for the sky) belong to the same surface: 1 for
 * sky and sky, ~0 for sky and something, falling off with the relative difference otherwise.
 */
/**
 * Fractal Worley noise from the single-octave channels of a noise sample (G, B, A: 4, 8, 16
 * cells per `period` meters). An octave whose cells shrink below about two `footprint`s fades
 * to the mean: the volume has no mipmaps, so finer octaves would sparkle instead of averaging out.
 */
function worleyFbm(s: TSLNode, period: number, footprint: TSLNode): TSLNode {
  const octave = (value: TSLNode, cells: number) => {
    const cell = period / cells;
    return mix(value, NOISE_MEAN, smoothstep(cell / 4, cell / 2, footprint));
  };
  return octave(s.g, 4).mul(0.625).add(octave(s.b, 8).mul(0.25)).add(octave(s.a, 16).mul(0.125));
}

function sceneWeight(a: TSLNode, b: TSLNode): TSLNode {
  const skyA = a.greaterThan(SKY_KM * 0.5);
  const skyB = b.greaterThan(SKY_KM * 0.5);
  const rel = exp(abs(a.sub(b)).div(min(a, b).mul(0.06).add(0.003)).negate());
  return select(skyA.and(skyB), float(1), select(skyA.or(skyB), float(0.001), rel));
}

