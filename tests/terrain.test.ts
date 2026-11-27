import { describe, expect, it } from 'vitest';
import {
  innerGrid,
  rasterSourceTile,
  sampleBorderedGrid,
  sampleHeightGrid,
  terrainLevelOffset,
  upsampleBorderedGrid,
  upsampleHeightGrid,
} from '../src/globe/terrain/terrainTiling';

describe('terrain tiling', () => {
  it('reads raster terrain from the coarsest tile that still has one sample per grid cell', () => {
    expect(terrainLevelOffset(256, 32)).toBe(3);
    expect(terrainLevelOffset(512, 32)).toBe(4);
    expect(terrainLevelOffset(256, 64)).toBe(2);
    expect(terrainLevelOffset(16, 32)).toBe(0);
    // Mesh tile 12/3301/1520 reads terrain 9/412/190 and covers 1/8 of it.
    expect(rasterSourceTile(12, 3301, 1520, 15, 3)).toEqual({ z: 9, x: 412, y: 190, dz: 3 });
    // Coarse levels clamp to level 0; deep levels clamp to the source's max zoom.
    expect(rasterSourceTile(2, 3, 1, 15, 3)).toEqual({ z: 0, x: 0, y: 0, dz: 2 });
    expect(rasterSourceTile(20, 800_000, 400_000, 15, 3)).toEqual({ z: 15, x: 800_000 >> 5, y: 400_000 >> 5, dz: 5 });
  });

  it('upsamples a parent grid exactly at shared vertices', () => {
    const n = 4;
    const row = n + 1;
    // A bilinear ramp is reproduced exactly by bilinear resampling.
    const parent = new Float32Array(row * row);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) parent[j * row + i] = 10 * i + 100 * j;
    const child = upsampleHeightGrid(parent, n, 5, 10, 20, 6, 21, 41, n); // south-east quadrant
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = 0.5 + i / n / 2;
        const v = 0.5 + j / n / 2;
        expect(child[j * row + i]).toBeCloseTo(10 * u * n + 100 * v * n, 4);
      }
    }
    expect(sampleHeightGrid(parent, n, 1, 1)).toBe(parent[row * row - 1]);
  });

  describe('bordered grids (edge normals)', () => {
    const n = 4;
    const brow = n + 3;
    // A smooth source surface over u, v in 0..1.
    const surface = (u: number, v: number) => Math.sin(5 * u) * 300 + Math.cos(3 * v) * 200 + 40 * u * v;
    // Mesh tiles 2 levels below the source: 4 x 4 of them share it.
    const tile = (tx: number, ty: number) => sampleBorderedGrid(n, tx / 4, ty / 4, 1 / 4, surface);
    const at = (g: Float32Array, i: number, j: number) => g[(j + 1) * brow + i + 1];

    it('holds the tile grid inside a one-cell border', () => {
      const g = tile(1, 2);
      expect(g.length).toBe(brow * brow);
      const inner = innerGrid(g, n);
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) expect(inner[j * (n + 1) + i]).toBe(at(g, i, j));
      expect(at(g, -1, 0)).toBeCloseTo(surface(1 / 4 - 1 / 16, 2 / 4), 4);
    });

    it("gives a tile's border the neighbor's first row or column, so shared edges get the same normals", () => {
      const a = tile(1, 1);
      const east = tile(2, 1);
      const south = tile(1, 2);
      for (let j = -1; j <= n + 1; j++) {
        // a's column n + 1 is east's column 1; a's column n - 1 is east's column -1.
        expect(at(a, n + 1, j)).toBeCloseTo(at(east, 1, j), 3);
        expect(at(east, -1, j)).toBeCloseTo(at(a, n - 1, j), 3);
      }
      for (let i = -1; i <= n + 1; i++) expect(at(a, i, n + 1)).toBeCloseTo(at(south, i, 1), 3);
    });

    it('leaves the border empty (NaN) where the source ends', () => {
      const corner = tile(0, 0);
      expect(at(corner, -1, 2)).toBeNaN();
      expect(at(corner, 2, -1)).toBeNaN();
      expect(at(corner, n + 1, 2)).not.toBeNaN();
      const last = tile(3, 3);
      expect(at(last, n + 1, 1)).toBeNaN();
      expect(at(last, 1, n + 1)).toBeNaN();
      expect(at(last, -1, n)).not.toBeNaN();
    });

    it('upsamples with the border the ancestor covers', () => {
      const pn = 8;
      const prow = pn + 1;
      const parent = new Float32Array(prow * prow);
      for (let j = 0; j <= pn; j++) for (let i = 0; i <= pn; i++) parent[j * prow + i] = 10 * i + 100 * j;
      // Child in the north-west quadrant: border outside the parent on the west and north only.
      const child = upsampleBorderedGrid(parent, pn, 5, 10, 20, 6, 20, 40, n);
      expect(at(child, -1, 1)).toBeNaN();
      expect(at(child, 1, -1)).toBeNaN();
      // East border inside the parent: the ramp continues (u = 0.5 + 1/8, v = 1/8).
      expect(at(child, n + 1, 1)).toBeCloseTo(10 * (0.5 + 1 / 8) * pn + 100 * (1 / 8) * pn, 3);
      expect(innerGrid(child, n)).toEqual(upsampleHeightGrid(parent, pn, 5, 10, 20, 6, 20, 40, n));
    });
  });
});
import {
  decodeQuantizedMesh,
  encodeQuantizedMesh,
  geographicTileRect,
  isTileAvailable,
  rasterizeQuantizedMesh,
  sampleGrid,
  type QuantizedMeshTile,
} from '../src/globe/terrain/quantizedMesh';

