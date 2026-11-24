/**
 * Shader parts of the volumetric clouds (`VolumetricClouds`): the TSL graphs of the weather
 * bake, the cloud shadow map, the trace, the temporal resolve and the compose, and what they
 * share (layer intersection, weather lookup, density, light march, phase). Node construction
 * only: each function reads the uniforms and textures it is given and keeps no state. The
 * render targets, the frame state and when to draw what are in `VolumetricClouds`, which also
 * describes the technique and the precision rules.
 */
import { Matrix3, Matrix4, Vector2, Vector3, type Data3DTexture } from 'three';
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
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { aerialScatteringAlong, atmosphereUniforms } from '../atmosphere/AtmosphereNodes';
import type { TSLNode } from '../core/tsl';
import { CLOUD_SCALES, CLOUD_SHADOW_RANGE } from './volumetricCloudMath';

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
/** Steps through the layer per cloud shadow texel. */
const SHADOW_STEPS = 12;

function un(value: number | Vector2 | Vector3 | Matrix3 | Matrix4): TSLNode {
  return uniform(value as never) as TSLNode;
}

/** clamp() for integer vectors (the typed overloads only take float vectors). */
function clampI(v: TSLNode, lo: TSLNode, hi: TSLNode): TSLNode {
  return clamp(v, lo, hi);
}

/** Henyey-Greenstein phase times 4π (isotropic = 1). */
function hg(c: TSLNode, g: number): TSLNode {
  return float(1 - g * g).div(pow(max(float(1 + g * g).sub(c.mul(2 * g)), 1e-4), 1.5));
}

/** Two lobes (forward silver lining, soft back scatter), anisotropy scaled by k (multiple-scattering octaves). */
function cloudPhase(c: TSLNode, k: number): TSLNode {
  return mix(hg(c, -0.25 * k), hg(c, 0.8 * k), 0.6);
}

