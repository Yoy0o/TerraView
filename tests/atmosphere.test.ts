/**
 * CPU atmosphere model (M3.5): the port of the TSL atmosphere, the sky light SH and the light
 * cache. The GPU side was compared against these functions in the browser (roadmap §0.2 "P3.5
 * 落地": at most 6.5e-5 apart on WebGPU and WebGL 2); here the CPU model is checked against
 * brute-force integration and physical sanity.
 */
import { describe, expect, it } from 'vitest';
import { AtmosphereLighting } from '../src/atmosphere/AtmosphereLighting';
import * as nodes from '../src/atmosphere/AtmosphereNodes';
import {
  chapman,
  GROUND_RADIUS_KM,
  MIE_SCALE_HEIGHT,
  RAYLEIGH_SCALE_HEIGHT,
  shBasis,
  shIrradiance,
  skyLightSH,
  skyRadiance,
  sphereDirections,
  sunOpticalDepth,
  sunTransmittance,
  TOP_RADIUS_KM,
  toAtmosphereKm,
  Z_SCALE,
  type Vec3,
} from '../src/atmosphere/atmosphereModel';

const R = GROUND_RADIUS_KM;
const DEG = Math.PI / 180;

/** Sun direction at an elevation (degrees) seen from (R + h, 0, 0). */
function sunAt(elevationDeg: number): Vec3 {
  const e = elevationDeg * DEG;
  return [Math.sin(e), Math.cos(e), 0];
}

/** Optical depth by brute force: density integrated along the ray to the top of the atmosphere (or the ground). */
function bruteOpticalDepth(h: number, mu: number, scaleHeight: number): number {
  const ro: Vec3 = [R + h, 0, 0];
  const rd: Vec3 = [mu, Math.sqrt(1 - mu * mu), 0];
  const b = ro[0] * rd[0];
  const c = ro[0] * ro[0] - TOP_RADIUS_KM * TOP_RADIUS_KM;
  const tEnd = -b + Math.sqrt(b * b - c);
  const steps = 20000;
  const dt = tEnd / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const x = ro[0] + rd[0] * t;
    const y = rd[1] * t;
    const r = Math.hypot(x, y);
    if (r < R) return Infinity;
    sum += Math.exp(-(r - R) / scaleHeight) * dt;
  }
  return sum;
}

