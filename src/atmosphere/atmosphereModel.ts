/**
 * CPU version of the atmosphere model in `AtmosphereNodes.ts` (M3.5): the
 * same constants and formulas in float64 JavaScript, so the lights of
 * buildings and 3D Tiles can follow the sky the globe is drawn with.
 *
 * - `sunTransmittance`: the light reaching a point from the sun (color of the
 *   directional light), the same as the TSL `sunTransmittanceAt`.
 * - `skyRadiance`: single-scattered sky light along a view ray, the same
 *   integral as the TSL `integrateScattering` (without the stylized halo).
 * - `skyLightSH`: sky and ground light around a point projected onto order-2
 *   spherical harmonics for a `LightProbe`.
 *
 * Units: kilometers in "atmosphere space" (ECEF with z scaled by a/b, so the
 * WGS84 ellipsoid is a sphere of radius a). No three.js import: constants are
 * plain numbers, shared with the TSL nodes from here.
 */
import { WGS84_A, WGS84_B } from '../core/geodesy';

export const GROUND_RADIUS_KM = WGS84_A / 1000;
export const ATMOSPHERE_HEIGHT_KM = 80;
export const TOP_RADIUS_KM = GROUND_RADIUS_KM + ATMOSPHERE_HEIGHT_KM;
/** Scale of ECEF z into atmosphere space (a / b). */
export const Z_SCALE = WGS84_A / WGS84_B;

/** Rayleigh scattering coefficients (1/km, linear RGB). */
export const RAYLEIGH_SCATTERING: readonly [number, number, number] = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_SCALE_HEIGHT = 8.0; // km
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.44e-3;
export const MIE_SCALE_HEIGHT = 1.2;
export const MIE_G = 0.8;
export const OZONE_ABSORPTION: readonly [number, number, number] = [0.65e-3, 1.881e-3, 0.085e-3];
export const OZONE_CENTER = 25.0;
export const OZONE_HALF_WIDTH = 15.0;

export type Vec3 = [number, number, number];
type ReadonlyVec3 = readonly [number, number, number];

/**
 * Schüler's approximation of the Chapman grazing-incidence function, times
 * exp(-h): relative optical depth from height h (in scale heights) to space
 * along a direction with zenith cosine `coschi`. Same as the TSL `chapman`.
 */
export function chapman(X: number, h: number, coschi: number): number {
  const c = Math.sqrt(h + X);
  const expH = Math.exp(-h);
  if (coschi >= 0) return (c / (c * coschi + 1)) * expH;
  const sinchi = Math.sqrt(Math.max(1 - coschi * coschi, 0));
  const x0 = sinchi * (h + X);
  const c0 = Math.sqrt(x0);
  const lower = 2 * c0 * Math.exp(Math.min(X - x0, 50)) - (c / (1 - c * coschi)) * expH;
  return Math.max(lower, 0);
}

/** Optical depth (rayleigh, mie, ozone) from height h (km) towards a direction with zenith cosine mu. */
export function sunOpticalDepth(h: number, mu: number): Vec3 {
  const odR = chapman(GROUND_RADIUS_KM / RAYLEIGH_SCALE_HEIGHT, h / RAYLEIGH_SCALE_HEIGHT, mu) * RAYLEIGH_SCALE_HEIGHT;
  const odM = chapman(GROUND_RADIUS_KM / MIE_SCALE_HEIGHT, h / MIE_SCALE_HEIGHT, mu) * MIE_SCALE_HEIGHT;
  // Ozone: column above the point times the Rayleigh air-mass factor.
  const airMass = Math.min(odR / (Math.exp(-h / RAYLEIGH_SCALE_HEIGHT) * RAYLEIGH_SCALE_HEIGHT + 1e-4), 40);
  const odO = Math.min(Math.max((40 - h) / 30, 0), 1) * OZONE_HALF_WIDTH * airMass;
  return [odR, odM, odO];
}

/** Transmittance exp(-extinction · optical depth), per channel. */
export function transmittanceOf(od: ReadonlyVec3, out: Vec3 = [0, 0, 0]): Vec3 {
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(RAYLEIGH_SCATTERING[i] * od[0] + MIE_EXTINCTION * od[1] + OZONE_ABSORPTION[i] * od[2]));
  return out;
}

/** Soft earth-shadow factor for a point at height h (radius r) looking towards the sun (zenith cosine mu). */
export function earthShadow(h: number, r: number, mu: number): number {
  const horizonMu = -Math.sqrt(Math.max(h * (h + 2 * GROUND_RADIUS_KM), 0)) / r;
  return smoothstep(horizonMu - 0.012, horizonMu + 0.004, mu);
}

/**
 * Sunlight reaching a point (atmosphere-space km) from a sun direction
 * (unit vector): per-channel transmittance times the earth's soft shadow, and
 * the sun's zenith cosine there. The CPU twin of the TSL `sunTransmittanceAt`.
 */
