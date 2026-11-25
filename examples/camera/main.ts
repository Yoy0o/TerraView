/**
 * 视点、飞行与导航：设置 / 读取视点，几种飞行，`viewer.navigation` 的导航命令，开场动画、
 * 自动旋转、手势开关，以及用 `controller.playAnimation` 写一段可被手势打断的脚本动画。
 *
 * 相机只通过这些 API 移动，不直接改 `viewer.camera`：这样用户的手势能打断它，画面静止后也会自动重画。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, DEG2RAD, findImageryPreset, GeoViewer, orientationFromHeadingPitch, type ViewPosition } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('camera');

// 经纬度、航向、俯仰用度，高度是椭球高（米）。航向自北顺时针，俯仰向下为负
const BEIJING: ViewPosition = { longitude: 116.391, latitude: 39.885, height: 3500, heading: 0, pitch: -40 };

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: BEIJING,
  // navigation.home() 回到的视角；不给时就是 initialView
  homeView: BEIJING,
});
ui.attach(viewer);

// ---------------------------------------------------------------- 视点读数

const readout = ui.output('视点');
const showView = () => {
  const v = viewer.getView(); // { longitude, latitude, height, heading, pitch }，度 / 米
  readout.set(`${v.longitude.toFixed(4)}°, ${v.latitude.toFixed(4)}°，${Math.round(v.height)} m，航向 ${v.heading.toFixed(0)}°，俯仰 ${v.pitch.toFixed(0)}°`);
};
showView();
// 相机每动一帧发一次 change；用户开始拖动、滚轮、按键时发 interactionstart
viewer.controller.events.on('change', showView);

// ---------------------------------------------------------------- 飞行

ui.section('飞行');
ui.buttons([
  // flyTo：大圆弧线飞到一个视点，时长秒（不给时按距离自动）
  ['飞到上海', () => void viewer.flyTo({ longitude: 121.4996, latitude: 31.2397, height: 2600, heading: 300, pitch: -35 })],
  // flyToTarget：以一个点为注视中心，从给定航向、俯仰、距离（米）看它
  ['环视国家体育场', () => void viewer.flyToTarget({ target: { longitude: 116.3966, latitude: 39.9929, height: 50 }, heading: 210, pitch: -30, range: 900 })],
  // flyToBBox：俯视框住一个 [西, 南, 东, 北] 范围（度）
  ['框住北京六环', () => void viewer.flyToBBox([116.08, 39.69, 116.71, 40.18])],
  ['全球视角', () => void viewer.flyTo({ longitude: 110, latitude: 30, height: 1.6e7, heading: 0, pitch: -90 }, 2.5)],
]);

// ---------------------------------------------------------------- 导航命令（不带界面，按钮由宿主自己做）

ui.section('导航命令');
const nav = viewer.navigation;
ui.buttons([
  ['放大', () => nav.zoomIn()], // 距离变为 1/2，保持航向和俯仰
  ['缩小', () => nav.zoomOut()],
  ['左转 45°', () => void nav.rotate(-45)], // 绕屏幕中心的地面点转航向，正数顺时针
  ['右转 45°', () => void nav.rotate(45)],
  ['2D / 3D', () => void nav.toggleTilt()], // 俯视 ↔ 45° 倾斜
  ['指北', () => nav.resetNorth()],
  ['初始视角', () => void nav.home()],
]);

// 自动旋转按当前视角选择行为：全球视角绕地轴自转，近地绕屏幕中心环绕，俯视时先倾斜再环绕
const rotateMode = ui.output('自动旋转');
const MODE_NAMES = { globe: '地球自转', orbit: '环绕', 'tilt-orbit': '先倾斜再环绕', none: '当前视角不可用' } as const;
const showRotate = () => rotateMode.set(nav.isAutoRotating ? '运行中（任何操作即停止）' : `可用：${MODE_NAMES[nav.autoRotateMode]}`);
showRotate();
window.setInterval(showRotate, 500); // 模式取决于视角，按钮状态定时刷新即可
ui.buttons([
  [
    '开始 / 停止自动旋转',
    () => {
      nav.toggleAutoRotate();
      showRotate();
    },
  ],
  [
    '播放开场动画',
    async () => {
      // 开场动画停在"当前视角"上：低于 2000 km 默认跳过（绕地轴转一个近景会扫过整个大陆），所以先切到全球视角
      viewer.setView({ longitude: 108, latitude: 33, height: 1.75e7, heading: 0, pitch: -90 });
      const finished = await viewer.playIntro({ duration: 6, speed: 40 });
      ui.status(finished ? '开场动画播完了' : '开场动画被打断（拖动、滚轮或其他相机命令）');
    },
  ],
]);

// ---------------------------------------------------------------- 脚本动画

ui.section('脚本动画');
ui.note('controller.playAnimation 每帧回调一次，由回调直接写相机位姿；任何手势或相机命令都会打断它。');
ui.buttons([
  [
    '沿中轴线巡航',
    async () => {
      // 从永定门以南出发向北到钟鼓楼（约 8 km），高 650 m、朝北俯视 25°，用时 20 秒
      const south = { lon: 116.3975, lat: 39.8663 };
      const north = { lon: 116.3975, lat: 39.9406 };
      const seconds = 20;
      let t = 0;
      const done = await viewer.controller.playAnimation((dt, camera) => {
        t = Math.min(t + dt, seconds);
        const s = t / seconds;
        const lat = south.lat + (north.lat - south.lat) * s - 0.01; // 相机落后视线落点约 1 km
        // 位姿用 ECEF 与弧度写：位置 + 零滚转的朝向（orientationFromHeadingPitch）
        viewer.ellipsoid.cartographicToCartesian(south.lon * DEG2RAD, lat * DEG2RAD, 650, camera.position);
        orientationFromHeadingPitch(viewer.ellipsoid, camera.position, 0, -25 * DEG2RAD, camera.quaternion);
        return t < seconds; // 返回 false 结束
      });
      ui.status(done ? '巡航结束' : '巡航被打断');
    },
  ],
  // zoomBy / orbitBy：程序缩放、环绕，与滚轮、右键拖动是同一套手势（参数是弧度）
  ['程序环绕 90°', () => void viewer.controller.orbitBy(90 * DEG2RAD, 0, 2)],
]);

// ---------------------------------------------------------------- 手势开关

ui.section('手势');
const controller = viewer.controller;
ui.toggle('左键平移', controller.enablePan, (on) => (controller.enablePan = on));
ui.toggle('右键横向：航向', controller.enableRotate, (on) => (controller.enableRotate = on));
ui.toggle('右键纵向：俯仰', controller.enableTilt, (on) => (controller.enableTilt = on));
ui.toggle('滚轮缩放', controller.enableZoom, (on) => (controller.enableZoom = on));
ui.toggle('键盘（WASD / QE / RF）', controller.enableKeyboard, (on) => (controller.enableKeyboard = on));
// pitchRangeDeg = [最俯视, 最接近水平]：限制右键倾斜能抬到多平
ui.slider('最平俯仰', { min: -60, max: -2, step: 1, value: controller.pitchRangeDeg[1], format: (v) => `${v}°` }, (v) => {
  controller.pitchRangeDeg = [-90, v];
});
ui.note('键盘只在 viewer 有焦点时生效：先点一下地球，或者调用 viewer.canvas.focus()。');
