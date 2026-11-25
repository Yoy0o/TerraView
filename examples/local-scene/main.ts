/**
 * 局部场景（沙盘）：只显示一块区域，区域外不画不加载；边缘一圈土层侧壁，背景换成展台，
 * 相机被限制在区域周围活动。区域可以是圆、矩形或多边形（经纬度用度，半径用米）。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, type LocalSceneOptions } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('local-scene');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 118.12, latitude: 30.02, height: 16000, heading: 20, pitch: -40 },
});
ui.attach(viewer);

const REGIONS: Record<string, LocalSceneOptions['region']> = {
  // 圆：中心 [经度, 纬度]（度），半径（米，20 m – 50 km）
  circle: { type: 'circle', center: [118.168, 30.132], radius: 4500 },
  // 矩形：西、南、东、北（度）
  rectangle: { type: 'rectangle', west: 7.96, south: 46.55, east: 8.07, north: 46.62 },
  // 多边形：单环、不自交（度）；首尾不必重复
  polygon: {
    type: 'polygon',
    coordinates: [
      [120.128, 30.262],
      [120.146, 30.268],
      [120.163, 30.262],
      [120.162, 30.243],
      [120.15, 30.228],
      [120.134, 30.236],
    ],
  },
};
const NAMES: Record<string, string> = { circle: '黄山（圆）', rectangle: '艾格峰（矩形）', polygon: '西湖（多边形）' };

let regionKey = 'circle';
let outside: 'hide' | 'dim' = 'hide';
let walls = true;
let background: 'studio' | 'space' = 'studio';

const status = ui.output('状态', '地球');
viewer.localScene.events.on('enter', ({ region }) => status.set(`${NAMES[regionKey]} · 半径约 ${(region.radius / 1000).toFixed(1)} km`));
viewer.localScene.events.on('exit', () => status.set('地球'));

/** 进入（或换到）一个区域；再次调用 enter 即换区域、改外观。飞到总览、区域外淡出完成后 resolve。 */
function enter(key = regionKey): Promise<void> {
  regionKey = key;
  return viewer.localScene.enter({ region: REGIONS[key], outside, walls, background });
}

ui.section('区域');
ui.buttons([
  [NAMES.circle, () => void enter('circle')],
  [NAMES.rectangle, () => void enter('rectangle')],
  [NAMES.polygon, () => void enter('polygon')],
]);

ui.section('外观');
ui.select(
  '区域外',
  [
    ['hide', '不显示（沙盘）'],
    ['dim', '压暗（保留周边）'],
  ],
  outside,
  (v) => {
    outside = v;
    if (viewer.localScene.active) void enter(); // outside 只能经 enter 改
  },
);
ui.toggle('土层侧壁', walls, (on) => {
  walls = on;
  viewer.localScene.set({ walls: on }); // 侧壁、背景、相机、过渡可以用 set 直接改
});
ui.select(
  '背景',
  [
    ['studio', '展台'],
    ['space', '星空与大气'],
  ],
  background,
  (v) => {
    background = v;
    viewer.localScene.set({ background: v });
  },
);

ui.section('相机');
ui.note('拖动时视线不会离开区域，拉远有上限；双击区域外回到总览。');
ui.buttons([
  ['回到总览', () => void viewer.localScene.fit()],
  ['退出局部场景', () => void viewer.localScene.exit()], // 默认飞回进入前的视点
]);

const probe = ui.output('光标处', '—');
viewer.interaction.on(
  'mousemove',
  (e) => {
    if (!e.cartographic) return probe.set('区域外（拾取落空）');
    const lon = (e.cartographic.longitude * 180) / Math.PI;
    const lat = (e.cartographic.latitude * 180) / Math.PI;
    probe.set(`${lon.toFixed(4)}°, ${lat.toFixed(4)}° · ${viewer.localScene.contains(lon, lat) ? '区域内' : '区域外'}`);
  },
  { tag: 'example' },
);

await enter('circle');
