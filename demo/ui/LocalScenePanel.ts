/**
 * "局部场景" section of the control panel: enter a local scene (sandbox) from the current view
 * or by drawing a rectangle, circle or polygon on the globe, pick its look, leave it. Only
 * uses the public `viewer.localScene` API; drawing goes through `viewer.interaction`.
 */
import {
  type GeoJsonLayer,
  type GeoViewer,
  type InteractionEvent,
  type LocalRegion,
  type LocalSceneOptions,
  MAX_REGION_DIAMETER,
  MIN_REGION_RADIUS,
  RAD2DEG,
} from 'terra-viewer';
import { h, section } from './dom';
import { describeError } from './errors';

type Look = 'sandbox' | 'float' | 'dim';
type Shape = 'rectangle' | 'circle' | 'polygon';
type LonLat = [number, number];

const LOOK_NAMES: Record<Look, string> = { sandbox: '沙盘（带侧壁）', float: '悬浮地块（无侧壁）', dim: '区域外压暗' };
const SHAPE_HINTS: Record<Shape, string> = {
  rectangle: '单击第一个角，移动鼠标，再单击对角完成。Esc 取消。',
  circle: '单击圆心，移动鼠标调半径，再单击完成。Esc 取消。',
  polygon: '单击加点，双击或回车完成；Backspace / 右键单击撤销上一点；Esc 取消。',
};
const EARTH_RADIUS = 6_371_008;

/** Great-circle distance in meters between two [lon, lat] in degrees. */
function distance(a: LonLat, b: LonLat): number {
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A ring of [lon, lat] approximating a circle (for the preview). */
function circleRing(center: LonLat, radius: number, n = 64): LonLat[] {
  const ring: LonLat[] = [];
  const k = radius / EARTH_RADIUS;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const lat = center[1] + ((Math.sin(a) * k) * 180) / Math.PI;
    const lon = center[0] + ((Math.cos(a) * k) * 180) / Math.PI / Math.cos((center[1] * Math.PI) / 180);
    ring.push([lon, lat]);
  }
  return ring;
}

export class LocalScenePanel {
  readonly root: HTMLElement;
  private readonly status = h('p', { class: 'hint' });
  private readonly drawHint = h('p', { class: 'hint' });
  private readonly look = h('select', { 'aria-label': '局部场景外观' });
  private readonly background = h('select', { 'aria-label': '局部场景背景' });
  private readonly exitBtn = h('button', { class: 'btn' }, '退出局部场景');
  private readonly fitBtn = h('button', { class: 'btn ghost' }, '回到总览');
  private lastRegion: LocalRegion | null = null;
  // Drawing state.
  private shape: Shape | null = null;
  private points: LonLat[] = [];
  private cursor: LonLat | null = null;
  private offs: (() => void)[] = [];
  private resume: (() => void) | null = null;
  private preview: GeoJsonLayer | null = null;
  private previewTimer = 0;

  constructor(
    private readonly viewer: GeoViewer,
    private readonly notify: (text: string, kind?: 'info' | 'error') => void,
  ) {
    for (const [id, name] of Object.entries(LOOK_NAMES)) this.look.append(h('option', { value: id }, name));
    for (const [id, name] of [
      ['studio', '展台背景'],
      ['space', '星空与大气'],
      ['#000000', '纯黑'],
    ]) {
      this.background.append(h('option', { value: id }, name));
    }
    this.look.addEventListener('change', () => this.reapply());
    this.background.addEventListener('change', () => this.reapply());
    const view = h('button', { class: 'chip', title: '以屏幕中心为圆心、画面中可见的地面为范围' }, '当前视野');
    view.addEventListener('click', () => this.enterCurrentView());
    const chips: HTMLElement[] = [view];
    for (const [shape, name] of [
      ['rectangle', '画矩形'],
      ['circle', '画圆'],
      ['polygon', '画多边形'],
    ] as const) {
      const b = h('button', { class: 'chip' }, name);
      b.addEventListener('click', () => this.startDraw(shape));
      chips.push(b);
    }
    this.fitBtn.addEventListener('click', () => void viewer.localScene.fit());
    this.exitBtn.addEventListener('click', () => void viewer.localScene.exit());
    this.drawHint.hidden = true;
    this.root = section(
      '局部场景（沙盘）',
      h('p', { class: 'hint' }, '只显示一块园区或城区（直径不超过 100 km）的地形、影像与 3D Tiles，区域外不绘制、不加载。'),
      h('div', { class: 'chips' }, ...chips),
      this.drawHint,
      h('div', { class: 'row' }, this.look, this.background),
      h('div', { class: 'row' }, this.fitBtn, this.exitBtn),
      this.status,
    );
    viewer.localScene.events.on('enter', () => this.render());
    viewer.localScene.events.on('exit', () => this.render());
    window.addEventListener('keydown', this.onKey);
    this.render();
  }

