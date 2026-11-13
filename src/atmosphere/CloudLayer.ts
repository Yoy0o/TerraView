/**
 * Animated cloud layer: a shell above the ellipsoid drawn over the imagery.
 *
 * Cloud density is either procedural (fractal noise sampled on the unit
 * sphere, so there is no seam or pole pinch, and no texture to download) or
 * read from an equirectangular cloud map. Clouds drift east by turning the
 * sample direction about the polar axis; the procedural mode blends two
 * layers drifting at different speeds so the shapes also slowly change.
 *
 * The layer is a view-from-above effect: it fades out as the camera comes
 * down (`fadeHeights`) and is skipped entirely once invisible. With sun
 * lighting on, the night side darkens with the same sun direction as the
 * globe. Shading is TSL only (WebGPU and the WebGL 2 fallback).
 */
import { BufferAttribute, BufferGeometry, ClampToEdgeWrapping, FrontSide, Mesh, RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  fwidth,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Ellipsoid } from '../core/Ellipsoid';
import { smoothstep as smoothstepCpu } from '../core/math';
import { atmosphereUniforms, type TSLNode } from './AtmosphereNodes';

export interface CloudOptions {
  /** Show the layer (default false: opt-in). */
  visible?: boolean;
  /** Share of the sky covered, 0–1 (default 0.5). With a cloud map, 0.5 shows it as-is. */
  coverage?: number;
  /** Opacity of the thickest clouds, 0–1 (default 0.9). */
  opacity?: number;
  /** Eastward drift in degrees of longitude per second (default 0.5; negative drifts west, 0 stops). */
  speed?: number;
  /** Height of the layer above the ellipsoid in meters (default 10,000). */
  height?: number;
  /**
   * Camera heights in meters [hidden below, fully shown above]
   * (default [60 km, 500 km]): the layer fades out on the way down.
   */
  fadeHeights?: [number, number];
  /**
   * Equirectangular cloud map (longitude -180° at the left edge, north up).
   * Density is the brightest channel times alpha, so both grey JPEGs and
   * white PNGs with alpha work. null switches back to procedural clouds.
   */
  textureUrl?: string | null;
}

export const CLOUD_DEFAULTS: Required<CloudOptions> = {
  visible: false,
  coverage: 0.5,
  opacity: 0.9,
  speed: 0.5,
  height: 10_000,
  fadeHeights: [60_000, 500_000],
  textureUrl: null,
};

/** Clamps and validates options; invalid values are dropped (the current value is kept). */
export function normalizeCloudOptions(options: CloudOptions): CloudOptions {
  const out: CloudOptions = {};
  if (typeof options.visible === 'boolean') out.visible = options.visible;
  if (isNum(options.coverage)) out.coverage = Math.min(1, Math.max(0, options.coverage));
  if (isNum(options.opacity)) out.opacity = Math.min(1, Math.max(0, options.opacity));
  if (isNum(options.speed)) out.speed = Math.max(-90, Math.min(90, options.speed));
  if (isNum(options.height)) out.height = Math.max(0, Math.min(100_000, options.height));
  const f = options.fadeHeights;
  if (Array.isArray(f) && f.length === 2 && isNum(f[0]) && isNum(f[1]) && f[0] >= 0 && f[1] > f[0]) out.fadeHeights = [f[0], f[1]];
  if (options.textureUrl === null || (typeof options.textureUrl === 'string' && options.textureUrl.trim() !== '')) {
    out.textureUrl = options.textureUrl === null ? null : options.textureUrl.trim();
  }
  return out;
}

/** Visibility factor (0–1) for a camera height in meters. */
export function cloudFade(cameraHeight: number, fadeHeights: [number, number]): number {
  return smoothstepCpu(fadeHeights[0], fadeHeights[1], cameraHeight);
}

/** Noise features per unit radius of the base layer. */
const NOISE_SCALE = 2.6;

export class CloudLayer {
  readonly mesh: Mesh<BufferGeometry, MeshBasicNodeMaterial>;
  private readonly options: Required<CloudOptions> = { ...CLOUD_DEFAULTS, fadeHeights: [...CLOUD_DEFAULTS.fadeHeights] };
  private readonly uniforms = {
    /** Accumulated drift in radians, wrapped to [0, 2π) on the CPU. */
    drift: uniform(0),
    coverage: uniform(CLOUD_DEFAULTS.coverage),
    /** opacity × height fade. */
    alpha: uniform(CLOUD_DEFAULTS.opacity),
  };
  private map: Texture | null = null;
  private loadedUrl: string | null = null;
  private fade = 1;
  /** @internal Called after the options changed or a cloud map arrived (the viewer draws at the full frame rate). */
  onChange: (() => void) | null = null;