export function sunTransmittance(pKm: ReadonlyVec3, sunDir: ReadonlyVec3): { transmittance: Vec3; mu: number } {
  const r = Math.hypot(pKm[0], pKm[1], pKm[2]);
  const h = Math.max(r - GROUND_RADIUS_KM, 0);
  const mu = (pKm[0] * sunDir[0] + pKm[1] * sunDir[1] + pKm[2] * sunDir[2]) / r;
  const t = transmittanceOf(sunOpticalDepth(h, mu));
  const shadow = earthShadow(h, r, mu);
  return { transmittance: [t[0] * shadow, t[1] * shadow, t[2] * shadow], mu };
}

/** Ray/sphere intersection distances [near, far]; near > far when missed. */
export function raySphere(ro: ReadonlyVec3, rd: ReadonlyVec3, radius: number): [number, number] {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - radius * radius;
  const d = b * b - c;
  if (d < 0) return [1e9, -1e9];
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

function rayleighPhase(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

function miePhase(mu: number): number {
  const g = MIE_G;
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  return (k * (1 + mu * mu)) / Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5);
}

export interface ScatteringOptions {
  /** Ray-march steps (the sky shader uses 16, globe tiles 10). */
  steps?: number;
  /** Sun intensity the radiance is scaled by (`atmosphereUniforms.sunIntensity`, default 10). */
  sunIntensity?: number;
  /** Farthest distance along the ray, km (default: to the top of the atmosphere or the ground). */
  maxDistance?: number;
}

/**
 * Single-scattered light along `ro + rd·t` (atmosphere-space km, `rd` unit)
 * towards `ro`, and the transmittance of the path: the CPU twin of the TSL
 * `integrateScattering` with the sun-lit sample rule (`uniformLighting` 0).
 * The ray stops at the ground.
 */
export function skyRadiance(ro: ReadonlyVec3, rd: ReadonlyVec3, sunDir: ReadonlyVec3, options: ScatteringOptions = {}): { radiance: Vec3; transmittance: Vec3 } {
  const steps = options.steps ?? 16;
  const top = raySphere(ro, rd, TOP_RADIUS_KM);
  const tStart = Math.max(top[0], 0);
  let tEnd = Math.min(top[1], options.maxDistance ?? Infinity);
  const ground = raySphere(ro, rd, GROUND_RADIUS_KM);
  if (ground[0] <= ground[1] && ground[0] > 0) tEnd = Math.min(tEnd, ground[0]);
  const radiance: Vec3 = [0, 0, 0];
  const odView: Vec3 = [0, 0, 0];
  if (!(tEnd > tStart)) return { radiance, transmittance: [1, 1, 1] };

  const dt = (tEnd - tStart) / steps;
  const sumR: Vec3 = [0, 0, 0];
  const sumM: Vec3 = [0, 0, 0];
  const odSample: Vec3 = [0, 0, 0];
  const T: Vec3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = tStart + (i + 0.5) * dt;
    const px = ro[0] + rd[0] * t;
    const py = ro[1] + rd[1] * t;
    const pz = ro[2] + rd[2] * t;
    const r = Math.hypot(px, py, pz);
    const h = r - GROUND_RADIUS_KM;
    const densR = Math.exp(-h / RAYLEIGH_SCALE_HEIGHT);
    const densM = Math.exp(-h / MIE_SCALE_HEIGHT);
    const densO = Math.max(1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH, 0);
    odSample[0] = odView[0] + densR * dt * 0.5;
    odSample[1] = odView[1] + densM * dt * 0.5;
    odSample[2] = odView[2] + densO * dt * 0.5;
    odView[0] += densR * dt;
    odView[1] += densM * dt;
    odView[2] += densO * dt;
    const mu = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / r;
    const odSun = sunOpticalDepth(h, mu);
    transmittanceOf([odSample[0] + odSun[0], odSample[1] + odSun[1], odSample[2] + odSun[2]], T);
    const lit = earthShadow(h, r, mu) * dt;
    for (let c = 0; c < 3; c++) {
      sumR[c] += T[c] * lit * densR;
      sumM[c] += T[c] * lit * densM;
    }
  }
  const mu = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  const pr = rayleighPhase(mu);
  const pm = miePhase(mu);
  const intensity = options.sunIntensity ?? 10;
  for (let c = 0; c < 3; c++) radiance[c] = (RAYLEIGH_SCATTERING[c] * sumR[c] * pr + sumM[c] * MIE_SCATTERING * pm) * intensity;
  return { radiance, transmittance: transmittanceOf(odView) };
}

/** Number of order-2 spherical harmonics coefficients. */
export const SH_COEFFICIENTS = 9;

/**
 * Real SH basis of order 2 at a unit direction, in three.js's order and
 * normalization (`SphericalHarmonics3.getBasisAt`).
 */
export function shBasis(x: number, y: number, z: number, out: number[] = new Array<number>(SH_COEFFICIENTS)): number[] {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

/**
 * Irradiance (cosine-weighted integral of radiance) of SH radiance
 * coefficients at a unit normal: the formula three.js lights a surface with
 * (`getShIrradianceAt`). `sh` holds 9 RGB triplets.
 */
export function shIrradiance(sh: readonly Vec3[], x: number, y: number, z: number): Vec3 {
  const k = [
    0.886227,
    2 * 0.511664 * y,
    2 * 0.511664 * z,
    2 * 0.511664 * x,
    2 * 0.429043 * x * y,
    2 * 0.429043 * y * z,
    0.743125 * z * z - 0.247708,
    2 * 0.429043 * x * z,
    0.429043 * (x * x - y * y),
  ];
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < SH_COEFFICIENTS; i++) for (let c = 0; c < 3; c++) out[c] += sh[i][c] * k[i];
  return out;
}

