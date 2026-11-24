/**
 * Sun shadows of buildings and devices (roadmap M3.9, `viewer.shadows`): one orthographic shadow
 * map along the sun's rays, fitted every frame to the buildings ∩ the view (`shadowFit.ts`).
 *
 * - The map is this module's own depth-only render target, drawn from the building tree alone
 *   (`indoor.root` as the scene: nothing else is traversed, the scene's statistics hooks do not
 *   run). Casters are meshes with `castShadow` whose material is opaque: glass, windows and
 *   level-faded content let the sun through.
 * - Receivers read it through one shared node (`sunShadowFactor`): lit materials (buildings,
 *   devices, glTF, 3D Tiles) get it as the sun light's `shadow.shadowNode`, so it dims the direct
 *   sun only (the sky probe and the night fill stay); globe tiles multiply their direct sun term
 *   with it. three's own `ShadowNode` is not used: its cascaded variant multiplies float32 ECEF
 *   positions (half a meter of error), and globe tiles are not lit materials.
 * - Precision: the shadow coordinate is `(shadow matrix × object matrix)` applied to the local
 *   position, the product taken per object on the CPU in float64 (as three does for
 *   `highPrecision`), so the RTC origins of tiles and buildings never meet ECEF magnitudes on the GPU.
 * - The node's inputs are module-level uniforms shared by every viewer on the page: each viewer
 *   writes its own (`bind`) before it renders, like the atmosphere uniforms (docs/api.md §4).
 */
