/**
 * Polar caps of the globe: Web Mercator stops at about 85 degrees, so a cap mesh closes each
 * pole, tinted with the color the root tiles' imagery has along that edge.
 */
import { BufferAttribute, BufferGeometry, DataTexture, Mesh, SRGBColorSpace, type Group } from 'three';
import { geodeticNormal, geodeticToEcef } from '../core/geodesy';
import type { GlobeTile } from './GlobeTile';
import { createTileMaterial, MORPH_ATTRIBUTE } from './TileMaterial';
import { MERCATOR_MAX_LATITUDE, type WebMercatorTilingScheme } from './TilingScheme';

/** What the caps read of their globe. */
export interface CapsHost {
  readonly group: Group;
  readonly scheme: WebMercatorTilingScheme;
}

export class PolarCaps {
  readonly caps: Mesh[] = [];
  readonly capTextures: DataTexture[] = [];
  readonly capColors = [new Map<number, number[]>(), new Map<number, number[]>()];

  constructor(private readonly globe: CapsHost) {
    this.create();
  }

  private create(): void {
    for (const north of [true, false]) {
      const tex = new DataTexture(new Uint8Array(north ? [214, 226, 236, 255] : [236, 240, 244, 255]), 1, 1);
      tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      this.capTextures.push(tex);

      const rings = 8;
      const segs = 96;
      const sign = north ? 1 : -1;
      const lat0 = MERCATOR_MAX_LATITUDE * sign;
      const center = [0, 0, 0];
      geodeticToEcef(0, (Math.PI / 2) * sign, 0, center);
      const positions: number[] = [];
      const normals: number[] = [];
      const n = [0, 0, 0];
      const p = [0, 0, 0];
      const push = (lon: number, lat: number, h: number) => {
        geodeticToEcef(lon, lat, h, p);
        geodeticNormal(lon, lat, n);
        positions.push(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
        normals.push(n[0], n[1], n[2]);
      };
      for (let r = 0; r <= rings; r++) {
        const lat = lat0 + ((Math.PI / 2) * sign - lat0) * (r / rings);
        for (let s = 0; s <= segs; s++) push(-Math.PI + (2 * Math.PI * s) / segs, lat, 0);
      }
      const skirtStart = positions.length / 3;
      for (let s = 0; s <= segs; s++) push(-Math.PI + (2 * Math.PI * s) / segs, lat0, -60_000);

      const indices: number[] = [];
      const row = segs + 1;
      const tri = (a: number, b: number, c: number) => (north ? indices.push(a, b, c) : indices.push(a, c, b));
      for (let r = 0; r < rings; r++) {
        for (let s = 0; s < segs; s++) {
          const a = r * row + s;
          tri(a, a + 1, a + row);
          tri(a + 1, a + row + 1, a + row);
        }
      }
      for (let s = 0; s < segs; s++) {
        // Skirt hanging below the outer ring, facing away from the pole.
        tri(s, skirtStart + s, s + 1);
        tri(s + 1, skirtStart + s, skirtStart + s + 1);
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array((positions.length / 3) * 2).fill(0.5), 2));
      // Same attributes as tile meshes, so caps share their pipeline (never morphed).
      geometry.setAttribute(MORPH_ATTRIBUTE, new BufferAttribute(new Float32Array(positions.length / 3), 1));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, createTileMaterial(tex, 0));
      mesh.name = north ? 'north cap' : 'south cap';
      mesh.position.set(center[0], center[1], center[2]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.caps.push(mesh);
      this.globe.group.add(mesh);
    }
  }

  /** Averages the outermost pixel row of polar-row tiles to color the caps. */
  sampleCapColor(tile: GlobeTile, bitmap: ImageBitmap): void {
    const n = this.globe.scheme.tilesAtLevel(tile.level);
    const which = tile.y === 0 ? 0 : tile.y === n - 1 ? 1 : -1;
    if (which < 0) return;
    try {
      const canvas = new OffscreenCanvas(bitmap.width, 1);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, which === 0 ? 0 : bitmap.height - 1, bitmap.width, 1, 0, 0, bitmap.width, 1);
      const d = ctx.getImageData(0, 0, bitmap.width, 1).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        sum[0] += d[i];
        sum[1] += d[i + 1];
        sum[2] += d[i + 2];
      }
      const count = d.length / 4;
      this.capColors[which].set(tile.x, [sum[0] / count, sum[1] / count, sum[2] / count]);
      const all = [...this.capColors[which].values()];
      const avg = [0, 1, 2].map((k) => all.reduce((s, c) => s + c[k], 0) / all.length);
      const tex = this.capTextures[which];
      (tex.image.data as Uint8Array).set([avg[0], avg[1], avg[2], 255]);
      tex.needsUpdate = true;
    } catch {
      // Cross-origin or canvas failures only affect the cap tint.
    }
  }
}