/** Unit directions spread evenly over the sphere (Fibonacci lattice). */
export function sphereDirections(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    const a = golden * i;
    out.push([Math.cos(a) * r, Math.sin(a) * r, z]);
  }
  return out;
}

export interface SkyLightOptions extends ScatteringOptions {
  /** Directions over the whole sphere (half of them see the sky). Default 128. */
  samples?: number;
  /** Diffuse reflectance of the ground below the point (light bounced onto walls). Default 0.2. */
  groundAlbedo?: number;
  /** Uniform radiance added everywhere (the night floor; the globe adds 0.015). Default 0. */
  ambient?: number;
}

/** Light around a point: SH radiance coefficients and the values they were built from. */
export interface SkyLight {
  /** 9 RGB coefficients of the radiance (three.js `SphericalHarmonics3` order). */
  sh: Vec3[];
  /** Sky irradiance on a horizontal surface facing up (sun excluded). */
  skyIrradiance: Vec3;
  /** Radiance of the ground below the horizon (sun and sky light it bounces). */
  groundRadiance: Vec3;
  /** Sunlight reaching the point (transmittance × earth shadow) and the sun's zenith cosine. */
  sun: { transmittance: Vec3; mu: number };
}

const _basis = new Array<number>(SH_COEFFICIENTS);

/**
 * Sky and ground light at a point (atmosphere-space km) projected onto
 * order-2 spherical harmonics (Monte Carlo over evenly spread directions).
 * Directions above the local horizon carry the single-scattered sky
 * radiance; those below carry the ground's diffuse reflection of the sun and
 * sky. The sun disk itself is not included: it is the directional light.
 * Directions and the result are in the frame of `pKm` / `sunDir`
 * (atmosphere space; within 0.4% of ECEF directions).
 */
export function skyLightSH(pKm: ReadonlyVec3, sunDir: ReadonlyVec3, options: SkyLightOptions = {}): SkyLight {
  const count = options.samples ?? 128;
  const groundAlbedo = options.groundAlbedo ?? 0.2;
  const r = Math.hypot(pKm[0], pKm[1], pKm[2]);
  const up: Vec3 = [pKm[0] / r, pKm[1] / r, pKm[2] / r];
  // Look from at least 2 m above the ground so rays just above the horizon do not start below it.
  const r0 = Math.max(r, GROUND_RADIUS_KM + 0.002);
  const ro: Vec3 = [up[0] * r0, up[1] * r0, up[2] * r0];
  const sh: Vec3[] = Array.from({ length: SH_COEFFICIENTS }, () => [0, 0, 0] as Vec3);
  const weight = (4 * Math.PI) / count;
  const skyIrradiance: Vec3 = [0, 0, 0];
  const below: Vec3[] = [];
  for (const d of sphereDirections(count)) {
    const cos = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    if (cos <= 0) {
      below.push(d);
      continue;
    }
    const { radiance } = skyRadiance(ro, d, sunDir, { steps: options.steps ?? 12, sunIntensity: options.sunIntensity });
    shBasis(d[0], d[1], d[2], _basis);
    for (let i = 0; i < SH_COEFFICIENTS; i++) for (let c = 0; c < 3; c++) sh[i][c] += radiance[c] * _basis[i] * weight;
    for (let c = 0; c < 3; c++) skyIrradiance[c] += radiance[c] * cos * weight;
  }
  const sun = sunTransmittance(pKm, sunDir);
  // Lambertian ground: radiance = albedo / π × (sun irradiance + sky irradiance). The sun's
  // irradiance is π·T·cos in the units the lights use (a directional light of intensity π·T
  // lights a white surface facing it to T, as the globe's direct term does).
  const sunCos = Math.max(sun.mu, 0);
  const groundRadiance: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) groundRadiance[c] = groundAlbedo * (sun.transmittance[c] * sunCos + skyIrradiance[c] / Math.PI);
  for (const d of below) {
    shBasis(d[0], d[1], d[2], _basis);
    for (let i = 0; i < SH_COEFFICIENTS; i++) for (let c = 0; c < 3; c++) sh[i][c] += groundRadiance[c] * _basis[i] * weight;
  }
  const ambient = options.ambient ?? 0;
  if (ambient > 0) {
    // Uniform radiance L projects onto the constant band only: c0 = L · 0.282095 · 4π.
    for (let c = 0; c < 3; c++) sh[0][c] += ambient * 0.282095 * 4 * Math.PI;
  }
  return { sh, skyIrradiance, groundRadiance, sun };
}

/** ECEF meters → atmosphere-space kilometers. */
export function toAtmosphereKm(x: number, y: number, z: number): Vec3 {
  return [x * 0.001, y * 0.001, z * Z_SCALE * 0.001];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
