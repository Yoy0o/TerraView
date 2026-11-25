/**
 * 把自己的 three.js 对象放到地球上：在经纬度处建立东北天（ENU）坐标系，网格的顶点用米为单位的
 * 局部坐标（X 东、Y 北、Z 上），不把 ECEF 大数写进顶点；描边、发光用 `viewer.effects`；绕过 SDK
 * 直接改了对象之后调用 `viewer.requestRender()`；最后是调色。
 *
 * `viewer.scene`、`viewer.camera` 是高级 API（直接接触 three.js 对象）。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, COLOR_GRADING_PRESETS, DEG2RAD, findImageryPreset, GeoViewer } from 'terra-viewer';
import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Raycaster, TorusGeometry, Vector2, type Object3D } from 'three';
import { setupExample } from '../shared/ui';

const ui = setupExample('custom-objects');

const SITE = { longitude: 116.3915, latitude: 39.9925 }; // 度

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.3895, latitude: 39.9918, height: 125, heading: 60, pitch: -22 },
});
ui.attach(viewer);

// ---------------------------------------------------------------- 搭一组对象（局部坐标，米，Z 朝上）

const site = new Group();
site.name = '站点';

const tower = new Group();
tower.name = '信号塔';
const mast = new Mesh(new CylinderGeometry(1.2, 2.2, 48, 24), new MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.3, roughness: 0.5 }));
mast.rotation.x = Math.PI / 2; // three.js 的圆柱沿 Y 轴，转到沿 Z 轴（朝上）
mast.position.z = 24;
const beacon = new Mesh(new ConeGeometry(3, 6, 24), new MeshStandardMaterial({ color: '#f59e0b', emissive: '#f59e0b', emissiveIntensity: 0.6 }));
beacon.rotation.x = Math.PI / 2;
beacon.position.z = 51;
tower.add(mast, beacon);

const box = new Mesh(new BoxGeometry(24, 16, 12), new MeshStandardMaterial({ color: '#60a5fa', roughness: 0.6 }));
box.name = '机房';
box.position.set(36, -10, 6); // 塔的东边 36 m、南边 10 m，底面贴地

const ring = new Mesh(new TorusGeometry(14, 1.2, 12, 64), new MeshStandardMaterial({ color: '#34d399', emissive: '#065f46' }));
ring.name = '光环';
ring.position.set(0, 0, 30); // 套在塔上，水平放置（Torus 默认在 XY 平面，正好是水平面）

site.add(tower, box, ring);

/** 把 site 的原点放到经纬度处的地面上：位置是 ECEF（米），朝向是该点的东北天。 */
let groundHeight: number | null = null;
function placeOnGround(): void {
  const ground = viewer.surfaceHeight(SITE.longitude, SITE.latitude); // 地形或 3D Tiles 的高度（椭球高），带可信度
  // 先用手头的高度放下；之后只采用可靠的、确实变了的高度（地形加载得更精细时会变）
  if (groundHeight !== null && (!ground.reliable || Math.abs(ground.height - groundHeight) < 0.05)) return;
  groundHeight = ground.height;
  const origin = viewer.ellipsoid.cartographicToCartesian(SITE.longitude * DEG2RAD, SITE.latitude * DEG2RAD, ground.height); // 弧度
  viewer.ellipsoid.eastNorthUpToFixedFrame(origin).decompose(site.position, site.quaternion, site.scale);
  viewer.requestRender(); // 直接改了 three.js 对象：画面可能已经静止，通知 viewer 重画
}

viewer.scene.add(site);
placeOnGround();
viewer.events.on('load-progress', placeOnGround);

// ---------------------------------------------------------------- 描边与发光

viewer.effects.defineOutline('beacon', { color: '#fbbf24', hiddenColor: '#92400e', fill: 0.1, pulse: 1.6 });
viewer.effects.set(box, { outline: 'select' }); // 内置样式：select、hover、alarm
viewer.effects.set(beacon, { glow: 0.9, glowColor: '#f59e0b' });

