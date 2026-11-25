/**
 * 3D Tiles：加载一个瓦片集，抬到地形上，点击建筑读取批量表属性并高亮。
 *
 * 数据是 CesiumGS 3d-tiles-samples 的「TilesetWithRequestVolume」（CC BY 3.0）：美国宾夕法尼亚的
 * 一片城市白模（b3dm，每栋楼带批量表）和一栋精细建筑。它的高度从椭球面 0 m 起算，比当地地形低
 * 几十米，所以加载后要按地面高度设 `heightOffset`。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, RAD2DEG, type TileFeature } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('tiles3d');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: -75.6124, latitude: 40.0365, height: 700, heading: 0, pitch: -40 },
});
ui.attach(viewer);

const layer = viewer.addTileset({
  source: { type: 'url', url: 'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithRequestVolume/tileset.json' },
  name: '城市白模',
});

// 瓦片集中心的经纬度（度），在根 tileset 加载后才知道
let center: { longitude: number; latitude: number } | null = null;
const state = ui.output('状态', '加载根 tileset…');

layer.events.on('ready', ({ sphere }) => {
  const c = viewer.ellipsoid.cartesianToCartographic(sphere.center)!; // 弧度
  center = { longitude: c.longitude * RAD2DEG, latitude: c.latitude * RAD2DEG };
  state.set('已加载，等待地形…');
  placeOnGround();
});
layer.events.on('error', ({ error }) => state.set(`加载失败：${error.message}`));

/**
 * 这个数据集的底面在椭球高 0 m，偏移量就是中心处的地面高度。`surfaceHeight` 的结果只在
 * `reliable` 为 true 时可信；`maxCellSize: 30` 要求地形网格不粗于 30 m，粗的先不用。
 */
function placeOnGround(): boolean {
  if (!center) return false;
  const ground = viewer.surfaceHeight(center.longitude, center.latitude, { maxCellSize: 30 });
  if (!ground.reliable) return false;
  layer.heightOffset = Math.round(ground.height);
  offsetSlider.value = String(layer.heightOffset);
  offsetSlider.dispatchEvent(new Event('input')); // 只是让面板上的数字跟着变
  state.set(`已贴地：heightOffset = ${layer.heightOffset} m`);
  return true;
}
// 地形是逐级加载的：每帧看一次，够精细了就贴地、飞过去，然后不再检查
const offFrame = viewer.events.on('frame', () => {
  if (placeOnGround()) {
    offFrame();
    flyToLayer();
  }
});

function flyToLayer(): void {
  if (!center) return;
  void viewer.flyToTarget({ target: { ...center, height: layer.heightOffset + 10 }, heading: 30, pitch: -35, range: 520 });
}

// 点击建筑：读取要素（批量表里的一行）并高亮。不点在 3D Tiles 上时 tileFeature() 为 null
const picked = ui.output('要素', '点击一栋建筑');
viewer.interaction.on(
  'click',
  (e) => {
    const feature = e.tileFeature();
    viewer.highlightTileFeature(feature, { color: '#ffd23f', opacity: 0.6 });
    picked.set(feature ? describe(feature) : '（没有点到带属性的要素）');
  },
  { tag: 'example' },
);

function describe(feature: TileFeature): string {
  const rows = Object.entries(feature.properties).map(([key, value]) => {
    // 这份批量表里经纬度是弧度、高度是米
    if (typeof value !== 'number') return `${key}: ${String(value)}`;
    if (key === 'Longitude' || key === 'Latitude') return `${key}: ${(value * RAD2DEG).toFixed(5)}°`;
    return `${key}: ${Number.isInteger(value) ? value : value.toFixed(2)}`;
  });
  return `编号 ${feature.id}（${feature.table === 'batch' ? '批量表' : (feature.table ?? '无属性表')}）· ${rows.join('，')}`;
}

ui.section('图层');
ui.toggle('显示', true, (v) => (layer.visible = v));
ui.slider('误差目标', { min: 2, max: 32, step: 1, value: layer.errorTarget, format: (v) => `${v} px` }, (v) => (layer.errorTarget = v));
const offsetSlider = ui.slider('高度偏移', { min: -20, max: 160, step: 1, value: 0, format: (v) => `${v} m` }, (v) => (layer.heightOffset = v));
ui.buttons([
  ['重新贴地', () => void placeOnGround()],
  ['飞到图层', flyToLayer],
]);

// 排队、下载、解析中的瓦片数和这个图层占的显存（估算），每半秒读一次
const loading = ui.output('瓦片', '—');
setInterval(() => {
  loading.set(`${layer.pending} 块加载中，显存约 ${(layer.memory.gpuBytes / 1048576).toFixed(1)} MB`);
}, 500);