import {
  DepthTexture,
  Matrix3,
  DoubleSide,
  GreaterEqualCompare,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  OrthographicCamera,
  RenderTarget,
  UnsignedIntType,
  WebGPUCoordinateSystem,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
} from 'three';
import { Fn, If, abs, cross, dFdx, dFdy, dot, float, min, mix, normalLocal, normalize, output, positionLocal, sign, smoothstep, sqrt, texture, uniform, vec2, vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { applyAerialPerspective, type TSLNode } from '../atmosphere/AtmosphereNodes';
import { cloudShadowFactor } from './cloudShadows';
import { fitSunShadow, sameFit, shadowCameraMatrix, sunShadowStrength, type ShadowCaster, type ShadowFit, type ShadowView } from './shadowFit';

/** Settings of the sun shadows (`viewer.shadows`). */
export interface SunShadowOptions {
  /** Draw shadows while `viewer.lighting` is on (default from the GPU tier: off on `low`). */
  enabled?: boolean;
  /** How dark a full shadow is, 0–1 (default 0.85): the share of direct sunlight it takes away. */
  intensity?: number;
  /** Width of the soft edge in shadow map texels, 0.5–4 (default 1.5). */
  softness?: number;
  /** Shadows end this far from the camera, meters (default 2000). */
  maxDistance?: number;
  /** Texels along a side of the shadow map, 512–4096 (default from the GPU tier: 2048, 4096 on `ultra`). */
  mapSize?: number;
}

/** What a frame of shadows needs to know (`SunShadows.update`). */
export interface SunShadowFrame {
  /** Unit vector toward the sun (world). */
  sun: Vector3;
  /** Real sun lighting is on (`viewer.lighting`); otherwise there are no shadows. */
  lighting: boolean;
  /** Casting buildings, and the point the light frame is anchored to (a building anchor) with its vertical. */
  casters: readonly ShadowCaster[];
  origin: Vector3;
  up: Vector3;
  view: ShadowView;
}

const DEFAULTS = { intensity: 0.85, softness: 1.5, maxDistance: 2000 };
/** Depth bias toward the light, meters (on top of the normal offset): depth quantization only. */
const DEPTH_BIAS_M = 0.02;
/**
 * Normal offset (see `sunShadowFactor`): enough to clear the receiver's own surface across the
 * filter's reach, at most this many reaches (grazing surfaces get little direct sun anyway; more
 * would detach shadows from their casters).
 */
const MAX_OFFSET_REACHES = 3;
/** Share of the map along its border over which shadows fade out (where the fitted range cuts them). */
const EDGE_FADE = 0.03;

// -----------------------------------------------------------------------------
// Shared receiver node

const S = {
  /** 0 = no shadows (nothing is sampled). */
  strength: uniform(0),
  /** Shadow map texel, uv units. */
  texel: uniform(1 / 2048),
  /** Soft edge radius, texels. */
  softness: uniform(DEFAULTS.softness),
  /** Shadow map texel, meters. */
  texelMeters: uniform(0.05),
  /** Depth bias in map depth units, signed toward the light (reversed depth: +). */
  bias: uniform(0),
};
/** The current viewer's shadow matrix: world → (u, v, depth) of its map. */
const shadowMatrix = new Matrix4();
/** The current viewer's direction toward the sun (world). */
const lightDirection = new Vector3(0, 0, 1);
const _rotation = new Matrix3();
const _light = new Vector3();
const _scale = new Vector3();
let mapNode: TSLNode = null;
let sharedFactor: TSLNode = null;

/**
 * A depth-only shadow map target. 24-bit depth either way: the orthographic depth is linear, so
 * reversed depth gains nothing, and float depth is not filterable everywhere (no comparison
 * sampler then). The target owns the texture: three treats a depth texture without one as
 * multisampled like the canvas (no sampler either).
 */
function shadowTarget(size: number, reversed: boolean): RenderTarget {
  const t = new DepthTexture(size, size);
  t.type = UnsignedIntType;
  t.compareFunction = reversed ? GreaterEqualCompare : LessEqualCompare;
  // Hardware 2×2 PCF on every tap.
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.name = 'sun shadow map';
  return new RenderTarget(size, size, { depthTexture: t, count: 0 });
}

/**
 * Sunlight that reaches the shaded point, 0–1 (1 outside the shadow map and while shadows are
 * off): one node for every receiver. For lit materials it is the sun light's `shadow.shadowNode`;
 * globe tiles multiply their direct sun term with it.
 */
export function sunShadowFactor(): TSLNode {
  if (sharedFactor) return sharedFactor;
  // Replaced by each viewer's own map (`bind`) before anything is drawn with it.
  mapNode = texture(shadowTarget(1, false).depthTexture!);
  // Shadow matrix × object matrix, per drawn object in float64 (RTC origins stay on the CPU).
  const objectToShadow: TSLNode = (uniform(new Matrix4()) as TSLNode).onObjectUpdate(
    ({ object }: { object: Object3D | null }, self: { value: Matrix4 }) => self.value.multiplyMatrices(shadowMatrix, object!.matrixWorld),
  );
  // Direction toward the sun in the object's own frame (xyz) and meters → local units (w), per object.
  const objectLight: TSLNode = (uniform(new Vector4()) as TSLNode).onObjectUpdate(
    ({ object }: { object: Object3D | null }, self: { value: Vector4 }) => {
      const scale = _scale.setFromMatrixColumn(object!.matrixWorld, 0).length() || 1;
      _rotation.setFromMatrix4(object!.matrixWorld).transpose();
      _light.copy(lightDirection).applyMatrix3(_rotation).normalize();
      return self.value.set(_light.x, _light.y, _light.z, 1 / scale);
    },
  );
  sharedFactor = Fn((builder: { geometry?: { hasAttribute(name: string): boolean } }) => {
    const lit = float(1).toVar();
    // Photogrammetry often has no normals (unlit, or flat-shaded glTF): the face normal from the
    // position's screen derivatives then (only its line matters below, not its sign).
    const hasNormals = builder.geometry?.hasAttribute('normal') !== false;
    If(S.strength.greaterThan(0), () => {
      // Normal offset: the lookup point leaves its surface toward the sun far enough that the
      // filter's taps (reach r across the rays) stay in front of the surface's own depth: the
      // surface's depth changes by r·tanθ over r, the offset o gains o·cosθ, so o = r·sinθ / cos²θ
      // (θ between the normal and the sun), capped; plus half a texel for the map's own steps.
      const n = hasNormals ? normalize(normalLocal) : normalize(cross(dFdx(positionLocal), dFdy(positionLocal)));
      const facing = dot(n, objectLight.xyz);
      const c = abs(facing).max(0.05);
      const reach = S.texelMeters.mul(S.softness.add(1));
      const o = min(reach.mul(sqrt(float(1).sub(c.mul(c)))).div(c.mul(c)), reach.mul(MAX_OFFSET_REACHES)).add(S.texelMeters.mul(0.5));
      const offset = n.mul(sign(facing)).mul(o).mul(objectLight.w);
      const p = objectToShadow.mul(vec4(positionLocal.add(offset), 1)).xyz.toVar();
      const uv = vec2(p.x, p.y.oneMinus()).toVar();
      const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1)).and(p.z.greaterThan(0)).and(p.z.lessThan(1));
      If(inside, () => {
        const ref = p.z.add(S.bias);
        // 4 × 4 taps 2/3 · softness texels apart, each a hardware 2 × 2 comparison: at the
        // default softness the bilinear footprints touch (no steps along slanted edges).
        const spacing = S.texel.mul(S.softness).mul(2 / 3);
        let sum: TSLNode = float(0);
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) sum = sum.add(mapNode.sample(uv.add(vec2(i - 1.5, j - 1.5).mul(spacing))).compare(ref));
        }
        const border = min(min(uv.x, uv.y), min(uv.x.oneMinus(), uv.y.oneMinus()));
        const fade = smoothstep(0, EDGE_FADE, border);
        lit.assign(mix(1, sum.div(16), S.strength.mul(fade)));
      });
    });
    // Clouds overhead (volumetric clouds): their own map, 1 while there are none.
    return lit.mul(cloudShadowFactor());
  })();
  return sharedFactor;
}