  /** Whether a shape is being drawn (Esc cancels it before anything else). */
  get drawing(): boolean {
    return this.shape !== null;
  }

  /** Enters a local scene; options from the panel unless given. Reports invalid regions. */
  enter(region: LocalRegion, look?: Look): void {
    if (look) this.look.value = look;
    this.lastRegion = region;
    try {
      void this.viewer.localScene.enter({ region, ...this.lookOptions() });
    } catch (e) {
      this.notify(`无法进入局部场景：${describeError(e)}`, 'error');
    }
  }

  private lookOptions(): Omit<LocalSceneOptions, 'region'> {
    const look = this.look.value as Look;
    return {
      outside: look === 'dim' ? 'dim' : 'hide',
      walls: look !== 'float',
      background: this.background.value,
    };
  }

  /** Look or background changed: enter again with the same area (no flight). */
  private reapply(): void {
    if (!this.viewer.localScene.active || !this.lastRegion) return;
    try {
      void this.viewer.localScene.enter({ region: this.lastRegion, ...this.lookOptions(), camera: { fit: false } });
    } catch (e) {
      this.notify(describeError(e), 'error');
    }
  }

  private render(): void {
    const r = this.viewer.localScene.region;
    this.exitBtn.disabled = !r;
    this.fitBtn.disabled = !r;
    if (!r) {
      this.status.textContent = '未开启。';
      return;
    }
    const km = (r.radius / 1000).toFixed(r.radius < 10_000 ? 2 : 1);
    this.status.textContent = `已开启：${r.kind === 'circle' ? `圆，半径 ${km} km` : `多边形，${r.vertices.length / 2} 个顶点，外接半径 ${km} km`}。双击区域外回到总览，Esc 退出。`;
  }

  // ---------------------------------------------------------------------------
  // Current view

  private enterCurrentView(): void {
    const canvas = this.viewer.canvas.getBoundingClientRect();
    const cx = canvas.left + canvas.width / 2;
    const center = this.viewer.pickCartographic(cx, canvas.top + canvas.height / 2);
    if (!center) {
      this.notify('屏幕中心没有地面，请先把视角对准地面。', 'error');
      return;
    }
    const c: LonLat = [center.longitude * RAD2DEG, center.latitude * RAD2DEG];
    const lower = this.viewer.pickCartographic(cx, canvas.top + canvas.height * 0.85);
    let radius = lower ? distance(c, [lower.longitude * RAD2DEG, lower.latitude * RAD2DEG]) : this.viewer.getView().height * 0.6;
    const max = MAX_REGION_DIAMETER / 2;
    if (radius > max) this.notify(`当前视野超过 ${max / 1000} km 半径，按 ${max / 1000} km 处理。`);
    radius = Math.min(max, Math.max(MIN_REGION_RADIUS * 10, radius));
    this.enter({ type: 'circle', center: c, radius });
  }

  // ---------------------------------------------------------------------------
  // Drawing

