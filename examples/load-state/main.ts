/**
 * 加载状态、错误与截图：用 `load-progress` / `idle` 事件做一条加载进度条，统一监听
 * `viewer.events` 的 `error`（按错误码处理），等加载完再截图，导出诊断快照；
 * 另外看静止超采样和安静帧率怎样改变每秒画的帧数。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoJsonLayer, GeoViewer, isTerraViewError, PointLayer, type LoadState } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('load-state');

// 宿主自己的加载条：铺在 viewer 容器顶部的一条细线（SDK 不带界面）
const bar = document.createElement('div');
bar.style.cssText = 'position: fixed; top: 0; left: 0; height: 3px; width: 0; background: #60a5fa; transition: width 0.2s, opacity 0.4s; z-index: 20; opacity: 0';
document.body.append(bar);

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.391, latitude: 39.9, height: 2200, heading: 0, pitch: -38 },
});
ui.attach(viewer);

// ---------------------------------------------------------------- 加载进度

ui.section('加载');
const counts = ui.output('待加载');
const idleLog = ui.note('');
idleLog.style.whiteSpace = 'pre-line';

// loadState 只给"还剩多少"，没有总数：以这一轮加载里出现过的最大待加载数为分母
let peak = 0;
let burstStart = performance.now();
let idleCount = 0;
function showProgress(state: LoadState): void {
  counts.set(`地球 ${state.globe} · 3D Tiles ${state.tilesets} · 图层 ${state.layers}`);
  if (state.idle) return;
  if (peak === 0) burstStart = performance.now();
  peak = Math.max(peak, state.pending, 1);
  bar.style.opacity = '1';
  bar.style.width = `${Math.round((1 - state.pending / peak) * 100)}%`;
}
viewer.events.on('load-progress', showProgress);
viewer.events.on('idle', () => {
  idleCount += 1;
  const seconds = ((performance.now() - burstStart) / 1000).toFixed(1);
  idleLog.textContent = `第 ${idleCount} 次 idle：这一轮加载用了约 ${seconds} 秒`;
  peak = 0;
  bar.style.width = '100%';
  bar.style.opacity = '0';
});
showProgress(viewer.loadState);

ui.buttons([
  ['飞到上海（触发新一轮加载）', () => void viewer.flyTo({ longitude: 121.4996, latitude: 31.2397, height: 2600, heading: 300, pitch: -35 })],
  ['回到北京', () => viewer.navigation.home()],
]);

// ---------------------------------------------------------------- 错误

ui.section('错误');
const errorLog = ui.note('点下面的按钮故意制造几种错误（都不联网）。');
errorLog.style.whiteSpace = 'pre-line';
const errors: string[] = [];
function logError(line: string): void {
  errors.unshift(line);
  errors.length = Math.min(errors.length, 5);
  errorLog.textContent = errors.join('\n');
}

// 所有异步加载失败都汇总到这里：source 说明来自哪类数据，SDK 自己报的错误带稳定的 code
viewer.events.on('error', ({ source, error, layer }) => {
  const code = isTerraViewError(error) ? error.code : '（非 SDK 错误）';
  logError(`error 事件 · ${source} · ${code}`);
  // 失败的图层留在列表里没有用，移除它
  if (layer instanceof GeoJsonLayer) viewer.removeGeoJson(layer);
  if (layer instanceof PointLayer) viewer.removePoints(layer);
});

ui.buttons([
  // 没有 type 的对象不是 GeoJSON：图层的 error 事件和 viewer 的 error 事件都会收到 geojson-invalid
  ['无效的 GeoJSON', () => void viewer.addGeoJson({ name: '无效数据', data: { features: 'oops' } })],
  // 一个点都没有：points-empty
  ['空的点位数据', () => void viewer.addPoints({ name: '空点位', data: [] })],
  // 建筑文档在 add() 时同步校验，错误直接抛出，details.path 指出出错的位置
  [
    '有误的建筑文档',
    () => {
      try {
        viewer.indoor.add({ format: 'three-geo-building', version: '1.0', id: 'broken', name: '有误的建筑', anchor: { longitude: 116.39, latitude: 39.9 }, floors: [{ id: 'F1', height: -3 }] });
      } catch (err) {
        if (isTerraViewError(err, 'building-invalid')) logError(`抛出 · building-invalid · 出错位置 ${err.details.path}`);
        else throw err;
      }
    },
  ],
]);

// ---------------------------------------------------------------- 截图与诊断

ui.section('截图与诊断');

function download(name: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/** 当前视图加载完时 resolve（已经空闲就立即）。 */
function whenIdle(): Promise<void> {
  if (viewer.loadState.idle) return Promise.resolve();
  return new Promise((resolve) => {
    const off = viewer.events.on('idle', () => {
      off();
      resolve();
    });
  });
}

ui.buttons([
  [
    '截图（等加载完）',
    async () => {
      await whenIdle();
      // 画面已静止并超采样时直接输出超采样的结果，不重画场景
      download('terraview.png', viewer.captureFrame().toDataURL('image/png'));
    },
  ],
  [
    '导出诊断快照',
    () => {
      // 纯 JSON：后端、帧统计、显存估算、加载状态、视点、图层、室内、后期效果……可以附到问题报告里
      const snapshot = viewer.snapshot();
      download('terraview-snapshot.json', URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })));
      ui.status(`快照：${snapshot.info.backend}，显存估算 ${(snapshot.memory.gpuTotal / 2 ** 20).toFixed(0)} MB`);
    },
  ],
]);

// ---------------------------------------------------------------- 帧率与静止

ui.section('帧率与静止');
const frames = ui.output('每秒帧数');
const memory = ui.output('显存估算');
let lastUpdate = 0;
viewer.events.on('frame', (stats) => {
  const now = performance.now();
  if (now - lastUpdate < 250) return;
  lastUpdate = now;
  // still：已超采样完、不再画帧；samples：屏幕上的画面平均了几帧；throttled：按安静帧率更新
  const state = stats.still ? `静止（${stats.samples} 帧平均）` : stats.throttled ? '安静' : '实时';
  frames.set(`${stats.fps.toFixed(0)} · ${state} · CPU ${stats.frameMs.toFixed(1)} ms`);
  memory.set(`${(viewer.memory.gpuTotal / 2 ** 20).toFixed(0)} MB（档位 ${viewer.gpu.tier}）`);
});

ui.toggle('静止超采样', viewer.supersampling.enabled, (on) => (viewer.supersampling.enabled = on));
ui.select(
  '安静帧率',
  [
    ['10', '10 帧/秒（默认）'],
    ['30', '30 帧/秒'],
    ['0', '不降帧（0）'],
  ],
  String(viewer.idleFrameRate),
  (value) => (viewer.idleFrameRate = Number(value)),
);
ui.note('画面安静 1 秒后先做静止超采样，然后停止重画（每秒帧数为 0）；关掉超采样时按安静帧率重画。拖动地图立刻恢复实时画面。');
