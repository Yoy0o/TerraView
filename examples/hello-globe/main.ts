/**
 * 最小接入：一个容器、一个底图、一个地形源。
 *
 * 宿主工程里只需要前三行 import 和 `GeoViewer.create(...)`；`setupExample` 是示例页面自己的
 * 面板和错误提示，与 SDK 无关。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('hello-globe');

const viewer = await GeoViewer.create({
  // 任意有尺寸的元素，不必铺满窗口；尺寸变化会自动跟随
  container: ui.container,
  // 底图影像，必填。ArcGIS 卫星影像免密钥，署名由影像源自己带着
  imagery: findImageryPreset('esri-imagery')!.create(),
  // 全球地形，可选：AWS Terrain Tiles（Terrarium 编码，免密钥）
  terrain: AWS_TERRARIUM,
  // 经纬度、航向、俯仰用度，高度是 WGS84 椭球高（米）
  initialView: { longitude: 116.391, latitude: 39.9, height: 2200, heading: 0, pitch: -38 },
});
ui.attach(viewer);

// 渲染后端和适配器：WebGPU 不可用时自动回退 WebGL 2
const backend = ui.output('后端', viewer.info.backend);
ui.output('显存档位', viewer.gpu.tier);
const view = ui.output('视点');
const showView = () => {
  const v = viewer.getView(); // 度、米
  view.set(`${v.longitude.toFixed(4)}°, ${v.latitude.toFixed(4)}°, ${Math.round(v.height)} m`);
};
showView();
viewer.controller.events.on('change', showView);
viewer.events.on('idle', () => backend.set(`${viewer.info.backend}（当前视图已加载完）`));

ui.note('左键拖动平移，滚轮缩放到光标处，右键拖动调航向和俯仰。');
ui.buttons([
  ['回到初始视角', () => viewer.navigation.home()],
  ['飞到上海', () => void viewer.flyTo({ longitude: 121.4996, latitude: 31.2397, height: 2600, heading: 300, pitch: -35 })],
]);
