/**
 * Open 3D Gaussian splatting scenes for the "高斯泼溅" panel. They are the sample assets of
 * the three.js examples (r187, `examples/models/splat` and `examples/models/spz`), loaded
 * from GitHub; each is published under CC BY 4.0 by its author (credits below, shown in
 * the panel). Small object captures without a real-world scale: the demo enlarges them
 * so that they read next to buildings.
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
