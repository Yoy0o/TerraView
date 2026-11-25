/**
 * GeoJSON：贴地的面、线、点，按属性分类着色，名称注记，点击要素查看属性并高亮。
 *
 * 数据是在代码里生成的一个虚构园区（功能分区、道路、出入口），坐标是经纬度（度）。真实项目里
 * 通常写 `url: '/data/campus.geojson'`；解析、投影、栅格化都在 Worker 里，大文件不卡主线程。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('geojson');

// ---------------------------------------------------------------- 示例数据

const ORIGIN = { longitude: 116.3885, latitude: 40.0175 };
const DEG_PER_M_LAT = 1 / 111_320;
const DEG_PER_M_LON = 1 / (111_320 * Math.cos((ORIGIN.latitude * Math.PI) / 180));
/** 园区内的位置：向东 x 米、向北 y 米 → [经度, 纬度]（GeoJSON 的坐标顺序）。 */
const at = (x: number, y: number): [number, number] => [ORIGIN.longitude + x * DEG_PER_M_LON, ORIGIN.latitude + y * DEG_PER_M_LAT];

function zone(name: string, type: string, x0: number, y0: number, x1: number, y1: number, extra: Record<string, unknown> = {}) {
  const ring = [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
  return { type: 'Feature', properties: { name, type, 面积: `${Math.abs((x1 - x0) * (y1 - y0))} m²`, ...extra }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function road(name: string, level: string, points: Array<[number, number]>, width: number) {
  // simplestyle-spec 的 stroke / stroke-width 写在要素属性里，逐要素覆盖图层样式
  return { type: 'Feature', properties: { name, 等级: level, stroke: '#f8fafc', 'stroke-width': width }, geometry: { type: 'LineString', coordinates: points.map(([x, y]) => at(x, y)) } };
}

function poi(name: string, type: string, x: number, y: number, color: string) {
  return { type: 'Feature', properties: { name, type, 'marker-color': color }, geometry: { type: 'Point', coordinates: at(x, y) } };
}

const campus = {
  type: 'FeatureCollection',
  features: [
    zone('办公楼 A', '办公', -280, 40, -120, 160, { 楼层: 12 }),
    zone('办公楼 B', '办公', -280, -160, -120, -40, { 楼层: 9 }),
    zone('研发中心', '研发', -60, 40, 140, 170, { 楼层: 6 }),
    zone('实验楼', '研发', -60, -170, 60, -40, { 楼层: 4 }),
    zone('中心绿地', '绿地', 180, -170, 300, 170),
    zone('地面停车场', '停车', 80, -170, 150, -40, { 车位: 180 }),
    road('园区主路', '主路', [[-320, 0], [320, 0]], 6),
    road('东环路', '支路', [[160, -200], [160, 200]], 3),
    road('西环路', '支路', [[-90, -200], [-90, 200]], 3),
    poi('北门', '出入口', -90, 200, '#22c55e'),
    poi('西门', '出入口', -320, 0, '#22c55e'),
    poi('园区公交站', '公交站', 240, 10, '#f59e0b'),
  ],
};

// ---------------------------------------------------------------- viewer 与图层

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: ORIGIN.longitude, latitude: ORIGIN.latitude - 0.0048, height: 650, heading: 0, pitch: -48 },
});
ui.attach(viewer);

const layer = viewer.addGeoJson({
  name: '示例园区',
  data: campus, // 也可以是 JSON 文本，或用 url 让 Worker 去下载
  style: { colorBy: 'type', fillOpacity: 0.45, stroke: '#ffffff', strokeWidth: 1.5, pointRadius: 6 },
  label: { field: 'name', size: 14 },
});

const summary = ui.output('图层', '加载中…');
layer.events.on('ready', (s) => summary.set(`${s.featureCount} 个要素，字段：${s.propertyKeys.join('、')}`));
layer.events.on('error', ({ message }) => summary.set(`加载失败：${message}`));

// ---------------------------------------------------------------- 点击查询

const picked = ui.output('要素', '点击一个面、线或点');
viewer.interaction.on(
  'click',
  async (e) => {
    // 先看注记，再看贴地的几何；查询在 Worker 里做，所以是异步的
    const pick = await viewer.pickFeature(e.clientX, e.clientY);
    viewer.highlightFeature(pick?.hit ?? null);
    if (!pick) return picked.set('（没有点到要素）');
    const props = Object.entries(pick.hit.properties)
      .filter(([key]) => !['stroke', 'stroke-width', 'marker-color'].includes(key))
      .map(([key, value]) => `${key}: ${String(value)}`);
    picked.set(`${pick.layer.name} · ${pick.hit.kind} · ${props.join('，')}`);
  },
  { tag: 'example' },
);

// ---------------------------------------------------------------- 控件

ui.section('样式');
ui.toggle('显示图层', true, (v) => (layer.visible = v));
ui.select(
  '填充颜色',
  [
    ['type', '按 type 分类'],
    ['none', '统一颜色'],
  ],
  'type',
  (v) => layer.setStyle(v === 'type' ? { colorBy: 'type' } : { colorBy: null, fill: '#38bdf8' }),
);
ui.slider('填充不透明度', { min: 0, max: 1, step: 0.05, value: 0.45, format: (v) => v.toFixed(2) }, (v) => layer.setStyle({ fillOpacity: v }));
ui.toggle('名称注记', true, (v) => void layer.setLabelStyle({ enabled: v }));
ui.buttons([
  ['缩放到图层', () => layer.summary?.bbox && void viewer.flyToBBox(layer.summary.bbox)],
  ['取消高亮', () => viewer.highlightFeature(null)],
]);
