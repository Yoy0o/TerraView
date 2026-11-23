/**
 * Gaussian splatting scenes for the demo: open captures for the "高斯泼溅" panel, and a
 * generated stand-in bound to the demo building (`createDemoPlantSplat`, at the end).
 *
 * The open scenes are the sample assets of the three.js examples (r187,
 * `examples/models/splat` and `examples/models/spz`), loaded from GitHub; each is published
 * under CC BY 4.0 by its author (credits below, shown in the panel). Small object captures
 * without a real-world scale: the demo enlarges them so that they read next to buildings.
 */
import type { SplatLayerOptions } from 'terra-view';

export interface SplatDemo {
  name: string;
  /** Format and size, for the tooltip. */
  note: string;
  /** Author and source of the capture (CC BY 4.0). */
  credit: { author: string; source: string };
  options: Omit<SplatLayerOptions, 'position'>;
}

const BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/models/';

export const SPLAT_DEMOS: SplatDemo[] = [
  {
    name: '狮子',
    note: 'SPZ 3 · 19.5 万个泼溅 · 2 阶球谐 · 4.3 MB',
    credit: { author: 'Renaud', source: 'https://superspl.at/scene/56155c3f' },
    options: { url: `${BASE}spz/lion.v3.spz`, name: '狮子', scale: 30 },
  },
  {
    name: '千足虫',
    note: '.splat · 11.6 万个泼溅 · 3.7 MB',
    credit: { author: 'Fabian Plum', source: 'https://superspl.at/scene/3d5482d4' },
    options: { url: `${BASE}splat/millipede.splat`, name: '千足虫', scale: 40 },
  },
  {
    name: '番茄',
    note: 'SPZ 4（Zstandard）· 44.5 万个泼溅 · 3 阶球谐 · 9.4 MB',
    credit: { author: 'Grail', source: 'https://superspl.at/scene/2826d2c0' },
    // SPZ's own convention: Y up.
    options: { url: `${BASE}spz/tomatoes.v4.spz`, name: '番茄', scale: 30, upAxis: '+y' },
  },
];

/** Where demo scenes go when the view is too far out to place them under it: beside the demo office building. */
export const SPLAT_DEMO_SITE = { longitude: 116.3942, latitude: 39.9989 };

/**
 * A stand-in for a captured object, generated in code so that the demo building can show a
 * level-bound splat scene without the network: a potted tree about 2.4 m tall, in meters
 * with Z up, as `.splat` rows (position, scale, RGBA, rotation). Not a real capture: the
 * point is how it is bound to a room of the building document (`splats` in indoor-bim.md §4).
 */
export function createDemoPlantSplat(): ArrayBuffer {
  let seed = 20261123;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows: number[][] = [];
  const add = (p: [number, number, number], s: [number, number, number], rgb: [number, number, number], alpha = 0.92) => {
    // A random rotation: the splats of a trained scene point every way.
    const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    rows.push([...p, ...s, ...rgb.map((c) => Math.max(0, Math.min(255, c))), alpha * 255, ...q.map((v) => (v / n) * 128 + 128)]);
  };
  const shade = (rgb: [number, number, number], amount: number): [number, number, number] => {
    const k = 1 + (random() - 0.5) * amount;
    return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
  };
  // Pot: a tapered cylinder with soil on top.
  for (let i = 0; i < 2600; i++) {
    const z = random() * 0.55;
    const r = 0.26 + z * 0.16;
    const a = random() * Math.PI * 2;
    add([Math.cos(a) * r, Math.sin(a) * r, z], [0.03, 0.03, 0.012], shade([176, 98, 62], 0.25));
  }
  for (let i = 0; i < 700; i++) {
    const r = Math.sqrt(random()) * 0.33;
    const a = random() * Math.PI * 2;
    add([Math.cos(a) * r, Math.sin(a) * r, 0.52 + random() * 0.03], [0.035, 0.035, 0.012], shade([58, 44, 34], 0.3));
  }
  // Trunk, slightly bent.
  for (let i = 0; i < 900; i++) {
    const t = random();
    const z = 0.5 + t * 1.1;
    const a = random() * Math.PI * 2;
    const r = 0.05 - t * 0.02;
    add([Math.cos(a) * r + Math.sin(t * 2.2) * 0.07, Math.sin(a) * r, z], [0.02, 0.02, 0.04], shade([104, 78, 52], 0.3));
  }
  // Foliage: a few overlapping blobs of flat leaves, lighter towards the top.
  const blobs: [number, number, number, number][] = [
    [0.1, 0, 1.85, 0.55],
    [-0.28, 0.18, 1.62, 0.38],
    [0.34, -0.2, 1.6, 0.36],
    [0.02, 0.3, 2.05, 0.34],
    [-0.1, -0.3, 1.95, 0.32],
  ];
  for (const [bx, by, bz, br] of blobs) {
    const count = Math.round(5200 * br * br * 3);
    for (let i = 0; i < count; i++) {
      // Denser towards the surface of the blob, like leaves.
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = br * (0.55 + 0.45 * Math.cbrt(random()));
      const s = Math.sqrt(1 - u * u);
      const z = bz + u * r * 0.85;
      const light = 0.75 + 0.5 * ((z - 1.3) / 1.1);
      const green: [number, number, number] = [52 * light + random() * 24, 128 * light + random() * 36, 58 * light];
      add([bx + Math.cos(a) * s * r, by + Math.sin(a) * s * r, z], [0.05 + random() * 0.03, 0.035, 0.008], green, 0.85);
    }
  }
  const bytes = new ArrayBuffer(rows.length * 32);
  const view = new DataView(bytes);
  rows.forEach((row, i) => {
    for (let k = 0; k < 6; k++) view.setFloat32(i * 32 + k * 4, row[k], true);
    for (let k = 0; k < 8; k++) view.setUint8(i * 32 + 24 + k, Math.round(Math.max(0, Math.min(255, row[6 + k]))));
  });
  return bytes;
}
