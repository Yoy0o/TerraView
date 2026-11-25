/**
 * 光照、阴影与云：真实太阳光照（按日期时间）、建筑的日照阴影、云壳与近地的体积云。
 *
 * 默认的"地图模式"显示影像原色；`viewer.lighting = true` 后按 `viewer.date` 计算太阳位置，
 * 有昼夜、晨昏，建筑和设备投下阴影。云层默认不显示，创建时或之后用 `clouds.set` 打开。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';
import sampleOffice from '../../docs/examples/sample-office.building.json';
import { setupExample } from '../shared/ui';

const ui = setupExample('lighting-clouds');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  // 示例建筑东南方的低空，朝西北看：下午的影子落在楼的东北侧
  initialView: { longitude: 116.3985, latitude: 39.9981, height: 150, heading: 320, pitch: -40 },
  // 云层默认不显示；体积云在 low 档位默认关，其余档位相机降到约 300 km 以下时出现
  clouds: { visible: true, coverage: 0.5 },
});
ui.attach(viewer);

// 一栋示例建筑（docs/examples/sample-office.building.json），用来看阴影；不给高度时自动贴地
const building = viewer.indoor.add(sampleOffice);

// ---------------------------------------------------------------- 光照与时间

/** 北京时间（UTC+8）当天 `hours` 时（可带小数）对应的时刻。 */
function beijingTime(hours: number): Date {
  const today = new Date(Date.now() + 8 * 3600e3); // 用 UTC 字段读北京日期
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + (hours - 8) * 3600e3);
}
const hoursOf = (date: Date) => (((date.getTime() / 3600e3 + 8) % 24) + 24) % 24;
const clock = (hours: number) => `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;

viewer.lighting = true; // 真实光照：太阳位置来自 viewer.date
viewer.date = beijingTime(14);

ui.section('光照与时间');
ui.toggle('真实光照（关闭为地图模式）', viewer.lighting, (on) => (viewer.lighting = on));
const timeSlider = ui.slider('北京时间', { min: 0, max: 24, step: 0.25, value: 14, format: clock }, (h) => (viewer.date = beijingTime(h)));
ui.select(
  '时间流速',
  [
    ['0', '暂停'],
    ['600', '1 秒 = 10 分钟'],
    ['3600', '1 秒 = 1 小时'],
  ],
  '0',
  (v) => (viewer.timeMultiplier = Number(v)), // 每真实秒推进的模拟秒数；不为 0 时画面一直在变
);
// 时间在走时把滑块跟上
viewer.events.on('frame', () => {
  if (viewer.timeMultiplier === 0) return;
  const h = hoursOf(viewer.date);
  timeSlider.value = String(h);
  timeSlider.nextElementSibling!.textContent = clock(h);
});
ui.toggle('大气', viewer.atmosphere, (on) => (viewer.atmosphere = on));
ui.toggle('星空', viewer.showStars, (on) => (viewer.showStars = on));

// ---------------------------------------------------------------- 阴影

ui.section('日照阴影');
ui.note('只在真实光照、太阳在地平线以上时出现；建筑和设备投影，落在建筑、地面、3D Tiles 上。');
ui.toggle('建筑阴影', viewer.shadows.enabled, (on) => (viewer.shadows.enabled = on));
ui.slider('阴影浓度', { min: 0, max: 1, step: 0.05, value: viewer.shadows.intensity, format: (v) => v.toFixed(2) }, (v) => (viewer.shadows.intensity = v));
ui.slider('边缘柔化', { min: 0.5, max: 4, step: 0.25, value: viewer.shadows.softness, format: (v) => `${v} 纹素` }, (v) => (viewer.shadows.softness = v));

// ---------------------------------------------------------------- 云

const cloudOptions = viewer.clouds.getOptions();
ui.section('云');
ui.toggle('云层', cloudOptions.visible, (on) => viewer.clouds.set({ visible: on }));
ui.slider('云量', { min: 0, max: 1, step: 0.05, value: cloudOptions.coverage, format: (v) => v.toFixed(2) }, (v) => viewer.clouds.set({ coverage: v }));
ui.toggle('近地体积云', cloudOptions.volumetric.enabled, (on) => viewer.clouds.set({ volumetric: on }));
ui.slider('云底高度', { min: 500, max: 4000, step: 100, value: cloudOptions.volumetric.bottom, format: (v) => `${v} m` }, (v) => viewer.clouds.set({ volumetric: { bottom: v } }));
ui.slider('风速', { min: 0, max: 30, step: 1, value: cloudOptions.volumetric.windSpeed, format: (v) => `${v} m/s` }, (v) =>
  // 风速 0 时云不动，画面可以静止下来做超采样、停画
  viewer.clouds.set({ volumetric: { windSpeed: v } }),
);

// ---------------------------------------------------------------- 视角

ui.section('视角');
ui.buttons([
  ['看建筑阴影', () => void viewer.flyToEntity(building, { heading: 320, pitch: -40 })],
  ['云下仰望', () => void viewer.flyTo({ longitude: 116.36, latitude: 39.95, height: 300, heading: 40, pitch: 12 })],
  ['云上俯瞰', () => void viewer.flyTo({ longitude: 116.3, latitude: 39.85, height: 9000, heading: 40, pitch: -25 })],
  ['太空', () => void viewer.flyTo({ longitude: 112, latitude: 30, height: 1.6e7, heading: 0, pitch: -90 })],
]);
