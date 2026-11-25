/**
 * 自定义 HTML 顶牌：把自己的 DOM 元素钉在经纬度上。
 *
 * - 锚点是 ECEF 坐标；`position` 写成函数时每帧求值，配合 `viewer.surfaceHeight` 贴在地面上。
 * - 西山的山脊会挡住它后面的测点：`occlusion` 决定被挡住时淡出、隐藏还是不管。
 * - 告警卡片不参与避让（总是显示），可以点击；详情卡只在近处、且打开开关时显示。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, DEG2RAD, findImageryPreset, GeoViewer, type Marker, type OcclusionMode } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('markers');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  // 从东边低空看向西山：山脊挡住后面的测点
  initialView: { longitude: 116.2385, latitude: 39.9745, height: 650, heading: 282, pitch: -9 },
});
ui.attach(viewer);

// 顶牌元素的样式由宿主自己写（这里用 my- 前缀的类名）；SDK 只负责定位。
const css = document.createElement('style');
css.textContent = `
.my-spot { position: relative; padding: 3px 8px; border-radius: 12px; background: rgba(15, 23, 42, 0.85); color: #e2e8f0;
  font: 12px/1.4 system-ui, sans-serif; white-space: nowrap; border: 1px solid #38bdf8; }
.my-spot:hover { background: #0369a1; }
.my-spot::after { content: ''; position: absolute; left: 50%; bottom: -6px; width: 1px; height: 6px; background: #38bdf8; }
.my-alarm { width: 168px; padding: 8px 10px; border-radius: 8px; background: rgba(127, 29, 29, 0.92); color: #fff;
  font: 12px/1.5 system-ui, sans-serif; border: 1px solid #f87171; cursor: pointer; margin-bottom: 8px; }
.my-alarm b { display: block; font-size: 13px; }
.my-detail { width: 190px; padding: 8px 10px; border-radius: 8px; background: rgba(255, 255, 255, 0.94); color: #0f172a;
  font: 12px/1.5 system-ui, sans-serif; margin-bottom: 10px; }
`;
document.head.append(css);

/** 锚点函数：经纬度（度）处的地面，再往上 `above` 米；每帧查一次地面高度（地形细化时跟着变）。 */
function groundAnchor(lon: number, lat: number, above = 0) {
  const p = viewer.ellipsoid.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, 0);
  return () => {
    const ground = viewer.surfaceHeight(lon, lat); // 椭球高，米；没有地面数据时为 0
    return viewer.ellipsoid.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, ground.height + above, p);
  };
}

// ---------------------------------------------------------------- 测点：参与避让，可被地形遮挡
const SPOTS: Array<[name: string, lon: number, lat: number]> = [
  ['测点 1', 116.1835, 39.9925],
  ['测点 2', 116.1905, 39.9858],
  ['测点 3', 116.1958, 39.9978],
  ['测点 4', 116.1762, 39.9839],
  ['测点 5', 116.2071, 39.9902],
  ['测点 6', 116.1688, 39.9985],
  ['测点 7', 116.2162, 39.9801],
  ['测点 8', 116.2246, 39.9934],
];

let occlusion: OcclusionMode = 'fade';
let declutter = true;
let spots: Marker[] = [];

function addSpots(): void {
  for (const m of spots) m.remove();
  spots = SPOTS.map(([name, lon, lat], i) => {
    const el = document.createElement('div');
    el.className = 'my-spot';
    el.textContent = name;
    el.title = '点击查看地面高度'; // 悬停样式和提示都是宿主自己的 CSS / DOM
    const marker = viewer.markers.add({
      element: el,
      position: groundAnchor(lon, lat, 2),
      pivot: [0.5, 1],
      offsetPx: [0, -6], // 留出元素下方 6 px 的引线
      maxDistance: 30_000,
      declutter,
      priority: SPOTS.length - i,
      occlusion, // 'none' | 'hide' | 'fade'
      onClick: () => {
        const h = viewer.surfaceHeight(lon, lat);
        ui.status(`${name}：${lon.toFixed(4)}°, ${lat.toFixed(4)}°，地面椭球高 ${Math.round(h.height)} m（${h.source}）`);
      },
    });
    return marker;
  });
  // 遮挡要在画面上画一帧才有结果；画面静止（停画）时新加的顶牌要请求重画一次
  viewer.requestRender();
}
addSpots();

// ---------------------------------------------------------------- 告警卡片：不参与避让，总是显示
const alarm = document.createElement('div');
alarm.className = 'my-alarm';
alarm.innerHTML = '<b>⚠ 山火监测告警</b><span>温度异常 · 点击飞过去</span>';
const ALARM = { lon: 116.1795, lat: 39.9905 };
viewer.markers.add({
  element: alarm,
  position: groundAnchor(ALARM.lon, ALARM.lat, 30),
  zIndex: 10,
  // 不写 declutter：不参与避让，作为障碍物让别的顶牌让开；被挡住时最多淡出，不会隐藏
  occlusion: 'hide',
  onClick: () => void viewer.flyToTarget({ target: { longitude: ALARM.lon, latitude: ALARM.lat }, heading: 300, pitch: -30, range: 1500 }),
});

// ---------------------------------------------------------------- 详情卡：按距离和开关显示，内容实时更新
let showDetail = true;
const detail = document.createElement('div');
detail.className = 'my-detail';
const DETAIL = { lon: 116.2205, lat: 39.9778 };
const detailMarker = viewer.markers.add({
  element: detail,
  position: groundAnchor(DETAIL.lon, DETAIL.lat, 5),
  maxDistance: 6000, // 相机远于 6 km 时不显示
  visible: () => showDetail, // 每帧求值
  zIndex: 5,
});
let tick = 0;
const updateDetail = () => {
  tick++;
  detail.innerHTML = `<b>气象站</b><br>风速 ${(3 + Math.sin(tick / 3) * 1.5).toFixed(1)} m/s · 已运行 ${tick} s`;
  detailMarker.invalidateSize(); // 内容变了：下一帧重新测量尺寸
};
updateDetail();
setInterval(updateDetail, 1000);

// ---------------------------------------------------------------- 面板
ui.note('把视角转到山脊后面，看被挡住的测点怎样淡出或隐藏；告警卡片只会淡出。');
ui.select<OcclusionMode>(
  '遮挡',
  [
    ['fade', '淡出 fade'],
    ['hide', '隐藏 hide'],
    ['none', '不处理 none'],
  ],
  occlusion,
  (mode) => {
    occlusion = mode;
    addSpots(); // 选项在 add 时给定：换模式就重新添加
  },
);
ui.toggle('测点参与避让', declutter, (on) => {
  declutter = on;
  addSpots();
});
ui.toggle('显示气象站详情（6 km 内）', showDetail, (on) => (showDetail = on));
const stats = ui.output('顶牌');
viewer.events.on('frame', () => {
  const s = viewer.markers.stats;
  stats.set(`显示 ${s.shown} / ${s.total}，避让 ${s.decluttered}，遮挡 ${s.occluded}`);
});
ui.buttons([
  ['回到初始视角', () => viewer.navigation.home()],
  ['俯视全部', () => void viewer.flyTo({ longitude: 116.198, latitude: 39.955, height: 6500, heading: 0, pitch: -60 })],
]);