  private startDraw(shape: Shape): void {
    this.stopDraw();
    // Draw on the whole globe: leave a running local scene where it is.
    if (this.viewer.localScene.active) void this.viewer.localScene.exit({ restoreView: false });
    this.shape = shape;
    this.points = [];
    this.cursor = null;
    this.drawHint.textContent = SHAPE_HINTS[shape];
    this.drawHint.hidden = false;
    const it = this.viewer.interaction;
    // No entering buildings and no double-click flight while drawing.
    this.resume = it.pause({ tag: 'indoor', blockDefault: true });
    const opts = { tag: 'region-draw', priority: 100 };
    this.offs.push(
      it.on('click', (e) => this.onClick(e), opts),
      it.on('dblclick', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (this.shape === 'polygon') this.finishPolygon();
      }, opts),
      it.on('rightclick', (e) => {
        e.stopImmediatePropagation();
        this.undo();
      }, opts),
      it.on('mousemove', (e) => {
        this.cursor = this.lonLatOf(e);
        this.schedulePreview();
      }, opts),
    );
  }

  /** Cancels drawing (Esc). */
  cancelDraw(): void {
    if (!this.shape) return;
    this.stopDraw();
    this.notify('已取消绘制。');
  }

  private stopDraw(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.resume?.();
    this.resume = null;
    this.shape = null;
    this.points = [];
    this.cursor = null;
    this.drawHint.hidden = true;
    window.clearTimeout(this.previewTimer);
    if (this.preview) this.viewer.removeGeoJson(this.preview);
    this.preview = null;
  }

  private lonLatOf(e: InteractionEvent): LonLat | null {
    const c = e.cartographic;
    return c ? [c.longitude * RAD2DEG, c.latitude * RAD2DEG] : null;
  }

  private onClick(e: InteractionEvent): void {
    e.stopImmediatePropagation();
    const p = this.lonLatOf(e);
    if (!p || !this.shape) return;
    this.points.push(p);
    if (this.shape === 'rectangle' && this.points.length === 2) {
      const [a, b] = this.points;
      this.finish({ type: 'rectangle', west: Math.min(a[0], b[0]), south: Math.min(a[1], b[1]), east: Math.max(a[0], b[0]), north: Math.max(a[1], b[1]) });
    } else if (this.shape === 'circle' && this.points.length === 2) {
      const [c, edge] = this.points;
      const radius = Math.min(MAX_REGION_DIAMETER / 2, Math.max(MIN_REGION_RADIUS, distance(c, edge)));
      this.finish({ type: 'circle', center: c, radius });
    } else {
      this.schedulePreview();
    }
  }

  private undo(): void {
    if (this.shape !== 'polygon' || this.points.length === 0) return;
    this.points.pop();
    this.schedulePreview();
  }

  private finishPolygon(): void {
    // The two clicks of the double click added the last point twice: drop near-duplicates.
    const ring: LonLat[] = [];
    for (const p of this.points) {
      const q = ring[ring.length - 1];
      if (!q || distance(p, q) > 0.5) ring.push(p);
    }
    if (ring.length < 3) {
      this.notify('多边形至少需要 3 个点。', 'error');
      return;
    }
    this.finish({ type: 'polygon', coordinates: ring });
  }

  private finish(region: LocalRegion): void {
    this.stopDraw();
    this.enter(region);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.shape) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Enter' && this.shape === 'polygon') this.finishPolygon();
    else if (e.key === 'Backspace') {
      e.preventDefault();
      this.undo();
    }
  };

  /** Redraws the preview at most every 120 ms (draped vectors are rasterized in a worker). */
  private schedulePreview(): void {
    if (this.previewTimer) return;
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.updatePreview();
    }, 120);
  }

  private updatePreview(): void {
    if (!this.shape) return;
    const pts = this.cursor ? [...this.points, this.cursor] : [...this.points];
    let geometry: unknown = null;
    if (this.shape === 'rectangle' && pts.length >= 2) {
      const [a, b] = pts;
      geometry = { type: 'Polygon', coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
    } else if (this.shape === 'circle' && pts.length >= 2) {
      geometry = { type: 'Polygon', coordinates: [circleRing(pts[0], distance(pts[0], pts[1]))] };
    } else if (this.shape === 'polygon' && pts.length >= 2) {
      geometry = pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : { type: 'LineString', coordinates: pts };
    }
    if (this.preview) this.viewer.removeGeoJson(this.preview);
    this.preview = null;
    if (!geometry) return;
    this.preview = this.viewer.addGeoJson({
      name: '区域预览',
      data: { type: 'Feature', properties: {}, geometry },
      style: { stroke: '#5aa9ff', strokeWidth: 2, fill: '#5aa9ff', fillOpacity: 0.18, strokeOpacity: 1 },
      label: false,
    });
  }

  dispose(): void {
    this.stopDraw();
    window.removeEventListener('keydown', this.onKey);
  }
}

/**
 * `?region=` from the URL: `circle:lon,lat,radiusKm`, `rect:west,south,east,north` or
 * `poly:lon,lat;lon,lat;...` (degrees). Null when absent or malformed.
 */
export function parseRegionParam(value: string | null): LocalRegion | null {
  if (!value) return null;
  const [kind, rest = ''] = value.split(':', 2);
  const nums = (s: string) => s.split(',').map((x) => Number(x.trim()));
  if (kind === 'circle') {
    const [lon, lat, km] = nums(rest);
    return [lon, lat, km].every(Number.isFinite) ? { type: 'circle', center: [lon, lat], radius: km * 1000 } : null;
  }
  if (kind === 'rect') {
    const [west, south, east, north] = nums(rest);
    return [west, south, east, north].every(Number.isFinite) ? { type: 'rectangle', west, south, east, north } : null;
  }
  if (kind === 'poly') {
    const coordinates = rest.split(';').map((p) => nums(p) as [number, number]);
    return coordinates.length >= 3 && coordinates.every((c) => c.length === 2 && c.every(Number.isFinite)) ? { type: 'polygon', coordinates } : null;
  }
  return null;
}

/** `?regionLook=sandbox|float|dim`. */
export function parseRegionLook(value: string | null): Look | undefined {
  return value === 'sandbox' || value === 'float' || value === 'dim' ? value : undefined;
}
