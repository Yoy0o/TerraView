/**
 * Camera flights: a great-circle arc for long trips (`CameraFlight`) and a
 * look-at flight for short hops between nearby subjects (`LookAtFlight`).
 */
import { Quaternion, Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { angleDelta, clamp, easeInOutCubic, lerp } from '../core/math';
import { getHeadingPitch, orientationFromDirection, orientationFromHeadingPitch } from './cameraMath';

export interface FlightTarget {
  position: Vector3;
  /** Radians, clockwise from north. */
  heading: number;
  /** Radians, negative looks down. */
  pitch: number;
}

/** A running camera animation. */
export interface Flight {
  readonly duration: number;
  /** Shift of the destination blended in with the progress (the target moved while flying). */
  readonly endOffset: Vector3;
  /** Advances the flight; returns false once finished. */
  update(dt: number, outPosition: Vector3, outQuaternion: Quaternion): boolean;
}

/**
 * Animated camera transition along a great-circle arc, rising to an altitude
 * proportional to the travel distance (similar to Google Earth / Cesium).
 */
export class CameraFlight implements Flight {
  readonly duration: number;
  private elapsed = 0;
  private readonly n0 = new Vector3();
  private readonly n1 = new Vector3();
  private readonly angle: number;
  private readonly logH0: number;
  private readonly logH1: number;
  private readonly arc: number;
  private readonly heading0: number;
  private readonly headingDelta: number;
  private readonly pitch0: number;
  private readonly pitch1: number;
  private readonly tmpN = new Vector3();
  /**
   * Shift applied to the destination, blended in with the flight's progress
   * (the target moved while flying, e.g. a building settling onto the terrain).
   */
  readonly endOffset = new Vector3();

  constructor(
    private readonly ellipsoid: Ellipsoid,
    fromPosition: Vector3,
    fromQuaternion: Quaternion,
    target: FlightTarget,
    duration?: number,
  ) {
    const c0 = ellipsoid.cartesianToCartographic(fromPosition)!;
    const c1 = ellipsoid.cartesianToCartographic(target.position)!;
    ellipsoid.geodeticSurfaceNormalCartographic(c0.longitude, c0.latitude, this.n0);
    ellipsoid.geodeticSurfaceNormalCartographic(c1.longitude, c1.latitude, this.n1);
    this.angle = Math.acos(clamp(this.n0.dot(this.n1), -1, 1));
    const surfaceDistance = this.angle * ellipsoid.maximumRadius;

    this.logH0 = Math.log(Math.max(c0.height, 1));
    this.logH1 = Math.log(Math.max(c1.height, 1));
    const peak = Math.min(surfaceDistance * 0.4, 2.2e7);
    this.arc = Math.max(0, Math.log(Math.max(peak, 1)) - (this.logH0 + this.logH1) / 2);

    const hp = getHeadingPitch(ellipsoid, fromPosition, fromQuaternion);
    this.heading0 = hp.heading;
    this.pitch0 = hp.pitch;
    this.headingDelta = angleDelta(hp.heading, target.heading);
    this.pitch1 = target.pitch;

    const auto = 1.2 + 0.75 * Math.log10(1 + surfaceDistance / 1000 + Math.abs(this.logH1 - this.logH0) * 2);
    this.duration = duration ?? clamp(auto, 1.2, 5.5);
  }

  /** Advances the flight; returns false once finished. */
  update(dt: number, outPosition: Vector3, outQuaternion: Quaternion): boolean {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const t = this.duration > 0 ? this.elapsed / this.duration : 1;
    const e = easeInOutCubic(t);

    // Great-circle position.
    const n = this.tmpN;
    if (this.angle < 1e-9) {
      n.copy(this.n1);
    } else {
      const s = Math.sin(this.angle);
      n.copy(this.n0)
        .multiplyScalar(Math.sin((1 - e) * this.angle) / s)
        .addScaledVector(this.n1, Math.sin(e * this.angle) / s)
        .normalize();
    }
    const lon = Math.atan2(n.y, n.x);
    const lat = Math.asin(clamp(n.z, -1, 1));
    const bump = Math.sin(Math.PI * t);
    const height = Math.exp(lerp(this.logH0, this.logH1, e) + this.arc * bump);
    this.ellipsoid.cartographicToCartesian(lon, lat, height, outPosition);
    if (this.endOffset.lengthSq() > 0) outPosition.addScaledVector(this.endOffset, e);

    // Look down while high up in the arc.
    const lookDown = Math.min(1, this.arc / 2) * bump;
    const pitch = lerp(lerp(this.pitch0, this.pitch1, e), -Math.PI / 2 + 0.001, lookDown);
    const heading = this.heading0 + this.headingDelta * e;
    orientationFromHeadingPitch(this.ellipsoid, outPosition, heading, pitch, outQuaternion);
    return t < 1;
  }
}

const _l = new Vector3();
const _u = new Vector3();
const _d = new Vector3();

/**
 * Short hop between two nearby subjects (e.g. building → floor → room): the
 * point looked at slides from the old subject to the new one while the
 * camera swings around it and dollies in or out (ThingJS's position + target
 * tweens), so the subject never leaves the frame. The direction from the
 * subject to the camera is slerped, which keeps the camera above the
 * subject's horizon when both ends are; orientation is rebuilt every frame
 * from heading / pitch, so there is no roll.
 */
export class LookAtFlight implements Flight {
  readonly duration: number;
  readonly endOffset = new Vector3();
  private elapsed = 0;
  private readonly l0: Vector3;
  private readonly l1: Vector3;
  private readonly u0: Vector3;
  private readonly u1: Vector3;
  private readonly angle: number;
  private readonly logD0: number;
  private readonly logD1: number;
  private readonly heading0: number;
  private readonly headingDelta: number;

  /**
   * Null when the hop does not suit a look-at flight (degenerate distances
   * or a swing to the opposite side of the subject); use `CameraFlight` then.
   */
  static create(
    ellipsoid: Ellipsoid,
    fromPosition: Vector3,
    fromQuaternion: Quaternion,
    fromLookAt: Vector3,
    target: FlightTarget,
    toLookAt: Vector3,
    duration?: number,
  ): LookAtFlight | null {
    const d0 = fromPosition.distanceTo(fromLookAt);
    const d1 = target.position.distanceTo(toLookAt);
    if (d0 < 1e-3 || d1 < 1e-3) return null;
    const u0 = fromPosition.clone().sub(fromLookAt).divideScalar(d0);
    const u1 = target.position.clone().sub(toLookAt).divideScalar(d1);
    // Nearly opposite sides: the slerp plane is undefined.
    if (u0.dot(u1) < -0.97) return null;
    return new LookAtFlight(ellipsoid, fromPosition, fromQuaternion, fromLookAt, u0, d0, target, toLookAt, u1, d1, duration);
  }

  private constructor(
    private readonly ellipsoid: Ellipsoid,
    fromPosition: Vector3,
    fromQuaternion: Quaternion,
    fromLookAt: Vector3,
    u0: Vector3,
    d0: number,
    target: FlightTarget,
    toLookAt: Vector3,
    u1: Vector3,
    d1: number,
    duration?: number,
  ) {
    this.l0 = fromLookAt.clone();
    this.l1 = toLookAt.clone();
    this.u0 = u0;
    this.u1 = u1;
    this.angle = Math.acos(clamp(u0.dot(u1), -1, 1));
    this.logD0 = Math.log(d0);
    this.logD1 = Math.log(d1);
    const hp = getHeadingPitch(ellipsoid, fromPosition, fromQuaternion);
    this.heading0 = hp.heading;
    this.headingDelta = angleDelta(hp.heading, target.heading);
    const travel = Math.max(fromPosition.distanceTo(target.position), this.l0.distanceTo(this.l1));
    // About 1 s for a room-sized hop, up to 2 s across a campus; turning adds a little.
    const auto = 0.9 + 0.45 * Math.log10(1 + travel / 20) + 0.25 * (this.angle / Math.PI);
    this.duration = duration ?? clamp(auto, 0.9, 2.2);
  }

  update(dt: number, outPosition: Vector3, outQuaternion: Quaternion): boolean {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const t = this.duration > 0 ? this.elapsed / this.duration : 1;
    const e = easeInOutCubic(t);
    const look = _l.lerpVectors(this.l0, this.l1, e).addScaledVector(this.endOffset, e);
    const u = _u;
    if (this.angle < 1e-6) {
      u.copy(this.u1);
    } else {
      const s = Math.sin(this.angle);
      u.copy(this.u0)
        .multiplyScalar(Math.sin((1 - e) * this.angle) / s)
        .addScaledVector(this.u1, Math.sin(e * this.angle) / s)
        .normalize();
    }
    const distance = Math.exp(lerp(this.logD0, this.logD1, e));
    outPosition.copy(look).addScaledVector(u, distance);
    // Looking straight down has no heading of its own: carry the interpolated one.
    orientationFromDirection(this.ellipsoid, outPosition, _d.copy(u).negate(), this.heading0 + this.headingDelta * e, outQuaternion);
    return t < 1;
  }
}
