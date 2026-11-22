import { SPLAT_DEMOS, SPLAT_DEMO_SITE } from '../data/demoSplats';
import { type GeoViewer, type SplatLayer, type SplatLayerOptions, type SplatUpAxis } from 'terra-view';
import { Vector2 } from 'three';
import { describeError } from './errors';
import { h, section, slider } from './dom';

type Notify = (text: string, kind?: 'info' | 'error') => void;

const UP_AXES: [SplatUpAxis, string][] = [
  ['-y', 'Y 朝下（3DGS / COLMAP）'],
  ['+y', 'Y 朝上（glTF / SPZ）'],
  ['+z', 'Z 朝上（测绘）'],
];

const FORMAT_NAMES = { ply: 'PLY', splat: '.splat', spz: 'SPZ' } as const;
/** Above this camera height the view center is no place to put a scene of a few meters. */
const PLACE_MAX_HEIGHT = 20_000;
const CENTER = new Vector2(0, 0);

const count = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万` : String(n));
const megabytes = (bytes: number) => `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 1 : 0)} MB`;

/**
 * "高斯泼溅" section: open sample scenes, URL / file loading and, per layer, placement
 * (click the ground to move it, heading, scale, height), axis convention, opacity, a crop
 * radius, zoom-to and removal. Clicking a scene in the view reports the picked position.
 */
export class SplatPanel {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'layer-list' });
  /** Layer waiting for a click on the ground to be moved there. */
  private placing: SplatLayer | null = null;
  /** Rows by layer, so that sliders keep their state while other layers load. */
  private readonly rows = new Map<SplatLayer, HTMLElement>();

  constructor(
    private readonly viewer: GeoViewer,
    private readonly notify: Notify,
  ) {
    const chips = SPLAT_DEMOS.map((d) => {
      const b = h('button', { class: 'chip', title: `${d.note}\n作者 ${d.credit.author}，CC BY 4.0\n${d.credit.source}` }, d.name);
      b.addEventListener('click', () => this.load({ ...d.options, position: this.placeHere() }));
      return b;
    });

    const urlInput = h('input', { type: 'url', placeholder: 'https://…/scene.ply | .splat | .spz' });
    const loadUrl = h('button', { class: 'btn' }, '加载');
    loadUrl.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return this.notify('请填写高斯泼溅文件地址', 'error');
      this.load({ url, position: this.placeHere() });
    });

    const fileInput = h('input', { type: 'file', accept: '.ply,.splat,.spz', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void this.loadFiles(fileInput.files);
      fileInput.value = '';
    });
    const openFile = h('button', { class: 'btn ghost' }, '打开泼溅文件…');
    openFile.addEventListener('click', () => fileInput.click());

    this.root = section(
      '高斯泼溅（3DGS）',
      h('div', { class: 'chips' }, ...chips),
      h('div', { class: 'row' }, urlInput, loadUrl),
      h('div', { class: 'row' }, openFile, fileInput, h('span', { class: 'hint' }, '.ply / .splat / .spz 可直接拖进窗口')),
      this.list,
    );
    viewer.events.on('splats-changed', () => this.render());
    // A click on a scene reports where it was hit; while placing, the next click on the ground moves the layer.
    viewer.interaction.on(
      'click',
      (e) => {
        if (this.placing) {
          const layer = this.placing;
          this.placing = null;
          this.viewer.canvas.style.cursor = '';
          if (e.cartographic && viewer.splatLayers.includes(layer)) {
            layer.setPlacement({ longitude: (e.cartographic.longitude * 180) / Math.PI, latitude: (e.cartographic.latitude * 180) / Math.PI, heightReference: 'ground', height: 0 });
            this.notify(`已移动：${layer.name}`);
          }
          this.render();
          // The click placed the layer: it must not select a building or anything else.
          e.stopImmediatePropagation();
          return;
        }
        if (e.kind !== 'splats' || !e.splats || !e.cartographic) return;
        const c = e.cartographic;
        this.notify(`${e.splats.name}：${((c.longitude * 180) / Math.PI).toFixed(6)}°，${((c.latitude * 180) / Math.PI).toFixed(6)}°，高 ${c.height.toFixed(2)} m`);
      },
      { tag: 'splat-panel', priority: 10 },
    );
    this.render();
  }

  /** Under the view center when the camera is close enough to see a scene there, else the demo site. */
  private placeHere(): { longitude: number; latitude: number } {
    const view = this.viewer.getView();
    const hit = view.height < PLACE_MAX_HEIGHT ? this.viewer.pick(CENTER) : null;
    const c = hit && hit.source !== 'splats' ? this.viewer.ellipsoid.cartesianToCartographic(hit.point) : null;
    return c ? { longitude: (c.longitude * 180) / Math.PI, latitude: (c.latitude * 180) / Math.PI } : SPLAT_DEMO_SITE;
  }

  /** Adds a splat layer and reports the result; flies to it once loaded. */
  load(options: SplatLayerOptions, flyTo = true): SplatLayer {
    const layer = this.viewer.addSplats(options);
    this.notify(`正在加载高斯泼溅：${layer.name}`);
    layer.events.on('progress', () => this.updateStatus(layer));
    layer.events.on('ready', ({ stats }) => {
      const dropped = stats.sourceCount - stats.loadedCount;
      this.notify(`已加载：${layer.name}（${count(stats.loadedCount)}个泼溅${dropped > 0 ? `，按显存预算舍去 ${count(dropped)}个` : ''}）`);
      if (flyTo) void layer.flyTo();
    });
    layer.events.on('error', ({ error }) => this.notify(`高斯泼溅加载失败：${layer.name}：${describeError(error)}`, 'error'));
    return layer;
  }

  async loadFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      try {
        this.load({ data: await file.arrayBuffer(), name: file.name, position: this.placeHere() });
      } catch (err) {
        this.notify(`读取 ${file.name} 失败：${describeError(err)}`, 'error');
      }
    }
  }

  private status(layer: SplatLayer): string {
    if (layer.error) return '加载失败';
    const s = layer.stats;
    if (!layer.ready || !s) return layer.progress > 0 ? `下载 ${(layer.progress * 100).toFixed(0)}%` : '加载中…';
    const sh = s.shDegree > 0 ? ` · ${s.shDegree} 阶球谐` : '';
    return `${count(s.count)}个 · ${FORMAT_NAMES[s.format]}${sh} · 显存 ${megabytes(layer.gpuBytes)}`;
  }

  private updateStatus(layer: SplatLayer): void {
    const el = this.rows.get(layer)?.querySelector('.splat-status');
    if (el) el.textContent = this.status(layer);
  }

  private render(): void {
    const layers = this.viewer.splatLayers;
    for (const layer of [...this.rows.keys()]) if (!layers.includes(layer)) this.rows.delete(layer);
    this.list.replaceChildren();
    if (layers.length === 0) {
      this.list.append(h('p', { class: 'hint' }, '示例为 three.js 示例库中的开放数据（CC BY 4.0，作者见按钮提示）。场景放在视图中心的地面上；单击场景显示拾取位置。'));
      return;
    }
    for (const layer of [...layers].reverse()) {
      // Rows are rebuilt when a layer becomes ready (its controls depend on the loaded scene).
      const key = layer.ready ? 'ready' : 'loading';
      let row = this.rows.get(layer);
      if (!row || row.dataset.state !== key) {
        row = this.row(layer);
        row.dataset.state = key;
        this.rows.set(layer, row);
      }
      this.updateStatus(layer);
      this.list.append(row);
    }
  }

  private row(layer: SplatLayer): HTMLElement {
    const v = this.viewer;
    const vis = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
    vis.checked = layer.visible;
    vis.addEventListener('change', () => (layer.visible = vis.checked));
    const name = h('span', { class: 'layer-name', title: layer.name }, layer.name);
    const fly = h('button', { class: 'icon-btn', title: '缩放到场景' }, '⌖');
    fly.addEventListener('click', () => void layer.flyTo());
    const remove = h('button', { class: 'icon-btn', title: '移除图层' }, '✕');
    remove.addEventListener('click', () => {
      if (this.placing === layer) this.placing = null;
      v.removeSplats(layer);
    });
    const head = h('div', { class: 'vlayer-line' }, vis, name, fly, remove);
    // Splat count, format, spherical harmonics and video memory: too long for the name's line.
    const status = h('div', { class: 'hint splat-status' }, this.status(layer));
    if (!layer.ready) return h('div', { class: 'vlayer' }, head, status);

    const p = layer.placement;
    const axis = h('select', { class: 'field-select', title: '文件里哪个方向朝上', 'aria-label': '上方向' });
    for (const [value, label] of UP_AXES) axis.append(h('option', { value }, label));
    axis.value = layer.upAxis;
    axis.addEventListener('change', () => (layer.upAxis = axis.value as SplatUpAxis));
    const place = h('button', { class: 'btn small', title: '在地面上单击一点，把场景移到那里' }, '点选位置');
    place.addEventListener('click', () => {
      this.placing = this.placing === layer ? null : layer;
      v.canvas.style.cursor = this.placing ? 'crosshair' : '';
      if (this.placing) this.notify(`单击地面，放置 ${layer.name}`);
    });

    const heading = slider('朝向', { min: 0, max: 360, step: 1, value: p.heading, format: (x) => `${x}°` }, (x) => layer.setPlacement({ heading: x }));
    // Scale on a logarithmic slider: captures come in arbitrary units.
    const scale = slider('缩放', { min: -2, max: 3, step: 0.01, value: Math.log10(p.scale), format: (x) => `×${formatScale(10 ** x)}` }, (x) => layer.setPlacement({ scale: 10 ** x }));
    const height = slider('离地', { min: -20, max: 100, step: 0.1, value: p.height, format: (x) => `${x.toFixed(1)} m` }, (x) => layer.setPlacement({ height: x }));
    const opacity = slider('不透明度', { min: 0, max: 1, step: 0.01, value: layer.opacity, format: (x) => `${Math.round(x * 100)}%` }, (x) => (layer.opacity = x));

    // Crop: a sphere around the middle of the scene, as a share of its size (100 % = no crop).
    const box = layer.localBounds!;
    const middle: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const radius = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
    const crop = slider('裁剪', { min: 5, max: 100, step: 1, value: 100, format: (x) => (x >= 100 ? '不裁剪' : `${x}%`) }, () => undefined);
    // The splats are filtered and uploaded again: on release, not while dragging.
    crop.input.addEventListener('change', () => {
      const share = Number(crop.input.value);
      layer.crop = share >= 100 ? null : { type: 'sphere', center: middle, radius: (radius * share) / 100 };
      this.updateStatus(layer);
    });

    return h(
      'div',
      { class: 'vlayer' },
      head,
      status,
      h('div', { class: 'vlayer-line' }, axis, place),
      heading.root,
      scale.root,
      height.root,
      opacity.root,
      crop.root,
    );
  }
}

function formatScale(x: number): string {
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
}
