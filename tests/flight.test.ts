import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { angleDelta, DEG2RAD } from '../src/core/math';
import { LookAtFlight } from '../src/viewer/CameraFlight';
import { cameraDirection, cameraRight, getHeadingPitch, lookAtHeadingPitchRange } from '../src/viewer/cameraMath';

const E = Ellipsoid.WGS84;

/** A pose looking at `target` from heading / pitch (degrees) / range. */
function pose(target: Vector3, heading: number, pitch: number, range: number) {
  const position = new Vector3();
  const quaternion = new Quaternion();
  lookAtHeadingPitchRange(E, target, heading * DEG2RAD, pitch * DEG2RAD, range, position, quaternion);
  return { position, quaternion, heading: heading * DEG2RAD, pitch: pitch * DEG2RAD };
}

/** Samples a flight until it ends. */
function fly(flight: LookAtFlight, step = 1 / 60) {
  const p = new Vector3();
  const q = new Quaternion();
  const frames: { p: Vector3; q: Quaternion }[] = [];
  for (let i = 0; i < 10_000; i++) {
    const running = flight.update(step, p, q);
    frames.push({ p: p.clone(), q: q.clone() });
    if (!running) break;
  }
  return frames;
}

describe('LookAtFlight', () => {
  const building = E.cartographicToCartesian(116.39 * DEG2RAD, 39.9 * DEG2RAD, 50);
  const e = new Vector3();
  const n = new Vector3();
  const u = new Vector3();
  E.eastNorthUp(building, e, n, u);
  // Floor center and a room 20 m east and 6 m up of it.
  const floorCenter = building.clone().addScaledVector(u, 8);
  const room = floorCenter.clone().addScaledVector(e, 20).addScaledVector(u, 6);

  it('ends exactly at the destination pose', () => {
    const from = pose(floorCenter, 45, -55, 120);
    const to = pose(room, 135, -50, 40);
    const flight = LookAtFlight.create(E, from.position, from.quaternion, floorCenter, to, room)!;
    expect(flight).not.toBeNull();
    const last = fly(flight).at(-1)!;
    expect(last.p.distanceTo(to.position)).toBeLessThan(1e-6);
    // Orientation is rebuilt from ECEF differences: micro-radian precision (the controller snaps to the exact pose at the end).
    const hp = getHeadingPitch(E, last.p, last.q);
    expect(Math.abs(angleDelta(hp.heading, to.heading))).toBeLessThan(1e-5);
    expect(Math.abs(hp.pitch - to.pitch)).toBeLessThan(1e-5);
  });

  it('always looks at a point between the two subjects, without roll, above their horizon', () => {
    const from = pose(floorCenter, 45, -55, 120);
    const to = pose(room, 135, -50, 40);
    const flight = LookAtFlight.create(E, from.position, from.quaternion, floorCenter, to, room)!;
    const frames = fly(flight);
    expect(frames.length).toBeGreaterThan(30);
    const fwd = new Vector3();
    const right = new Vector3();
    const up = new Vector3();
    const toSegment = new Vector3();
    for (const { p, q } of frames) {
      cameraDirection(q, fwd);
      // The view ray passes the segment between the subjects (distance from the ray to it is ~0).
      let best = Infinity;
      for (let s = 0; s <= 200; s++) {
        toSegment.lerpVectors(floorCenter, room, s / 200).sub(p);
        best = Math.min(best, toSegment.clone().cross(fwd).length());
      }
      expect(best).toBeLessThan(0.2);
      // No roll: the camera's right vector is horizontal.
      E.geodeticNormal(p, up);
      expect(Math.abs(cameraRight(q, right).dot(up))).toBeLessThan(1e-6);
      // Never looks up at the subjects (the camera stays above their horizon).
      expect(getHeadingPitch(E, p, q).pitch).toBeLessThan(0);
    }
  });

  it('is shorter for a room hop than for crossing a campus', () => {
    const from = pose(floorCenter, 45, -55, 120);
    const near = LookAtFlight.create(E, from.position, from.quaternion, floorCenter, pose(room, 45, -50, 40), room)!;
    const far = floorCenter.clone().addScaledVector(n, 1500);
    const across = LookAtFlight.create(E, from.position, from.quaternion, floorCenter, pose(far, 45, -50, 40), far)!;
    expect(near.duration).toBeGreaterThanOrEqual(0.9);
    expect(across.duration).toBeGreaterThan(near.duration);
    expect(across.duration).toBeLessThanOrEqual(2.2);
    expect(LookAtFlight.create(E, from.position, from.quaternion, floorCenter, pose(room, 45, -50, 40), room, 3)!.duration).toBe(3);
  });

  it('declines hops to the opposite side of the subject and degenerate ones', () => {
    const from = pose(floorCenter, 0, -1, 100);
    const opposite = pose(floorCenter, 180, -1, 100);
    expect(LookAtFlight.create(E, from.position, from.quaternion, floorCenter, opposite, floorCenter)).toBeNull();
    expect(LookAtFlight.create(E, from.position, from.quaternion, from.position, pose(room, 45, -50, 40), room)).toBeNull();
  });

  it('blends a moved destination in with the progress', () => {
    const from = pose(floorCenter, 45, -55, 120);
    const to = pose(room, 90, -50, 40);
    const flight = LookAtFlight.create(E, from.position, from.quaternion, floorCenter, to, room)!;
    const shift = u.clone().multiplyScalar(30);
    flight.endOffset.copy(shift);
    const last = fly(flight).at(-1)!;
    expect(last.p.distanceTo(to.position.clone().add(shift))).toBeLessThan(1e-6);
  });
});
