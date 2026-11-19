/**
 * Floor ambient occlusion (M3.4): the pure rules of the bake and the shading, and the
 * scheduler with a stand-in baker (the GPU bake itself was checked in the browser, roadmap §0.2
 * "P3.5 落地").
 */
import { DataTexture, Mesh, RedFormat, UnsignedByteType } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import type { BimEntity } from '../src/indoor/BimEntity';
import { Building } from '../src/indoor/Building';
import {
  BLUR_TAPS,
  blurStep,
  blurWeights,
  combineOcclusion,
  contactSigma,
  CONTACT_WEIGHT,
  falloffWeights,
  FloorOcclusion,
  FLOOR_OCCLUSION_DEFAULTS,
  occlusionFactor,
  occlusionGrid,
  occlusionRows,
  occlusionWeight,
  REBAKE_SETTLE_MS,
  resolveOcclusionOptions,
  type BakedOcclusion,
  type FloorOcclusionOptions,
  type OcclusionBaker,
} from '../src/indoor/FloorOcclusion';
import { parseBuildingDoc } from '../src/indoor/schema';

const E = Ellipsoid.WGS84;

describe('floor AO rules', () => {
  it('grid: content plus margin, texel size, capped resolution', () => {
    const g = occlusionGrid(0, 0, 20, 10, 1, 0.1, 1024)!;
    expect(g).toMatchObject({ x0: -1, y0: -1, width: 22, height: 12, cols: 220, rows: 120 });
    // Too fine for the cap: texels grow so the longer side fits.
    const big = occlusionGrid(0, 0, 200, 50, 0, 0.05, 1000)!;
    expect(big.cols).toBe(1000);
    expect(big.rows).toBe(250);
    expect(occlusionGrid(0, 0, 0.01, 0.01, 0, 1, 512)!.cols).toBe(4);
    expect(occlusionGrid(5, 0, 1, 1, 0, 0.1, 512)).toBeNull();
    expect(occlusionGrid(NaN, 0, 1, 1, 0, 0.1, 512)).toBeNull();
  });

  it('filter weights: the average sums to 1, the falloff peaks at 1, both symmetric', () => {
    const w = blurWeights();
    const f = falloffWeights();
    expect(w).toHaveLength(BLUR_TAPS);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Math.max(...f)).toBe(1);
    for (let i = 0; i < w.length; i++) {
      expect(w[i]).toBeCloseTo(w[w.length - 1 - i], 12);
      expect(f[i]).toBeCloseTo(f[f.length - 1 - i], 12);
    }
    // The taps span ±3 σ: the outermost step reaches 3σ of the span.
    expect(blurStep(0.5, 10) * ((BLUR_TAPS - 1) / 2) * 10).toBeCloseTo(1.5, 12);
    // Contact σ: half the radius, but never more than a few texels.
    expect(contactSigma(0.9, 0.08)).toBeCloseTo(0.4, 12);
    expect(contactSigma(0.9, 0.3)).toBeCloseTo(0.45, 12);
  });

  it('occlusion: contact alone at a wall, full under furniture', () => {
    expect(combineOcclusion(1, 0)).toBeCloseTo(CONTACT_WEIGHT);
    expect(combineOcclusion(1, 1)).toBe(1);
    expect(combineOcclusion(0, 0)).toBe(0);
  });

  it('which surfaces take it: floor level up faces, wall bases; not desk tops, ceilings or high walls', () => {
    expect(occlusionWeight(0, 1, 0.9)).toBe(1);
    expect(occlusionWeight(0.02, 1, 0.9)).toBe(1);
    expect(occlusionWeight(0.75, 1, 0.9)).toBe(0);
    expect(occlusionWeight(0.1, 0, 0.9)).toBeGreaterThan(0.95);
    expect(occlusionWeight(0.45, 0, 0.9)).toBeCloseTo(0.5, 5);
    expect(occlusionWeight(2, 0, 0.9)).toBe(0);
    expect(occlusionWeight(0, -1, 0.9)).toBe(0);
    expect(occlusionFactor(0.5, 1, 0.6)).toBeCloseTo(0.7);
    expect(occlusionFactor(1, 0, 0.6)).toBe(1);
  });

  it('read-back rows: WebGPU reads from the top, WebGL from the bottom; the result starts at -y', () => {
    // 2 × 3 RGBA picture; red holds row * 10 + column as rendered from the bottom up.
    const cols = 2;
    const rows = 3;
    const bottomUp: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) bottomUp.push(r * 10 + c, 0, 0, 255);
    const topDown: number[] = [];
    for (let r = rows - 1; r >= 0; r--) for (let c = 0; c < cols; c++) topDown.push(r * 10 + c, 0, 0, 255);
    const expected = [0, 1, 10, 11, 20, 21];
    expect([...occlusionRows(bottomUp, cols, rows, false)]).toEqual(expected);
    expect([...occlusionRows(topDown, cols, rows, true)]).toEqual(expected);
    expect([...occlusionRows([0, 1, 10, 11, 20, 21], cols, rows, false, 1)]).toEqual(expected);
  });

  it('options: defaults, clamping, unknown values ignored', () => {
    const o = resolveOcclusionOptions({ intensity: 2, radius: -1, texelSize: Number.NaN, enabled: 'yes' as unknown as boolean }, FLOOR_OCCLUSION_DEFAULTS);
    expect(o).toEqual({ ...FLOOR_OCCLUSION_DEFAULTS, intensity: 1, radius: 0.05 });
    expect(resolveOcclusionOptions({ maxResolution: 777.4 }, FLOOR_OCCLUSION_DEFAULTS).maxResolution).toBe(777);
  });
});