describe('atmosphere model (CPU)', () => {
  it('shares its constants with the TSL nodes', () => {
    expect(nodes.GROUND_RADIUS_KM).toBe(GROUND_RADIUS_KM);
    expect(nodes.TOP_RADIUS_KM).toBe(TOP_RADIUS_KM);
    expect(nodes.Z_SCALE).toBe(Z_SCALE);
  });

  it("Schüler's Chapman approximation stays within its known error of brute-force optical depth", () => {
    // The approximation (shared with the GPU sky and globe) underestimates the optical depth:
    // Rayleigh about 3.4 % at the zenith, 6 % at 60°, 13 % at 78°, 20 % at 85° from it (Mie about
    // 40 % less). A port mistake would land far outside these bands.
    const band: Record<number, [number, number]> = { 1: [-0.036, -0.012], 0.5: [-0.065, -0.025], 0.2: [-0.13, -0.058], 0.08: [-0.205, -0.12] };
    for (const h of [0.05, 1, 5]) {
      for (const mu of [1, 0.5, 0.2, 0.08]) {
        for (const H of [RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT]) {
          const approx = chapman(R / H, h / H, mu) * H;
          const exact = bruteOpticalDepth(h, mu, H);
          const err = (approx - exact) / exact;
          expect(err).toBeGreaterThan(band[mu][0]);
          expect(err).toBeLessThan(band[mu][1]);
        }
      }
    }
    // The rayleigh / mie parts of sunOpticalDepth are exactly those.
    const od = sunOpticalDepth(0.05, 0.5);
    expect(od[0]).toBeCloseTo(chapman(R / RAYLEIGH_SCALE_HEIGHT, 0.05 / RAYLEIGH_SCALE_HEIGHT, 0.5) * RAYLEIGH_SCALE_HEIGHT, 9);
  });

  it('sunlight dims and reddens as the sun sets, and is gone below the horizon', () => {
    const p: Vec3 = [R + 0.05, 0, 0];
    let prev: Vec3 = [Infinity, Infinity, Infinity];
    for (const elev of [90, 45, 20, 10, 5, 2]) {
      const t = sunTransmittance(p, sunAt(elev)).transmittance;
      // Red passes best, blue worst (Rayleigh).
      expect(t[0]).toBeGreaterThan(t[1]);
      expect(t[1]).toBeGreaterThan(t[2]);
      for (let c = 0; c < 3; c++) expect(t[c]).toBeLessThan(prev[c]);
      prev = t;
    }
    const noon = sunTransmittance(p, sunAt(90)).transmittance;
    expect(noon[0]).toBeGreaterThan(0.9);
    expect(noon[2]).toBeGreaterThan(0.7);
    expect(Math.max(...sunTransmittance(p, sunAt(-3)).transmittance)).toBeLessThan(1e-3);
    // Higher up, less air above: more light.
    expect(sunTransmittance([R + 8, 0, 0], sunAt(5)).transmittance[2]).toBeGreaterThan(sunTransmittance(p, sunAt(5)).transmittance[2]);
  });

  it('the clear sky is blue at the zenith and red towards a setting sun', () => {
    const ro: Vec3 = [R + 0.05, 0, 0];
    const zenith = skyRadiance(ro, [1, 0, 0], sunAt(60)).radiance;
    expect(zenith[2]).toBeGreaterThan(zenith[0] * 2);
    const sunsetDir: Vec3 = [Math.sin(2 * DEG), Math.cos(2 * DEG), 0];
    const sunset = skyRadiance(ro, sunsetDir, sunAt(1)).radiance;
    expect(sunset[0]).toBeGreaterThan(sunset[2]);
    // Rays into the ground stop there; looking down from space through no air sees nothing.
    expect(skyRadiance([R + 500, 0, 0], [0, 1, 0], sunAt(60)).radiance).toEqual([0, 0, 0]);
  });

  it('SH: uniform radiance L gives irradiance π·L everywhere (three.js convention)', () => {
    const L = 0.3;
    const dirs = sphereDirections(256);
    const sh: Vec3[] = Array.from({ length: 9 }, () => [0, 0, 0] as Vec3);
    const basis: number[] = [];
    for (const d of dirs) {
      shBasis(d[0], d[1], d[2], basis);
      for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) sh[i][c] += L * basis[i] * ((4 * Math.PI) / dirs.length);
    }
    for (const n of [[0, 0, 1], [1, 0, 0], [0.6, 0, 0.8]] as Vec3[]) {
      const e = shIrradiance(sh, n[0], n[1], n[2]);
      expect(e[0]).toBeCloseTo(Math.PI * L, 2);
    }
  });

  it('sky light SH: bluish from above, ground light from below, nothing at night but the floor', () => {
    const p: Vec3 = [R + 0.05, 0, 0];
    const day = skyLightSH(p, sunAt(45));
    const up = shIrradiance(day.sh, 1, 0, 0);
    const down = shIrradiance(day.sh, -1, 0, 0);
    // The SH of the upper hemisphere reproduces the integrated sky irradiance closely.
    for (let c = 0; c < 3; c++) expect(Math.abs(up[c] - day.skyIrradiance[c]) / day.skyIrradiance[c]).toBeLessThan(0.15);
    expect(up[2]).toBeGreaterThan(up[0]);
    // Looking down there is the lit ground, about neutral.
    expect(down[0]).toBeGreaterThan(0);
    expect(Math.abs(day.groundRadiance[0] - day.groundRadiance[2])).toBeLessThan(0.05);
    const night = skyLightSH(p, sunAt(-12), { ambient: 0.015 });
    const nightUp = shIrradiance(night.sh, 1, 0, 0);
    expect(nightUp[0] / Math.PI).toBeCloseTo(0.015, 3);
  });

  it('ECEF to atmosphere space scales z by a/b', () => {
    expect(toAtmosphereKm(1000, 2000, 3000)).toEqual([1, 2, 3 * Z_SCALE]);
  });
});

describe('AtmosphereLighting', () => {
  const point: Vec3 = [R * 1000 + 50, 0, 0];

  it('computes once, then only when the sun turned or the point moved noticeably', () => {
    const light = new AtmosphereLighting({ samples: 32, steps: 6 });
    expect(light.update(point, sunAt(40))).toBe(true);
    expect(light.current!.sunIntensity).toBeCloseTo(Math.PI);
    expect(light.update(point, sunAt(40.05))).toBe(false);
    expect(light.update([point[0], 300, 0], sunAt(40.05))).toBe(false);
    expect(light.update(point, sunAt(40.3))).toBe(true);
    expect(light.update([point[0], 900, 0], sunAt(40.3))).toBe(true);
    expect(light.computations).toBe(3);
    light.reset();
    expect(light.update(point, sunAt(40.3))).toBe(true);
  });

  it('sun color is the transmittance at the point; orange at dusk', () => {
    const light = new AtmosphereLighting({ samples: 32, steps: 6 });
    light.update(point, sunAt(6));
    const [r, g, b] = light.current!.sunColor;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b * 1.5);
    expect(light.current!.sh).toHaveLength(9);
  });
});
