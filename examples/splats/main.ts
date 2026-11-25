/**
 * 高斯泼溅（3DGS）：把一个 .spz 场景放到地球上，调整朝向、缩放、轴向，点击拾取，盒裁剪。
 *
 * 文件在 Worker 里下载和解码，按显存档位的预算取舍后交给 three.js 的 GaussianSplat 绘制。
 * 泼溅文件没有坐标参考：位置、朝向、尺度、哪边朝上都由宿主给。
 * 数据：three.js 示例库的 lion.v3.spz（作者 Renaud，CC BY 4.0）。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, RAD2DEG, type SplatUpAxis } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('splats');

const SITE = { longitude: 116.3913, latitude: 39.9962 }; // 北京奥林匹克公园中轴线的广场上

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: SITE.longitude, latitude: SITE.latitude - 0.0016, height: 160, heading: 0, pitch: -35 },
});
ui.attach(viewer);

const layer = viewer.addSplats({
  url: 'https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/models/spz/lion.v3.spz',
  name: '狮子',
  position: SITE, // 不给 height：站在地面上（随地形加载自动跟随）
  heading: 0, // 度，自北顺时针
  scale: 30, // 每个文件单位多少米：训练结果没有真实尺度，这个小物件放大到雕塑大小
  // upAxis 默认 '-y'（3DGS / COLMAP 的约定）；方向不对时换 '+y' 或 '+z'
});

// ---------------------------------------------------------------- 加载状态

const state = ui.output('状态', '下载中…');
layer.events.on('progress', ({ loaded, total }) => {
  state.set(total > 0 ? `下载 ${Math.round((loaded / total) * 100)}%` : `已下载 ${(loaded / 1048576).toFixed(1)} MB`);
});
layer.events.on('ready', ({ stats }) => {
  state.set(`${stats.format.toUpperCase()}，${stats.count.toLocaleString()} 个泼溅，球谐 ${stats.shDegree} 阶，解码 ${Math.round(stats.decodeMs)} ms`);
});
// 贴地的图层要等地面高度可信后才移到地面上（发 'moved'）：站稳了再飞过去，否则会飞向地下
const offMoved = layer.events.on('moved', () => {
  offMoved();
  void layer.flyTo({ heading: 20, pitch: -20 });
});
layer.events.on('error', ({ error }) => state.set(`加载失败：${error.message}`));

// ---------------------------------------------------------------- 点击拾取

const picked = ui.output('拾取', '点击狮子');
viewer.interaction.on(
  'click',
  (e) => {
    // 泼溅不在 GPU 拾取缓冲里：每次拾取对图层发一条 CPU 射线（BVH），沿射线累积不透明度到 0.5 处算"表面"
    if (e.kind !== 'splats' || !e.splats || !e.cartographic) return picked.set(`（点到了 ${e.kind}）`);
    const c = e.cartographic; // 弧度、米
    picked.set(`${e.splats.name}：${(c.longitude * RAD2DEG).toFixed(6)}°，${(c.latitude * RAD2DEG).toFixed(6)}°，椭球高 ${c.height.toFixed(1)} m`);
  },
  { tag: 'example' },
);

// ---------------------------------------------------------------- 摆放与显示

ui.section('摆放');
ui.slider('航向', { min: 0, max: 360, step: 1, value: 0, format: (v) => `${v}°` }, (v) => layer.setPlacement({ heading: v }));
ui.slider('缩放', { min: 5, max: 60, step: 1, value: 30, format: (v) => `${v} m/单位` }, (v) => layer.setPlacement({ scale: v }));
ui.select<SplatUpAxis>(
  '朝上的轴',
  [
    ['-y', '-y（3DGS 默认）'],
    ['+y', '+y（glTF、多数 SPZ 4）'],
    ['+z', '+z'],
  ],
  '-y',
  (v) => (layer.upAxis = v),
);

ui.section('显示');
ui.slider('不透明度', { min: 0, max: 1, step: 0.05, value: 1, format: (v) => v.toFixed(2) }, (v) => (layer.opacity = v));
ui.toggle('裁剪：只看下半部分', false, (on) => {
  // 裁剪盒在图层本地坐标里：X 东、Y 北、Z 上（未转航向），文件单位，原点在枢轴（默认底面中点）。
  // 每次设置都在 CPU 上过滤后重新上传，所以在开关、松手时设，不要在拖动中连续设
  const b = layer.localBounds;
  if (!b) return;
  layer.crop = on ? { type: 'box', min: b.min, max: [b.max[0], b.max[1], (b.min[2] + b.max[2]) / 2] } : null;
});
ui.buttons([
  ['飞到场景', () => void layer.flyTo({ pitch: -20 })],
  ['移除 / 重新加载', toggleLayer],
]);

let removed = false;
function toggleLayer(): void {
  // removeSplats 释放显存；这里为了简单只演示移除，重新加载请刷新页面
  if (removed) return location.reload();
  viewer.removeSplats(layer);
  removed = true;
  state.set('已移除（再点一次刷新页面）');
}
