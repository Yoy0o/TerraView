/**
 * Lights that follow the atmosphere (M3.5): the color of the sun and the
 * sky light around a point, from the CPU atmosphere model, for the
 * directional light and the light probe that light buildings and 3D Tiles.
 * Recomputed only when the sun or the point moved noticeably (a few tenths
 * of a millisecond each time). No three.js import: the viewer copies the
 * numbers into its lights.
 */
import { skyLightSH, toAtmosphereKm, type SkyLightOptions, type Vec3 } from './atmosphereModel';

/** Light at a point, ready for three.js lights (linear RGB). */
export interface AtmosphereLight {
  /**
   * Color of the directional light: the sunlight reaching the point (per-channel
   * transmittance times the earth's shadow), 0 at night.
   */
  sunColor: Vec3;
  /**
   * Intensity of the directional light. π: a white Lambertian surface facing the
   * sun then reflects exactly `sunColor`, as the globe's lit ground does.
   */
  sunIntensity: number;
  /** Radiance of the sky above and the lit ground below, order-2 SH (9 RGB, three.js order) for a `LightProbe`. */
  sh: Vec3[];
  /** Cosine of the sun's zenith angle at the point (negative below the horizon). */
  sunMu: number;
}

/** The sun turned more than this (radians, ~0.1°) since the last computation: compute again. */
const SUN_TOLERANCE = 0.1 * (Math.PI / 180);
/** The point moved more than this (meters): compute again. */
const POINT_TOLERANCE = 500;

/** Keeps the light of the last point and sun, recomputing when either moved past the tolerances. */
export class AtmosphereLighting {
  /** Last result (null before the first `update`). */
  current: AtmosphereLight | null = null;
  /** Computations so far (diagnostics, tests). */
  computations = 0;
  private lastPoint: Vec3 | null = null;
  private lastSun: Vec3 | null = null;
  private readonly cosTolerance = Math.cos(SUN_TOLERANCE);

  constructor(private readonly options: SkyLightOptions = { samples: 96, steps: 10 }) {}

  /**
   * Light at `point` (ECEF meters) for a sun direction (ECEF unit vector).
   * Returns true when it was recomputed (the lights need updating).
   */
  update(point: Vec3, sun: Vec3): boolean {
    if (this.current && this.lastPoint && this.lastSun) {
      const moved = Math.hypot(point[0] - this.lastPoint[0], point[1] - this.lastPoint[1], point[2] - this.lastPoint[2]);
      const turned = sun[0] * this.lastSun[0] + sun[1] * this.lastSun[1] + sun[2] * this.lastSun[2];
      if (moved <= POINT_TOLERANCE && turned >= this.cosTolerance) return false;
    }
    this.lastPoint = [point[0], point[1], point[2]];
    this.lastSun = [sun[0], sun[1], sun[2]];
    const pKm = toAtmosphereKm(point[0], point[1], point[2]);
    const sky = skyLightSH(pKm, sun, this.options);
    this.current = { sunColor: sky.sun.transmittance, sunIntensity: Math.PI, sh: sky.sh, sunMu: sky.sun.mu };
    this.computations++;
    return true;
  }

  /** Forgets the last result (the next `update` computes). */
  reset(): void {
    this.current = null;
    this.lastPoint = null;
    this.lastSun = null;
  }
}
