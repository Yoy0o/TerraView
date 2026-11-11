import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { Building } from '../src/indoor/Building';
import { parseBuildingDoc } from '../src/indoor/schema';
import { IndoorBackdrop } from '../src/viewer/IndoorBackdrop';

const E = Ellipsoid.WGS84;

function building(): Building {
  return new Building(
    parseBuildingDoc({
      format: 'three-geo-building',
      version: '1.0',
      id: 'b1',
      anchor: { longitude: 116.39, latitude: 39.9, height: 50, heading: 30 },
      footprint: [[-30, -12], [30, -12], [30, 12], [-30, 12]],
      floors: [
        { id: 'B1', index: -1, elevation: -4, height: 4 },
        { id: 'F1', index: 0, elevation: 0, height: 4 },
      ],
    }),
    E,
    null,
  );
}

const amountOf = (b: IndoorBackdrop) => b.amount.value as number;

describe('IndoorBackdrop', () => {
  it('fades in, stays on, fades out and hides', () => {
    const backdrop = new IndoorBackdrop(E);
    const b = building();
    expect(backdrop.visible).toBe(false);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      backdrop.update(b, 1 / 60);
      seen.push(amountOf(backdrop));
    }
    // Monotonic, reaches 1 within the fade time and stays there (no flip-flop at the target).
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBe(1);
    expect(backdrop.update(b, 1 / 60)).toBe(false);
    expect(amountOf(backdrop)).toBe(1);
    expect(backdrop.visible).toBe(true);
    for (let i = 0; i < 40; i++) backdrop.update(null, 1 / 60);
    expect(amountOf(backdrop)).toBe(0);
    expect(backdrop.visible).toBe(false);
  });

  it('follows the building frame, under the lowest visible floor', () => {
    const backdrop = new IndoorBackdrop(E);
    const b = building();
    for (const f of b.floors) f.visible = true;
    backdrop.update(b, 1);
    const mesh = backdrop.group.children[0];
    // Basement visible: below it (slabs hang 0.25 m under their floor).
    expect(mesh.position.z).toBeCloseTo(-4.35, 9);
    b.floors[0].visible = false;
    backdrop.update(b, 1);
    expect(mesh.position.z).toBeCloseTo(-0.35, 9);
    // Same frame as the building root: the disk center is the anchor.
    backdrop.group.updateMatrixWorld(true);
    const center = new Vector3().setFromMatrixPosition(backdrop.group.matrixWorld);
    expect(center.distanceTo(new Vector3().setFromMatrixPosition(b.root.matrixWorld))).toBeLessThan(1e-6);
    // Big enough to reach the horizon from a building view: at least 4 km.
    expect(mesh.scale.x).toBeGreaterThanOrEqual(4000);
  });
});