function doc(): Record<string, unknown> {
  return {
    format: 'three-geo-building',
    version: '1.0',
    id: 'b',
    anchor: { longitude: 116.39, latitude: 39.9, height: 50 },
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [{ id: 'r1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
        things: [{ id: 't1', category: 'rack', position: [5, 4, 0], size: [0.6, 1, 2] }],
        elements: [{ id: 'win', kind: 'window', path: [[0, 9], [10, 9]], height: 2 }],
      },
      { id: 'f2', index: 1, elevation: 4, height: 4, rooms: [{ id: 'r2', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }] },
    ],
  };
}

/** Baker stand-in: resolves when told, records calls. */
class FakeBaker implements OcclusionBaker {
  calls: { floor: string; options: Required<FloorOcclusionOptions> }[] = [];
  private resolvers: ((b: BakedOcclusion | null) => void)[] = [];
  disposed = false;
  bake(floor: BimEntity, options: Required<FloorOcclusionOptions>): Promise<BakedOcclusion | null> {
    this.calls.push({ floor: floor.id, options });
    return new Promise((r) => this.resolvers.push(r));
  }
  /** Finishes the oldest bake with an 8 × 4 texture. */
  async finish(): Promise<void> {
    const r = this.resolvers.shift()!;
    const texture = new DataTexture(new Uint8Array(32), 8, 4, RedFormat, UnsignedByteType);
    r({ texture, grid: { x0: -1, y0: -1, width: 12, height: 10, cols: 8, rows: 4 }, bytes: 32 });
    await Promise.resolve();
    await Promise.resolve();
  }
  dispose(): void {
    this.disposed = true;
  }
}

function setup() {
  const b = new Building(parseBuildingDoc(doc()), E, null);
  const baker = new FakeBaker();
  let changes = 0;
  const ao = new FloorOcclusion(baker, () => changes++);
  const [f1, f2] = b.floors;
  const meshesOf = (e: BimEntity) => {
    const out: Mesh[] = [];
    e.group.traverse((o) => (o as Mesh).isMesh && out.push(o as Mesh));
    return out;
  };
  return { b, baker, ao, f1, f2, meshesOf, changes: () => changes };
}