const Q = 32767;

function quad(): QuantizedMeshTile {
  // SW, SE, NW, NE corners; two triangles sharing the SE-NW diagonal.
  return {
    minHeight: 100,
    maxHeight: 300,
    u: new Uint16Array([0, Q, 0, Q]),
    v: new Uint16Array([0, 0, Q, Q]),
    h: new Uint16Array([0, Q, 16383, Q]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
  };
}

describe('quantized-mesh', () => {
  it('round-trips zig-zag vertices and high-water-mark indices', () => {
    const src = quad();
    const out = decodeQuantizedMesh(encodeQuantizedMesh(src));
    expect(out.minHeight).toBe(100);
    expect(out.maxHeight).toBe(300);
    expect([...out.u]).toEqual([...src.u]);
    expect([...out.v]).toEqual([...src.v]);
    expect([...out.h]).toEqual([...src.h]);
    expect([...out.indices]).toEqual([...src.indices]);
  });

  it('rasterizes triangles onto a south-up height grid', () => {
    const grid = rasterizeQuantizedMesh(quad(), 3);
    expect(grid[0]).toBeCloseTo(100, 3); // SW
    expect(grid[2]).toBeCloseTo(300, 3); // SE
    expect(grid[6]).toBeCloseTo(100 + (16383 / Q) * 200, 3); // NW
    expect(grid[8]).toBeCloseTo(300, 3); // NE
    // Center lies on the SE-NW diagonal.
    expect(grid[4]).toBeCloseTo((300 + 100 + (16383 / Q) * 200) / 2, 2);
    expect(sampleGrid(grid, 3, 0.5, 0.5)).toBeCloseTo(grid[4], 6);
    expect(sampleGrid(grid, 3, 0, 1)).toBeCloseTo(grid[6], 6);
  });

  it('uses EPSG:4326 geographic tiles with two root tiles and TMS rows', () => {
    expect(geographicTileRect(0, 0, 0)).toEqual({ west: -180, south: -90, size: 180 });
    expect(geographicTileRect(0, 1, 0)).toEqual({ west: 0, south: -90, size: 180 });
    expect(geographicTileRect(2, 5, 3)).toEqual({ west: 45, south: 45, size: 45 });
  });

  it('checks layer.json availability ranges', () => {
    const available = [[[0, 0, 1, 0]], [[0, 0, 3, 1]], [[2, 1, 2, 1]]];
    expect(isTileAvailable(available, 0, 1, 0)).toBe(true);
    expect(isTileAvailable(available, 2, 2, 1)).toBe(true);
    expect(isTileAvailable(available, 2, 3, 1)).toBe(false);
    // Levels beyond the list are unknown: try them.
    expect(isTileAvailable(available, 5, 9, 9)).toBe(true);
    expect(isTileAvailable(null, 3, 0, 0)).toBe(true);
  });
});
