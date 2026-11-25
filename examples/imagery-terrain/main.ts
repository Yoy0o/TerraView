/**
 * 影像、叠加层与地形：切换底图预设，自定义一个 XYZ 影像源，叠加半透明的注记 / 路网图层，
 * 开关地形与地形夸张，并把各数据源的署名显示出来（这是宿主的责任，SDK 不画署名）。
 *
 * 换底图、换地形用的是 `viewer.globe`（高级 API）；叠加层用 `viewer.overlays`（稳定 API）。
 */
import 'terra-viewer/style.css';
import {
  AWS_TERRARIUM,
  findImageryPreset,
  findOverlayPreset,
  GeoViewer,
  localize,
  XYZImageryProvider,
  type ImageryProvider,
  type RasterOverlay,
} from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('imagery-terrain');

// 从南面约 45 km 处看珠穆朗玛峰；相机高 28 km，地形夸张到 3 倍时山顶（约 26 km）仍在相机以下
const EVEREST = { longitude: 86.925, latitude: 27.58, height: 28000, heading: 0, pitch: -22 };

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  // 地形夸张：高度乘以它（1 = 真实高度）
  terrainExaggeration: 1,
  initialView: EVEREST,
});
ui.attach(viewer);

// ---------------------------------------------------------------- 底图

/** 自定义 XYZ 影像源：任何 {z}/{x}/{y} 瓦片服务都能这样接入。 */
function openTopoMap(): ImageryProvider {
  return new XYZImageryProvider({
    id: 'opentopomap',
    name: 'OpenTopoMap',
    // 占位符：{z} {x} {y}，TMS 行号用 {-y}，子域名 {s}（轮流取 subdomains），以及 params 里的键
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    // 服务只出到 17 级，更细的层级由 SDK 放大 17 级的瓦片顶替
    maxZoom: 17,
    // 这个服务只支持 HTTP/1.1：浏览器每个域名只开约 6 个连接。声明后多出来的请求在 SDK 的优先级队列里排队，
    // 视野中心先下载（不声明时它们挤在浏览器的先来先服务队列里，中心区域要等很久才清晰）
    maxRequestsPerHost: 6,
    attribution: 'Map data © OpenStreetMap contributors, SRTM · Map style © OpenTopoMap (CC-BY-SA)',
  });
}

/** 免密钥的预设（天地图需要 key，这里不用；Carto 已改为要求 API key，也不用）。 */
const BASEMAPS = ['esri-imagery', 'esri-topo', 'osm', 'blue-marble', 'debug'] as const;
type Basemap = (typeof BASEMAPS)[number] | 'custom';

function createBasemap(id: Basemap): ImageryProvider {
  // 每次都新建：setImagery 会释放被换下的影像源
  return id === 'custom' ? openTopoMap() : findImageryPreset(id)!.create();
}

let imagery = viewer.globe.imageryProvider;
ui.section('底图');
ui.select<Basemap>(
  '影像',
  [...BASEMAPS.map((id) => [id, localize(findImageryPreset(id)!.label, viewer.locale)] as [Basemap, string]), ['custom', '自定义 XYZ：OpenTopoMap']],
  'esri-imagery',
  (id) => {
    imagery = createBasemap(id);
    viewer.globe.setImagery(imagery); // 高级 API
    showCredits();
  },
);

// ---------------------------------------------------------------- 叠加层

ui.section('叠加层');
ui.note('叠加层与贴地的矢量一起合成为每块瓦片的一张纹理，叠几层着色器都只多一次采样。');
const OVERLAYS = ['esri-places', 'esri-transport', 'openrailwaymap'] as const;
const active = new Map<string, RasterOverlay>();
let overlayOpacity = 1;
for (const id of OVERLAYS) {
  const preset = findOverlayPreset(id)!;
  ui.toggle(localize(preset.label, viewer.locale), false, (on) => {
    if (on) {
      // addRaster(影像源, 不透明度)：后加的画在上面
      active.set(id, viewer.overlays.addRaster(preset.create(), preset.opacity * overlayOpacity));
    } else {
      viewer.overlays.removeRaster(active.get(id)!); // 同时释放它的影像源
      active.delete(id);
    }
    showCredits();
  });
}
ui.slider('不透明度', { min: 0, max: 1, step: 0.05, value: 1, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
  overlayOpacity = v;
  // 改不透明度要经 setOpacity（直接改 layer.opacity 不会刷新瓦片）
  for (const [id, layer] of active) viewer.overlays.setOpacity(layer, findOverlayPreset(id)!.opacity * v);
});

// ---------------------------------------------------------------- 地形

ui.section('地形');
let terrainOn = true;
let exaggeration = 1;
ui.toggle('AWS 全球地形', true, (on) => {
  terrainOn = on;
  // null = 光滑椭球
  viewer.globe.setTerrain(on ? AWS_TERRARIUM : null, exaggeration);
  showCredits();
});
ui.slider('地形夸张', { min: 1, max: 3, step: 0.5, value: 1, format: (v) => `× ${v}` }, (v) => {
  exaggeration = v;
  // 改夸张不移动相机：夸张后山体可能高过相机，必要时自己飞高一点
  if (terrainOn) viewer.globe.setTerrain(AWS_TERRARIUM, v);
});

// ---------------------------------------------------------------- 署名

// 公共瓦片服务要求显示署名：影像源和地形源都带着 attribution 字段，由宿主显示在界面上
const credits = ui.output('署名');
function showCredits(): void {
  const parts = [imagery.attribution];
  for (const layer of viewer.overlays.rasterLayers) if (layer.visible) parts.push(layer.provider.attribution);
  if (terrainOn) parts.push(AWS_TERRARIUM.attribution);
  credits.set(parts.filter(Boolean).join(' · '));
}
showCredits();

ui.buttons([
  ['珠峰', () => void viewer.flyTo(EVEREST)],
  ['北京', () => void viewer.flyTo({ longitude: 116.391, latitude: 39.9, height: 6000, heading: 0, pitch: -45 })],
  ['全球', () => void viewer.flyTo({ longitude: 100, latitude: 30, height: 1.6e7, heading: 0, pitch: -90 })],
]);