/** The uniforms of one volumetric cloud instance (nothing here is shared between viewers). */
export function createCloudUniforms() {
  return {
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
}

export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

/** Uniforms of a point the cloud positions are relative to (the camera, the shadow map center). */
export interface Origin {
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

export function makeOrigin(): Origin {
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

/** What the march-related shader parts read besides an origin. */
export interface CloudShaderInputs {
  u: CloudUniforms;
  /** The noise volume (RGBA: Perlin-Worley shape, three Worley octaves). */
  noise: Data3DTexture;
  /** Texture node of the weather map. */
  weather: TSLNode;
  /** Depth buffer convention of the renderer (reversed: the sky is at 0). */
  reversedDepth: boolean;
  /** Steps of the view march and of the light march (GPU tier). */
  steps: number;
  lightSteps: number;
  /** Weather map texels per side (GPU tier). */
  weatherSize: number;
}

// -----------------------------------------------------------------------------
// Shared parts

/** Scene depth sample → view depth in km (`SKY_KM` where nothing was drawn). */
function sceneKm(u: CloudUniforms, reversed: boolean, depth: TSLNode): TSLNode {
  const sky = reversed ? depth.lessThanEqual(0) : depth.greaterThanEqual(1);
  const viewZ = perspectiveDepthToViewZ(depth, u.near, u.far);
  return select(sky, float(SKY_KM), viewZ.negate().mul(0.001));
}

/** World direction of the view ray through a picture point (uv, v = 0 at the top). */
function rayDirection(u: CloudUniforms, at: TSLNode): { world: TSLNode; view: TSLNode } {
  const ndc = vec2(at.x.mul(2).sub(1), float(1).sub(at.y.mul(2)));
  const p = u.invProjection.mul(vec4(ndc, 0.5, 1));
  const view = normalize(p.xyz.div(p.w));
  return { world: normalize(u.cameraRotation.mul(view)), view };
}

/** Height above the ellipsoid of a point `v` (world offset) from an origin: v·up and v·v given. */
function heightAt(o: Origin, vu: TSLNode, vv: TSLNode): TSLNode {
  const q = vu.mul(o.r0).mul(2).add(vv);
  return o.height.add(q.div(sqrt(o.r0sq.add(q)).add(o.r0)));
}

/** Where a ray from height h0 (r0 = R + h0) with vertical cosine mu crosses height hs: (near, far, hit). */
function roots(u: CloudUniforms, h0: TSLNode, r0: TSLNode, mu: TSLNode, hs: TSLNode): TSLNode {
  const b = r0.mul(mu);
  const c = h0.sub(hs).mul(h0.add(hs).add(u.radius.mul(2)));
  const d = b.mul(b).sub(c);
  const s = sqrt(max(d, 0));
  const q = b.add(select(b.greaterThanEqual(0), s, s.negate())).negate();
  const other = c.div(select(abs(q).greaterThan(1e-3), q, float(1e-3)));
  return vec3(min(q, other), max(q, other), select(d.greaterThanEqual(0), float(1), float(0)));
}

/** The nearest stretch of a ray inside the cloud layer: (start, end), end < start when it misses (see `cloudInterval`). */
function interval(u: CloudUniforms, h0: TSLNode, r0: TSLNode, mu: TSLNode): TSLNode {
  const top = u.bottom.add(u.thickness);
  const outer = roots(u, h0, r0, mu, top);
  const inner = roots(u, h0, r0, mu, u.bottom);
  const ground = roots(u, h0, r0, mu, float(0));
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
function weatherAt(c: CloudShaderInputs, enu: TSLNode): TSLNode {
  const u = c.u;
  const at = vec2(enu.x.mul(u.weatherInv).add(0.5), float(0.5).sub(enu.y.mul(u.weatherInv)));
  const w = c.weather.sample(at).level(0);
  const border = min(min(at.x, at.y), min(at.x.oneMinus(), at.y.oneMinus()));
  return vec2(w.r.mul(smoothstep(0, 0.08, border)), w.g);
}

/**
 * Cloud density 0–1 at `v` (world offset from the origin), height fraction hf in the layer,
 * weather w. `footprint`: meters a history pixel covers there; noise octaves finer than about
 * two pixels fade to their mean (the volume has no mipmaps: they would sparkle), and the edge
 * detail is skipped entirely beyond its reach. null: no detail (light and shadow rays).
 */
function densityAt(c: CloudShaderInputs, o: Origin, v: TSLNode, hf: TSLNode, w: TSLNode, footprint: TSLNode | null): TSLNode {
  const u = c.u;
  const noise = c.noise;
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
function lightDepth(c: CloudShaderInputs, o: Origin, v: TSLNode, enuV: TSLNode, enuSun: TSLNode): TSLNode {
  const u = c.u;
  const tau = float(0).toVar();
  Loop(c.lightSteps, ({ i }: { i: TSLNode }) => {
    const fi = float(i);
    const seg = u.lightBase.mul(pow(1.9, fi));
    const mid = u.lightBase.mul(pow(1.9, fi.add(1)).sub(1).div(0.9)).sub(seg.mul(0.5));
    const vl = v.add(u.sun.mul(mid));
    const hl = heightAt(o, dot(vl, o.up), dot(vl, vl));
    const hfl = hl.sub(u.bottom).div(u.thickness);
    If(hfl.greaterThanEqual(0).and(hfl.lessThanEqual(1)), () => {
      const wl = weatherAt(c, o.enu.add(enuV).add(enuSun.mul(mid)));
      If(wl.x.greaterThan(0.002), () => {
        tau.addAssign(densityAt(c, o, vl, hfl, wl, null).mul(seg));
      });
    });
  });
  return tau.mul(u.density.mul(EXTINCTION));
}

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

/**
 * How much two scene depths (km, `SKY_KM` for the sky) belong to the same surface: 1 for
 * sky and sky, ~0 for sky and something, falling off with the relative difference otherwise.
 */
function sceneWeight(a: TSLNode, b: TSLNode): TSLNode {
  const skyA = a.greaterThan(SKY_KM * 0.5);
  const skyB = b.greaterThan(SKY_KM * 0.5);
  const rel = exp(abs(a.sub(b)).div(min(a, b).mul(0.06).add(0.003)).negate());
  return select(skyA.and(skyB), float(1), select(skyA.or(skyB), float(0.001), rel));
}

// -----------------------------------------------------------------------------
// Passes

/**
 * Weather map: presence (r), tops (g), the shell's density (b, diagnostics). `densityNode` is
 * the cloud shell's density at a direction and footprint (`CloudLayer.densityNode`).
 */
export function weatherBakeNode(c: CloudShaderInputs, densityNode: (dir: TSLNode, footprint: TSLNode) => TSLNode): TSLNode {
  const u = c.u;
  const noise = c.noise;
  return Fn(() => {
    const t = uv();
    const x = t.x.sub(0.5).mul(u.weatherExtent);
    const y = float(0.5).sub(t.y).mul(u.weatherExtent);
    const local = u.anchorEast.mul(x).add(u.anchorNorth.mul(y));
    const invR = float(1).div(u.radius);
    const dir = normalize(u.anchorDir.add(local.mul(invR)));
    // The cloud shell's density here: the weather follows the clouds seen from space.
    const macro = densityNode(dir, u.weatherExtent.mul(1 / c.weatherSize).mul(invR));
    const cellNoise = texture3D(noise, u.bakeCells.add(local.mul(1 / CLOUD_SCALES.cells)), float(0));
    // A coarse map (camera high up) drops cells smaller than two of its texels.
    const texel = u.weatherExtent.mul(1 / c.weatherSize);
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
}

/** Cloud shadow map: sunlight transmittance through the layer along the sun's rays (`o`: the map's center). */
export function cloudShadowNode(c: CloudShaderInputs, o: Origin): TSLNode {
  const u = c.u;
  return Fn(() => {
    const t = uv();
    const q = u.shadowE1.mul(t.x.sub(0.5).mul(u.shadowWidth)).add(u.shadowE2.mul(t.y.sub(0.5).mul(u.shadowWidth)));
    const hq = heightAt(o, dot(q, o.up), dot(q, q));
    const r0q = u.radius.add(hq);
    // Vertical at q: the direction from the local center of curvature.
    const radial = normalize(o.up.mul(o.r0).add(q));
    const mu = dot(u.sun, radial);
    const span = interval(u, hq, r0q, mu);
    const tau = float(0).toVar();
    If(span.y.greaterThan(span.x), () => {
      const len = min(span.y.sub(span.x), u.thickness.mul(6));
      const ds = len.div(SHADOW_STEPS);
      const enuQ = u.enuRot.mul(q).xy;
      const enuSun = u.enuRot.mul(u.sun).xy;
      Loop(SHADOW_STEPS, ({ i }: { i: TSLNode }) => {
        const s = span.x.add(float(i).add(0.5).mul(ds));
        const v = q.add(u.sun.mul(s));
        const h = heightAt(o, dot(v, o.up), dot(v, v));
        const hf = h.sub(u.bottom).div(u.thickness);
        const w = weatherAt(c, o.enu.add(enuQ).add(enuSun.mul(s)));
        If(w.x.greaterThan(0.002).and(hf.greaterThanEqual(0)).and(hf.lessThanEqual(1)), () => {
          tau.addAssign(densityAt(c, o, v, hf, w, null).mul(ds));
        });
      });
    });
    const T: TSLNode = exp(tau.mul(u.density.mul(EXTINCTION)).negate());
    return vec4(T, T, T, 1);
  })();
}

/**
 * The ray march of a quarter of the history's pixels (MRT: color = (radiance, opacity), meta =
 * (cloud km, scene km)); `o` is the camera, `depth` the scene depth texture node.
 */
export function traceNodes(c: CloudShaderInputs, o: Origin, depth: TSLNode): { colorNode: TSLNode; outputNode: TSLNode } {
  const u = c.u;
  const colorOut = property('vec4');
  const metaOut = property('vec4');
  const colorNode = Fn(() => {
    const px = floor(screenCoordinate.xy);
    const at = px.mul(2).add(u.slot).add(0.5).div(u.historySize);
    const { world: dir, view } = rayDirection(u, at);
    // Scene distance along the ray (the clouds stop at what is drawn).
    const z = sceneKm(u, c.reversedDepth, depth.sample(at).r);
    const tScene = select(z.greaterThanEqual(SKY_KM * 0.5), float(1e12), z.mul(1000).div(max(view.z.negate(), 1e-4)));
    const mu = dot(dir, o.up);
    const span = interval(u, o.height, o.r0, mu);
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
      Loop(c.steps, () => {
        If(t.greaterThanEqual(end).or(T.lessThan(0.01)), () => {
          Break();
        });
        const v = dir.mul(t);
        const h = heightAt(o, t.mul(mu), t.mul(t));
        const hf = h.sub(u.bottom).div(u.thickness);
        const fine = min(max(u.minStep, t.mul(u.cone)), capStep);
        const stride = min(max(fine.mul(3), u.minStep.add(t.sub(start).mul(u.growth))), capStep.mul(2));
        const w = weatherAt(c, o.enu.add(enuDir.mul(t)));
        const dens = float(0).toVar();
        If(w.x.greaterThan(0.002).and(hf.greaterThanEqual(0)).and(hf.lessThanEqual(1)), () => {
          // No detail while striding: a hit test (erosion only removes density), and cheaper.
          dens.assign(densityAt(c, o, v, hf, w, select(striding.greaterThan(0.5), float(1e6), t.mul(u.pixelAngle))));
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
            const tau = lightDepth(c, o, v, enuDir.mul(t), enuSun);
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
  return { colorNode, outputNode: outputStruct(colorOut, metaOut) };
}

/** Texture nodes the resolve reads: this frame's trace, the previous history, the scene depth. */
export interface ResolveSources {
  traceColor: TSLNode;
  traceMeta: TSLNode;
  prevColor: TSLNode;
  prevMeta: TSLNode;
  depth: TSLNode;
}

/** Temporal resolve into the history (MRT: color, meta = (cloud km, scene km)). */
export function resolveNodes(c: Pick<CloudShaderInputs, 'u' | 'reversedDepth'>, t: ResolveSources): { colorNode: TSLNode; outputNode: TSLNode } {
  const u = c.u;
  const colorOut = property('vec4');
  const metaOut = property('vec4');
  const colorNode = Fn(() => {
    const px = floor(screenCoordinate.xy);
    const at = px.add(0.5).div(u.historySize);
    const tc = floor(px.mul(0.5));
    const sub = px.sub(tc.mul(2));
    const fresh = sub.x.equal(u.slot.x).and(sub.y.equal(u.slot.y));
    const tcI = ivec2(tc);
    const maxT = ivec2(u.traceSize.sub(1));
    const cur = t.traceColor.load(tcI);
    const curMeta = t.traceMeta.load(tcI);
    const z = sceneKm(u, c.reversedDepth, t.depth.sample(at).r);
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
        const cq = t.traceColor.load(q);
        const mq = t.traceMeta.load(q);
        lo.assign(min(lo, cq));
        hi.assign(max(hi, cq));
        const off = vec2(q).mul(2).add(u.slot).sub(px);
        const w = exp(dot(off, off).mul(-0.35)).mul(sceneWeight(z, mq.y)).add(1e-6);
        est.addAssign(cq.mul(w));
        // The distance the clouds move at: their own, mostly (cloud-free samples guess it).
        const wd = w.mul(cq.a.add(0.05));
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
      const { world: dir } = rayDirection(u, at);
      const p = dir.mul(spatialD.mul(1000)).add(u.cameraDelta).sub(u.windDelta);
      const clip = u.previousProjection.mul(vec4(u.previousViewRotation.mul(p), 1));
      const ndc = clip.xy.div(clip.w);
      const prevAt = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
      const inside = clip.w.greaterThan(0).and(prevAt.x.greaterThanEqual(0)).and(prevAt.y.greaterThanEqual(0)).and(prevAt.x.lessThanEqual(1)).and(prevAt.y.lessThanEqual(1));
      const h = t.prevColor.sample(prevAt).level(0);
      const hm = t.prevMeta.sample(prevAt).level(0);
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
  return { colorNode, outputNode: outputStruct(colorOut, metaOut) };
}

/**
 * Compose (the effect's `build`): the history upsampled with scene-depth weights over the scene
 * color `input`, so cloud edges stay off what stands in front of them.
 */
export function composeNode(c: Pick<CloudShaderInputs, 'u' | 'reversedDepth'>, input: TSLNode, sceneDepth: TSLNode, histColor: TSLNode, histMeta: TSLNode): TSLNode {
  const u = c.u;
  return Fn(() => {
    const z = sceneKm(u, c.reversedDepth, sceneDepth.sample(screenUV).x);
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
        const w = wb.mul(sceneWeight(z, histMeta.load(q).y)).add(wb.mul(1e-5));
        sum.addAssign(histColor.load(q).mul(w));
        wSum.addAssign(w);
      }
    }
    const cloud = sum.div(max(wSum, 1e-8)).mul(u.fade);
    return vec4(input.rgb.mul(cloud.a.oneMinus()).add(cloud.rgb), input.a);
  })();
}