  constructor(private readonly ellipsoid: Ellipsoid) {
    const material = new MeshBasicNodeMaterial();
    material.name = 'CloudLayer';
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    // Outward faces only: from below the shell (where it is faded out anyway) nothing is drawn.
    material.side = FrontSide;
    material.fog = false;
    this.mesh = new Mesh(createShellGeometry(128, 64), material);
    this.mesh.name = 'Clouds';
    // Over the imagery, 3D Tiles and buildings (all below the shell); drawn after other transparent objects.
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.buildMaterial();
    this.applyHeight();
  }

  get visible(): boolean {
    return this.options.visible;
  }

  set visible(v: boolean) {
    this.set({ visible: v });
  }

  /** Current settings (a copy). */
  getOptions(): Required<CloudOptions> {
    return { ...this.options, fadeHeights: [...this.options.fadeHeights] };
  }

  /** Updates any subset of the options; invalid values are ignored. */
  set(options: CloudOptions): void {
    const o = normalizeCloudOptions(options);
    Object.assign(this.options, o);
    if (o.fadeHeights) this.options.fadeHeights = [...o.fadeHeights];
    if (o.height !== undefined) this.applyHeight();
    if (o.coverage !== undefined) this.uniforms.coverage.value = o.coverage;
    if (o.textureUrl !== undefined && o.textureUrl !== this.loadedUrl) this.loadTexture(o.textureUrl);
    this.onChange?.();
  }

