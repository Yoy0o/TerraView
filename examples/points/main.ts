/**
 * 点位标注与聚合：一组监测站记录（代码生成，散布在北京周围），图层样式 + 按属性的样式规则，
 * 文本模板，点击放大的聚合，以及点击点位时读出它的属性。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, type MarkerStyleName, type PointStyle } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('points');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.4, latitude: 39.62, height: 52_000, heading: 0, pitch: -55 },
});
ui.attach(viewer);

// ---------------------------------------------------------------- 数据：记录数组
// 每条记录有经纬度（度）和任意属性；不给高度，点会自动贴在地形上。
const TYPES = ['空气', '水质', '噪声'] as const;
let seed = 20261125;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const records = Array.from({ length: 600 }, (_, i) => {
  const r = 0.42 * Math.sqrt(random()); // 度，城区密、郊区疏
  const a = random() * Math.PI * 2;
  const roll = random();
  return {
    id: `st${String(i + 1).padStart(3, '0')}`,
    lon: 116.4 + r * Math.cos(a) * 1.3,
    lat: 39.91 + r * Math.sin(a),
    name: `${TYPES[i % 3]}站 ${i + 1}`,
    type: TYPES[i % 3],
    status: roll < 0.04 ? '告警' : roll < 0.12 ? '离线' : '正常',
    pm25: Math.round(20 + random() * 140),
  };
});

// ---------------------------------------------------------------- 样式与规则
// 文本字段是模板：{name}、{pm25} 换成该点的属性值。
const baseStyle: PointStyle = { style: 'badge', icon: '{pm25}', title: '{name}', maxDistance: 120_000 };

const layer = viewer.addPoints({
  name: '监测站',
  data: records,
  style: baseStyle,
  rules: [
    // 后面的规则覆盖前面的；一条规则里的条件要同时成立
    { when: { type: '水质' }, style: { color: '#38bdf8' } },
    { when: { type: '噪声' }, style: { color: '#a78bfa' } },
    { when: { pm25: { gt: 115 } }, style: { color: '#f59e0b' } },
    { when: { status: '离线' }, style: { color: '#8a94a6', subtitle: '离线' } },
    // 告警：呼吸点、红色、带徽章，优先级高，并且不参与避让（总是显示）
    { when: { status: '告警' }, style: { style: 'pulse', color: '#ff4d4f', badge: '告警', priority: 10, declutter: false } },
  ],
  cluster: { radius: 56, minPoints: 3 },
});

layer.events.on('ready', ({ count, skipped }) => ui.status(`已加载 ${count} 个点${skipped ? `，跳过 ${skipped} 条` : ''}`));

// ---------------------------------------------------------------- 交互
const picked = ui.output('点击');
layer.events.on('click', ({ point }) => {
  const p = point.properties;
  picked.set(`${p.name} · ${p.status} · PM2.5 ${p.pm25}`);
});
layer.events.on('clusterclick', ({ points }) => picked.set(`聚合点：${points.length} 个站点（相机飞到它们的范围）`));

ui.section('样式');
const styles: Array<[MarkerStyleName, string]> = [
  ['badge', '徽章 badge'],
  ['poi', '图钉 poi'],
  ['pin', '圆点 pin'],
  ['beacon', '光柱 beacon'],
  ['label', '文字 label'],
];
let symbolsOnly = false;
let current: MarkerStyleName = 'badge';
const applyStyle = () => layer.setStyle({ ...baseStyle, style: current, title: symbolsOnly ? '' : baseStyle.title }); // 规则照常生效
ui.select('基础样式', styles, current, (style) => {
  current = style;
  applyStyle();
});
ui.toggle('只画符号（title 为空）', symbolsOnly, (on) => {
  symbolsOnly = on;
  applyStyle();
});

ui.section('聚合');
let clusterOn = true;
let radius = 56;
const applyCluster = () => layer.setCluster(clusterOn ? { radius } : false); // 只在半径变化时重建聚合树
ui.toggle('聚合', clusterOn, (on) => {
  clusterOn = on;
  applyCluster();
});
ui.slider('聚合半径', { min: 24, max: 120, step: 4, value: radius, format: (v) => `${v} px` }, (v) => {
  radius = v;
  applyCluster();
});

ui.section('其他');
ui.buttons([
  ['飞到全部点位', () => layer.bbox && void viewer.flyToBBox(layer.bbox)],
  ['选中告警站', () => {
    const alarm = layer.points.find((p) => p.properties.status === '告警');
    if (!alarm) return;
    layer.select(alarm.id); // 高亮，避让中优先
    void viewer.flyTo({ longitude: alarm.longitude, latitude: alarm.latitude - 0.03, height: 4500, heading: 0, pitch: -50 });
  }],
  ['取消选中', () => layer.select(null)],
]);

const counts = ui.output('本帧');
let last = 0;
viewer.events.on('frame', () => {
  const now = performance.now();
  if (now - last < 500) return;
  last = now;
  counts.set(`${layer.stats.points} 个点、${layer.stats.clusters} 个聚合，DOM ${layer.stats.elements} 个`);
});