/** Share of an unlit surface's (baked) brightness a full shadow takes away: what direct sun adds to photogrammetry. */
const UNLIT_SHADOW = 0.5;
let unlitOutput: TSLNode = null;

/**
 * Output node for unlit materials (photogrammetry 3D Tiles, whose textures have the light baked
 * in): darkens them where buildings shade the sun, then applies the aerial perspective. Shared
 * by every such material (the counterpart of `aerialPerspectiveOutputNode`).
 */
export function unlitShadowOutputNode(): TSLNode {
  if (unlitOutput) return unlitOutput;
  const factor = sunShadowFactor();
  unlitOutput = Fn(() => {
    const color = vec4(output);
    const dim = mix(1 - UNLIT_SHADOW, 1, factor);
    return applyAerialPerspective(vec4(color.rgb.mul(dim), color.a));
  })();
  return unlitOutput;
}

// -----------------------------------------------------------------------------
// Per viewer

/** Opaque, casting meshes go into the map; transparent ones (glass, faded levels) let the sun through. */
function casts(object: Object3D, material: Material): boolean {
  return object.castShadow === true && material.transparent !== true && material.visible !== false;
}

/**
 * The sun shadow map of a viewer (`viewer.shadows`). Shadows show while `viewer.lighting`
 * is on and the sun is up, on buildings, devices, the globe and 3D Tiles near the camera; they
 * are cast by buildings and devices.
 */
export class SunShadows {
  private _enabled: boolean;
  private _intensity = DEFAULTS.intensity;
  private _softness = DEFAULTS.softness;
  private _maxDistance = DEFAULTS.maxDistance;
  private _mapSize: number;
  /** The shadow map (created at its size the first time shadows are drawn). */
  private target: RenderTarget | null = null;
  /**
   * An empty 1 × 1 map bound while there are no shadows. A separate target, not the map at
   * another size: materials keep the GPU texture they were bound to across a resize.
   */
  private idle: RenderTarget | null = null;
  private readonly camera = new OrthographicCamera();
  private readonly matrix = new Matrix4();
  private fit: ShadowFit | null = null;
  /** Fit the map was last drawn with (null: not drawn, or drawn before a change). */
  private drawnFit: ShadowFit | null = null;
  private strength = 0;
  private readonly depthMaterials = new Map<unknown, MeshBasicNodeMaterial>();
  private disposed = false;

  constructor(
    private readonly renderer: WebGPURenderer,
    defaults: { enabled: boolean; mapSize: number },
    options: SunShadowOptions = {},
    /** Called when shadows turn on or off (receivers rebuild their shaders) and when a setting changes the picture. */
    private readonly changed: (toggled: boolean) => void = () => {},
  ) {
    this._enabled = defaults.enabled;
    this._mapSize = defaults.mapSize;
    this.camera.matrixAutoUpdate = false;
    this.camera.name = 'SunShadowCamera';
    this.configure(options);
  }