describe('FloorOcclusion scheduler', () => {
  it('bakes shown floors one at a time and puts the texture on floors and walls only', async () => {
    const { b, baker, ao, f1, f2, changes } = setup();
    f2.visible = false;
    expect(ao.pending([b])).toBe(true);
    expect(ao.update([b], 0)).toBe(true);
    // One in flight: nothing else starts.
    expect(ao.update([b], 16)).toBe(false);
    expect(baker.calls.map((c) => c.floor)).toEqual(['f1']);
    await baker.finish();
    expect(ao.bakedFloors).toBe(1);
    expect(ao.bytes).toBe(32);
    expect(changes()).toBeGreaterThan(0);
    expect(ao.pending([b])).toBe(false);

    const room = f1.children.find((c) => c.id === 'r1')!;
    const roomMaterials = room.meshes.map((m) => m.material as unknown as { colorNode: unknown; floorAoMap?: unknown; floorAoParams?: { x: number } });
    // Room floor and room walls receive.
    expect(roomMaterials.every((m) => m.colorNode !== null && m.floorAoMap)).toBe(true);
    const win = f1.children.find((c) => c.id === 'win')!;
    expect((win.meshes[0].material as unknown as { colorNode: unknown }).colorNode).toBeNull();
    // The receivers share one node.
    expect(new Set(roomMaterials.map((m) => m.colorNode)).size).toBe(1);
    // Hidden floors are left alone.
    expect(ao.bakedFor(f2)).toBeNull();
  });

  it('re-bakes after content changes settle, and for new settings at once; intensity needs no bake', async () => {
    const { b, baker, ao, f1, f2 } = setup();
    f2.visible = false;
    ao.update([b], 0);
    await baker.finish();
    const room = f1.children.find((c) => c.id === 'r1')!;
    const params = () => (room.meshes[0].material as unknown as { floorAoParams: { x: number } }).floorAoParams;

    ao.configure({ intensity: 0.3 });
    expect(params().x).toBe(0.3);
    expect(ao.update([b], 100)).toBe(false);

    // A device moved on the floor: wait for it to settle.
    b.floorContentChanged(f1.children.find((c) => c.id === 't1')!);
    expect(ao.update([b], 200)).toBe(false);
    expect(ao.update([b], 200 + REBAKE_SETTLE_MS - 1)).toBe(false);
    expect(ao.update([b], 200 + REBAKE_SETTLE_MS + 1)).toBe(true);
    await baker.finish();
    expect(baker.calls).toHaveLength(2);

    ao.configure({ radius: 1.2 });
    expect(ao.update([b], 600)).toBe(true);
    expect(baker.calls[2].options.radius).toBe(1.2);
    await baker.finish();
    expect(ao.bakedFloors).toBe(1);
  });

  it('turning it off removes the node and frees the textures; a bake landing afterwards is dropped', async () => {
    const { b, baker, ao, f1, f2 } = setup();
    f2.visible = false;
    ao.update([b], 0);
    await baker.finish();
    ao.configure({ radius: 2 });
    ao.update([b], 10);
    ao.enabled = false;
    const room = f1.children.find((c) => c.id === 'r1')!;
    expect((room.meshes[0].material as unknown as { colorNode: unknown }).colorNode).toBeNull();
    expect(ao.bakedFloors).toBe(0);
    await baker.finish();
    expect(ao.bakedFloors).toBe(0);
    expect(ao.update([b], 20)).toBe(false);
    ao.enabled = true;
    expect(ao.update([b], 30)).toBe(true);
  });

  it('forget drops a removed building; dispose disposes the baker', async () => {
    const { b, baker, ao, f2 } = setup();
    f2.visible = false;
    ao.update([b], 0);
    await baker.finish();
    ao.forget(b);
    expect(ao.bakedFloors).toBe(0);
    ao.dispose();
    expect(baker.disposed).toBe(true);
  });
});

describe('Building content versions', () => {
  it('count what stands on each floor', () => {
    const b = new Building(parseBuildingDoc(doc()), E, null);
    const [f1, f2] = b.floors;
    expect(b.contentVersion(f1)).toBe(0);
    b.floorContentChanged(f1.children.find((c) => c.id === 't1')!);
    expect(b.contentVersion(f1)).toBe(1);
    expect(b.contentVersion(f2)).toBe(0);
    // The building itself stands on no floor.
    b.floorContentChanged(b);
    expect(b.contentVersion(f1)).toBe(1);
  });
});