  /** Advances the drift and applies the height fade; call once per frame. */
  update(dt: number, cameraHeight: number): void {
    const o = this.options;
    this.fade = cloudFade(cameraHeight, o.fadeHeights);
    const alpha = o.opacity * this.fade;
    this.mesh.visible = o.visible && alpha > 0.002;
    this.uniforms.alpha.value = alpha;
    if (o.visible && Number.isFinite(dt)) {
      const twoPi = Math.PI * 2;
      this.uniforms.drift.value = (((this.uniforms.drift.value + o.speed * (Math.PI / 180) * dt) % twoPi) + twoPi) % twoPi;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.map?.dispose();
  }

  private applyHeight(): void {
    const r = this.ellipsoid.radii;
    const h = this.options.height;
    this.mesh.scale.set(r.x + h, r.y + h, r.z + h);
    this.mesh.updateMatrixWorld();
  }

  private loadTexture(url: string | null): void {
    this.loadedUrl = url;
    if (!url) {
      this.map?.dispose();
      this.map = null;
      this.buildMaterial();
      return;
    }
    new TextureLoader().load(
      url,
      (tex) => {
        if (this.loadedUrl !== url) return tex.dispose();
        tex.wrapS = RepeatWrapping;
        tex.wrapT = ClampToEdgeWrapping;
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = 4;
        this.map?.dispose();
        this.map = tex;
        this.buildMaterial();
        this.onChange?.();
      },
      undefined,
      () => {
        if (this.loadedUrl !== url) return;
        console.warn(`[CloudLayer] could not load cloud map ${url}; using procedural clouds`);
        this.loadedUrl = null;
        this.options.textureUrl = null;
      },
    );
  }

  /** (Re)builds the node graph: the procedural and the texture modes differ. */
  private buildMaterial(): void {
    const u = this.uniforms;
    const material = this.mesh.material;
    const dir = attribute('position', 'vec3');
    const map = this.map;

    const density = Fn(() => {
      if (map) {
        // Drift east = sample further west; the map repeats in u.
        const uv = attribute('uv', 'vec2');
        const c = texture(map, vec2(uv.x.sub(u.drift.div(Math.PI * 2)), uv.y));
        const raw = max(max(c.r, c.g), c.b).mul(c.a);
        return clamp(raw.mul(u.coverage.mul(2)), 0, 1);
      }
      // Size of one pixel on the unit sphere: octaves finer than ~2 px are faded out (see bandLimitedFbm).
      const footprint = length(fwidth(dir));
      // Two layers turning at different rates: drifting shapes that slowly change.
      const n1 = bandLimitedFbm(rotateZ(dir, u.drift).mul(NOISE_SCALE), footprint.mul(NOISE_SCALE), 6, 2.2, 0.55);
      const n2 = bandLimitedFbm(
        rotateZ(dir, u.drift.mul(1.6).add(1.7)).mul(NOISE_SCALE * 3.4).add(vec3(5.2, 1.3, 7.7)),
        footprint.mul(NOISE_SCALE * 3.4),
        4,
        2.1,
        0.5,
      );
      // Climate bands (z = sin latitude): clear subtropics near 25°, cloudier equator and high latitudes.
      const z = dir.z;
      const subtropic = z.abs().sub(0.42).div(0.14);
      const band = exp(subtropic.mul(subtropic).negate())
        .mul(-0.22)
        .add(exp(z.div(0.1).pow(2).negate()).mul(0.1))
        .add(smoothstep(0.55, 0.8, z.abs()).mul(0.08));
      const n = n1.add(n2.mul(0.45)).add(band);
      // coverage 0 → nothing passes, 1 → almost everything; thin edges fade out softly.
      const threshold = mix(float(0.5), float(-0.6), u.coverage);
      return smoothstep(threshold, threshold.add(0.55), n).pow(1.4);
    })();

    // Night side dims with the real sun when lighting is on (the same direction the globe uses).
    const a = atmosphereUniforms;
    const sunCos = dot(normalize(dir), a.lightDirection);
    const day = mix(float(1), smoothstep(-0.12, 0.22, sunCos), a.lightingEnabled);
    const dusk = mix(vec3(1, 1, 1), vec3(1, 0.78, 0.6), smoothstep(0.35, 0, sunCos).mul(a.lightingEnabled));
    material.colorNode = mix(vec3(0.01, 0.012, 0.018), vec3(1, 0.99, 0.97).mul(dusk), day);
    // Unlit clouds would read as grey patches over the dark night side: thin them out there.
    material.opacityNode = density.mul(u.alpha).mul(mix(float(0.3), float(1), day));
    material.needsUpdate = true;
  }
}

/**
 * Noise cycles per pixel over which an octave fades out: full weight at
 * ≤ 1/4 (≥ 4 px per cycle), gone at 1/2 (2 px per cycle, the Nyquist limit).
 */
export const OCTAVE_FADE: [number, number] = [0.25, 0.5];

/** Weight of a noise octave (CPU mirror of the shader rule, for tests and tuning). */
export function octaveWeight(cyclesPerPixel: number): number {
  return 1 - smoothstepCpu(OCTAVE_FADE[0], OCTAVE_FADE[1], cyclesPerPixel);
}

/**
 * Fractal Perlin noise whose octaves fade out as they approach the pixel
 * size: `footprint` is how far the sample position moves per pixel. Without
 * this, the finest octaves of a globe-sized cloud layer are only ~2 px per
 * cycle at a global view, and the thresholded edges shimmer and crawl
 * whenever the image scales (zooming) or the clouds drift. Perlin noise
 * averages zero, so dropping an octave keeps the coverage unchanged.
 */
function bandLimitedFbm(p: TSLNode, footprint: TSLNode, octaves: number, lacunarity: number, gain: number): TSLNode {
  let sum: TSLNode = float(0);
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    const weight = float(1).sub(smoothstep(OCTAVE_FADE[0], OCTAVE_FADE[1], footprint.mul(frequency)));
    sum = sum.add(mx_noise_float(p.mul(frequency)).mul(amplitude).mul(weight));
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum;
}

/** Rotates a direction about +Z by -angle (sampling further west = clouds moving east). */
function rotateZ(p: TSLNode, angle: TSLNode): TSLNode {
  const c = cos(angle);
  const s = sin(angle);
  return vec3(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)), p.z);
}

/**
 * Unit sphere with +Z at the north pole, longitude/latitude grid, faces
 * pointing outward. `uv` is equirectangular (u = 0 at longitude -180°, v = 1
 * at the north pole); the seam column is duplicated so u runs 0 → 1.
 */
export function createShellGeometry(lonSegments: number, latSegments: number): BufferGeometry {
  const cols = lonSegments + 1;
  const rows = latSegments + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    const v = j / latSegments;
    const lat = (v - 0.5) * Math.PI;
    for (let i = 0; i < cols; i++) {
      const uu = i / lonSegments;
      const lon = (uu - 0.5) * Math.PI * 2;
      const k = j * cols + i;
      positions[k * 3] = Math.cos(lat) * Math.cos(lon);
      positions[k * 3 + 1] = Math.cos(lat) * Math.sin(lon);
      positions[k * 3 + 2] = Math.sin(lat);
      uvs[k * 2] = uu;
      uvs[k * 2 + 1] = v;
    }
  }
  const indices = new Uint32Array(lonSegments * latSegments * 6);
  let n = 0;
  for (let j = 0; j < latSegments; j++) {
    for (let i = 0; i < lonSegments; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      // East then north is counter-clockwise seen from outside.
      indices.set([a, b, c, a, c, d], n);
      n += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