  /** Whether shadows are drawn while `viewer.lighting` is on. Turning them on or off rebuilds the shaders of lit materials once. */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (!v) this.release();
    this.drawnFit = null;
    this.changed(true);
  }

  /** How dark a full shadow is, 0–1. */
  get intensity(): number {
    return this._intensity;
  }

  set intensity(v: number) {
    const x = Math.min(1, Math.max(0, Number.isFinite(v) ? v : DEFAULTS.intensity));
    if (x === this._intensity) return;
    this._intensity = x;
    this.changed(false);
  }

  /** Soft edge width, shadow map texels (0.5–4). */
  get softness(): number {
    return this._softness;
  }

  set softness(v: number) {
    const x = Math.min(4, Math.max(0.5, Number.isFinite(v) ? v : DEFAULTS.softness));
    if (x === this._softness) return;
    this._softness = x;
    this.changed(false);
  }

  /** Distance from the camera where shadows end, meters. */
  get maxDistance(): number {
    return this._maxDistance;
  }

  set maxDistance(v: number) {
    const x = Math.max(10, Number.isFinite(v) ? v : DEFAULTS.maxDistance);
    if (x === this._maxDistance) return;
    this._maxDistance = x;
    this.changed(false);
  }

  /** Texels along a side of the shadow map (512–4096, a power of two). */
  get mapSize(): number {
    return this._mapSize;
  }

  set mapSize(v: number) {
    const x = 2 ** Math.round(Math.log2(Math.min(4096, Math.max(512, Number.isFinite(v) ? v : 2048))));
    if (x === this._mapSize) return;
    this._mapSize = x;
    this.release();
    this.changed(false);
  }

  /** Changes some settings. */
  configure(options: SunShadowOptions): void {
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.intensity !== undefined) this.intensity = options.intensity;
    if (options.softness !== undefined) this.softness = options.softness;
    if (options.maxDistance !== undefined) this.maxDistance = options.maxDistance;
    if (options.mapSize !== undefined) this.mapSize = options.mapSize;
  }

  /** Current settings. */
  get options(): Required<SunShadowOptions> {
    return { enabled: this._enabled, intensity: this._intensity, softness: this._softness, maxDistance: this._maxDistance, mapSize: this._mapSize };
  }

  /** Shadows were drawn in the last frame (enabled, lighting on, sun up, a building in range). */
  get active(): boolean {
    return this.strength > 0;
  }

  /** Meters per shadow map texel in the last frame (0 while inactive): how sharp shadows can be. */
  get texelSize(): number {
    return this.active && this.fit ? this.fit.texel : 0;
  }

  /** GPU bytes of the shadow map (allocated the first time shadows are drawn). */
  get bytes(): number {
    return this.target ? this.target.width * this.target.height * 4 : 0;
  }

  /**
   * @internal Fits the map to the frame's view and casters and works out the strength (cheap,
   * every frame). Returns true when the map has to be drawn again before it is used.
   */
  update(frame: SunShadowFrame): boolean {
    let strength = 0;
    let fit: ShadowFit | null = null;
    if (this._enabled && frame.lighting && frame.casters.length > 0) {
      strength = this._intensity * sunShadowStrength(frame.sun.dot(frame.up));
      if (strength > 0) fit = fitSunShadow(frame.sun, frame.origin, frame.up, frame.casters, frame.view, { mapSize: this._mapSize, maxDistance: this._maxDistance });
    }
    if (!fit) strength = 0;
    this.strength = strength;
    if (fit && !sameFit(fit, this.fit)) this.placeCamera(fit);
    this.fit = fit;
    return strength > 0 && !sameFit(fit, this.drawnFit);
  }

  /**
   * @internal Writes this viewer's shadow inputs into the shared uniforms. Call before every
   * render of the viewer's scene (other viewers on the page share them).
   */
  bind(): void {
    sunShadowFactor();
    // Only a map drawn for the current fit (until `render` draws it, the frame is without shadows).
    const active = this.strength > 0 && this.target !== null && this.fit !== null && sameFit(this.fit, this.drawnFit);
    S.strength.value = active ? this.strength : 0;
    // A viewer always binds a map of its own, which its renderer created.
    mapNode.value = active ? this.target!.depthTexture : this.idleTarget().depthTexture;
    if (!active || !this.fit) return;
    shadowMatrix.copy(this.matrix);
    lightDirection.copy(this.fit.z);
    S.texel.value = 1 / this._mapSize;
    S.softness.value = this._softness;
    S.texelMeters.value = this.fit.texel;
    const range = this.fit.top - this.fit.bottom;
    S.bias.value = ((this.renderer.reversedDepthBuffer ? 1 : -1) * DEPTH_BIAS_M) / range;
  }

  /**
   * @internal Draws the shadow map from `casters` (the building tree) when shadows are active
   * and the map is out of date: the fit moved (camera, sun, buildings) or the content changed
   * (`invalidate`). Then binds.
   */
  render(casters: Object3D): void {
    if (this.disposed || this.strength <= 0 || !this.fit) {
      this.bind();
      return;
    }
    if (sameFit(this.fit, this.drawnFit) && this.target) {
      this.bind();
      return;
    }
    const r = this.renderer;
    const target = this.mapTarget();
    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    const prevFunction = r.getRenderObjectFunction();
    const prevAutoClear = r.autoClear;
    r.setRenderTarget(target);
    r.setMRT(null);
    r.autoClear = true;
    r.setRenderObjectFunction((object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
      if (!casts(object, material)) return;
      r.renderObject(object, scene, camera, geometry, this.depthMaterialFor(material), group, lightsNode, clippingContext, passId);
    });
    try {
      // The building tree as the scene: only it is traversed (no sky, no statistics hooks).
      r.render(casters, this.camera);
    } finally {
      r.setRenderObjectFunction(prevFunction);
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMRT);
      r.autoClear = prevAutoClear;
    }
    this.drawnFit = this.fit;
    this.bind();
  }

  /**
   * Draws the shadow map again before the next frame. The viewer does this when buildings change
   * through their entities (visibility, styles, moves, models, levels); call it after moving or
   * changing building meshes directly.
   */
  invalidate(): void {
    this.drawnFit = null;
  }

  /** Frees the shadow map (it is created again when shadows are next drawn). */
  release(): void {
    this.target?.dispose();
    this.target = null;
    this.drawnFit = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.idle?.dispose();
    this.idle = null;
    for (const m of this.depthMaterials.values()) m.dispose();
    this.depthMaterials.clear();

  }

  /** The shadow map at the current size (a new target when the size changed). */
  private mapTarget(): RenderTarget {
    const size = this._mapSize;
    if (this.target && this.target.width === size) return this.target;
    this.target?.dispose();
    this.target = shadowTarget(size, this.renderer.reversedDepthBuffer === true);
    this.drawnFit = null;
    return this.target;
  }

  /** The empty map, cleared once so the renderer has created it before it is bound. */
  private idleTarget(): RenderTarget {
    if (this.idle) return this.idle;
    this.idle = shadowTarget(1, this.renderer.reversedDepthBuffer === true);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.idle);
    r.clear();
    r.setRenderTarget(prev);
    return this.idle;
  }

  /** One depth material per vertex program: the plain one, or one carrying a material's `positionNode`. */
  private depthMaterialFor(material: Material): MeshBasicNodeMaterial {
    const positionNode = (material as { positionNode?: TSLNode }).positionNode ?? null;
    let m = this.depthMaterials.get(positionNode);
    if (!m) {
      m = new MeshBasicNodeMaterial();
      m.name = 'SunShadowDepth';
      // Both faces: thin parts (roofs and slabs modeled as planes) cast too; the normal offset keeps lit faces clean.
      m.side = DoubleSide;
      m.colorWrite = false;
      m.fog = false;
      if (positionNode) m.positionNode = positionNode;
      this.depthMaterials.set(positionNode, m);
    }
    return m;
  }

  /** Shadow camera and matrix for a new fit. */
  private placeCamera(fit: ShadowFit): void {
    const r = this.renderer;
    const cam = this.camera;
    cam.left = -fit.halfSize;
    cam.right = fit.halfSize;
    cam.top = fit.halfSize;
    cam.bottom = -fit.halfSize;
    cam.near = 0;
    cam.far = fit.top - fit.bottom;
    // The renderer would otherwise switch these (and the projection) at render time, after the matrix below was taken.
    cam.coordinateSystem = r.coordinateSystem;
    (cam as unknown as { _reversedDepth: boolean })._reversedDepth = r.reversedDepthBuffer === true;
    cam.updateProjectionMatrix();
    shadowCameraMatrix(fit, cam.matrix);
    cam.matrixWorldNeedsUpdate = true;
    cam.updateMatrixWorld(true);
    // Clip space → (u, v, depth): x, y from [-1, 1] to [0, 1]; depth is [0, 1] already with
    // WebGPU's convention or reversed depth, [-1, 1] with WebGL's.
    const zFromClip = cam.coordinateSystem === WebGPUCoordinateSystem || r.reversedDepthBuffer ? [1, 0] : [0.5, 0.5];
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, zFromClip[0], zFromClip[1], 0, 0, 0, 1);
    this.matrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  }
}

export type { ShadowCaster, ShadowFit, ShadowView } from './shadowFit';
