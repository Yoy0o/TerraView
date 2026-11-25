/**
 * 建筑与层级导航：加载一份建筑文档，从地球逐级进入建筑、楼层、房间再返回，并记录层级事件。
 *
 * - 双击建筑 / 楼层 / 房间进入，右键单击返回（SDK 的默认交互）；面板按钮做同样的事。
 * - Esc 返回上一级由应用自己写（SDK 不注册全局键盘监听），见文件末尾。
 * - 建筑文档格式见 docs/building-data-manual.md，这里用的是仓库里的样例。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, type BimEntity, type LevelEvent } from 'terra-viewer';
import sampleBuilding from '../../docs/examples/sample-office.building.json';
import { setupExample } from '../shared/ui';

const ui = setupExample('indoor');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.3962, latitude: 39.9969, height: 260, heading: 25, pitch: -32 },
});
ui.attach(viewer);

const indoor = viewer.indoor;

// 解析、校验、构建；文档没写高度，建筑会自动贴到地形上。文档有误时抛 TerraViewError（building-invalid）。
const building = indoor.add(sampleBuilding);

// ---------------------------------------------------------------- 当前层级与事件记录
const where = ui.output('当前层级');
const selected = ui.output('选中');
const name = (e: BimEntity | null) => (e ? e.name || e.id : '地球');

function showPath(): void {
  const current = indoor.current;
  where.set(current ? ['地球', ...current.ancestors().map(name), name(current)].join(' › ') : '地球');
}
showPath();

ui.section('层级事件（最近 10 条）');
const log = ui.note('');
log.style.whiteSpace = 'pre-line';
log.style.fontSize = '12px';
const lines: string[] = [];
const record = (type: string) => (e: LevelEvent) => {
  lines.push(`${type} ${name(e.object)}`);
  if (lines.length > 10) lines.shift();
  log.textContent = lines.join('\n');
};
// 一次切换沿层级路径逐级离开、进入：每离开一级发 leaveLevel，每进入一级先 beforeEnterLevel 再 enterLevel
indoor.events.on('leaveLevel', record('leave'));
indoor.events.on('beforeEnterLevel', record('before'));
indoor.events.on('enterLevel', (e) => {
  record('enter')(e);
  showPath();
});
indoor.events.on('select', ({ entity }) => selected.set(entity ? `${entity.type} · ${name(entity)}` : '—'));

// ---------------------------------------------------------------- 导航
ui.section('进入');
let stepwise = false;
const floor = (id: string) => indoor.getById(id)!;
ui.buttons([
  ['建筑', () => void indoor.enter(building)],
  ...building.floors.map((f): [string, () => void] => [f.name, () => void indoor.enter(f)]),
]);
ui.buttons([
  ['103 数据机房', () => void indoor.enter(indoor.getById('B-F1-R04'), { jumping: !stepwise })],
  ['机柜 A02', () => void indoor.enter(indoor.getById('B-F1-RK02'), { jumping: !stepwise })],
  ['201 开放办公区', () => void indoor.enter(indoor.getById('B-F2-R01'), { jumping: !stepwise })],
]);
ui.toggle('逐级飞行（jumping: false）', stepwise, (on) => (stepwise = on));

ui.section('返回');
ui.buttons([
  ['上一级', () => void indoor.back()], // 优先飞回往下钻之前的视点
  ['回到地球', () => void indoor.enter(null)],
]);

// 地面会挡住地下层（B1），地形在占地范围里有起伏时也会从楼板里露出来：
// 进入建筑后隐藏地球，周围什么都不画时 SDK 自动铺一块展台背景。
let hideGlobeInside = true;
const syncGlobe = () => (viewer.showGlobe = !(hideGlobeInside && indoor.current));
indoor.events.on('enterLevel', syncGlobe);

ui.section('显示');
ui.toggle('进入建筑后隐藏地球', hideGlobeInside, (on) => {
  hideGlobeInside = on;
  syncGlobe();
});
ui.toggle('楼层展开（建筑层级）', indoor.expandFloors, (on) => (indoor.expandFloors = on));
ui.toggle('顶牌', indoor.showLabels, (on) => (indoor.showLabels = on));
ui.note('双击建筑、楼层、房间进入，右键单击或按 Esc 返回。');

// 进入 1F 时先把楼层模型准备好：样例没有 glTF，这里只演示写法（有模型的楼层在第一次显示时才加载）
void building.modelsLoaded(floor('B-F1'));

// ---------------------------------------------------------------- Esc：应用自己的键盘监听
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
  if (indoor.current) void indoor.back();
});