ui.section('描边与发光');
ui.toggle('机房描边', true, (on) => viewer.effects.set(box, { outline: on ? 'select' : null }));
ui.toggle('信号灯发光', true, (on) => viewer.effects.set(beacon, { glow: on ? 0.9 : null }));
ui.toggle('信号塔告警（闪烁描边）', false, (on) => viewer.effects.set(tower, { outline: on ? 'beacon' : null }));
ui.slider('描边宽度', { min: 1, max: 6, step: 1, value: viewer.effects.outlineWidth, format: (v) => `${v} px` }, (v) => (viewer.effects.outlineWidth = v));

// ---------------------------------------------------------------- 改动与动画

ui.section('改动');
ui.buttons([
  [
    '机房转 30°',
    () => {
      box.rotation.z += 30 * DEG2RAD; // 绕局部 Z 轴（朝上）转
      viewer.requestRender();
    },
  ],
  [
    '机房东移 10 m',
    () => {
      box.position.x += 10; // 局部 X 朝东
      viewer.requestRender();
    },
  ],
]);

let spinning = 0;
ui.toggle('光环转动（每帧 requestRender）', false, (on) => {
  cancelAnimationFrame(spinning);
  if (!on) return;
  const spin = () => {
    ring.rotation.z += 0.02;
    viewer.requestRender(); // 自己逐帧变化的对象：每帧都要通知，否则画面静止后不再更新
    spinning = requestAnimationFrame(spin);
  };
  spin();
});
ui.toggle('显示', true, (on) => {
  site.visible = on;
  viewer.requestRender();
});

// ---------------------------------------------------------------- 点选自己的对象

// viewer.pick / interaction 只拾取地球、3D Tiles、建筑和高斯泼溅；自己的对象自己求交，
// 再和事件拾取到的表面比远近（对象在地面之前才算点中）。
const picked = ui.output('点选', '点击塔或机房');
const raycaster = new Raycaster();
const ndc = new Vector2();
let selected: Object3D | null = null;
let outlineBefore: string | null = null; // 选中前对象自己的描边，取消选中时还原
viewer.interaction.on(
  'click',
  (e) => {
    const rect = viewer.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, viewer.camera);
    const hit = raycaster.intersectObject(site, true)[0];
    const surface = e.point ? e.point.distanceTo(viewer.camera.position) : Infinity;
    if (selected) viewer.effects.set(selected, { outline: outlineBefore });
    selected = null;
    if (!hit || hit.distance > surface) return picked.set('没有点中');
    // 点到塔的任一部分都算塔
    selected = hit.object === mast || hit.object === beacon ? tower : hit.object;
    outlineBefore = viewer.effects.get(selected).outline ?? null;
    viewer.effects.set(selected, { outline: 'hover' });
    picked.set(`${selected.name}，距相机 ${hit.distance.toFixed(0)} m`);
  },
  { tag: 'example' },
);

// ---------------------------------------------------------------- 调色

ui.section('调色');
const exposure = ui.slider('曝光', { min: 0.5, max: 2, step: 0.05, value: 1, format: (v) => v.toFixed(2) }, (v) => viewer.colorGrading.set({ exposure: v }));
const contrast = ui.slider('对比度', { min: 0.5, max: 1.5, step: 0.05, value: 1, format: (v) => v.toFixed(2) }, (v) => viewer.colorGrading.set({ contrast: v }));
const saturation = ui.slider('饱和度', { min: 0, max: 2, step: 0.05, value: 1, format: (v) => v.toFixed(2) }, (v) => viewer.colorGrading.set({ saturation: v }));
const applyPreset = (name: 'neutral' | 'vivid') => {
  viewer.colorGrading.set(COLOR_GRADING_PRESETS[name]);
  const o = viewer.colorGrading.options;
  for (const [input, value] of [
    [exposure, o.exposure],
    [contrast, o.contrast],
    [saturation, o.saturation],
  ] as const) {
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  }
};
ui.buttons([
  ['中性', () => applyPreset('neutral')],
  ['鲜明', () => applyPreset('vivid')],
]);
