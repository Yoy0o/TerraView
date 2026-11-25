/**
 * 拾取与交互事件：单击、双击、右键、悬停经 `viewer.interaction` 分发，事件里带着拾取结果
 * （命中了什么、经纬度和高度）；选择器、优先级、阻止传播、阻止默认行为、暂停。
 *
 * 场景里放了一栋样例建筑（docs/examples/sample-office.building.json），这样能点到建筑、
 * 楼层、房间和设备这些实体。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, RAD2DEG, type InteractionEvent } from 'terra-viewer';
import sampleBuilding from '../../docs/examples/sample-office.building.json';
import { setupExample } from '../shared/ui';

const ui = setupExample('picking');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.39697, latitude: 39.99837, height: 100, heading: 33, pitch: -34 },
});
ui.attach(viewer);
const building = viewer.indoor.add(sampleBuilding);

/** 命中了什么：实体、3D Tiles、高斯泼溅、地球，或者什么都没有（天空）。 */
function describeHit(e: InteractionEvent): string {
  switch (e.kind) {
    case 'entity':
      return `实体 · ${e.entity!.type} · ${e.entity!.name}`;
    case 'tiles':
      return '3D Tiles';
    case 'splats':
      return '高斯泼溅';
    case 'globe':
      return '地球表面';
    default:
      return '无（天空）';
  }
}

/** 事件里的 `cartographic` 是弧度 + 椭球高（米）。 */
function describePosition(e: InteractionEvent): string {
  const c = e.cartographic;
  if (!c) return '—';
  return `${(c.longitude * RAD2DEG).toFixed(6)}°, ${(c.latitude * RAD2DEG).toFixed(6)}°, ${c.height.toFixed(1)} m`;
}

ui.section('最近一次事件');
const lastType = ui.output('类型');
const lastHit = ui.output('命中');
const lastPosition = ui.output('位置');
const lastGround = ui.output('地面高度');
const hover = ui.output('悬停');
const room = ui.output('所在房间');
const log = ui.note('');
log.style.whiteSpace = 'pre-line';
const lines: string[] = [];
function append(line: string): void {
  lines.unshift(line);
  lines.length = Math.min(lines.length, 6);
  log.textContent = lines.join('\n');
}

function show(label: string, e: InteractionEvent): void {
  lastType.set(label);
  lastHit.set(describeHit(e));
  lastPosition.set(describePosition(e));
  const c = e.cartographic;
  if (c) {
    // 贴地高度：地球显示时取地形，地球隐藏时取 3D Tiles 表面；经纬度用度
    const ground = viewer.surfaceHeight(c.longitude * RAD2DEG, c.latitude * RAD2DEG);
    const above = c.height - ground.height;
    lastGround.set(`${ground.height.toFixed(1)} m（${ground.source}${ground.reliable ? '' : '，不可靠'}），拾取点离地 ${above.toFixed(1)} m`);
  } else {
    lastGround.set('—');
  }
}

// 本示例的监听都带 tag，可以用 viewer.interaction.off(type, 'example') 一次注销
const tag = 'example';
let stopAtDevices = false;
let blockDoubleClick = false;

viewer.interaction.on('click', (e) => {
  show('单击', e);
  append(`单击 → ${describeHit(e)}`);
}, { tag });

viewer.interaction.on('rightclick', (e) => {
  show('右键单击', e);
  append(`右键 → ${describeHit(e)}（在建筑里时内置行为会返回上一级）`);
}, { tag });

// 优先级高于内置行为（0）：先于"双击进入层级"和相机的"双击飞近"执行
viewer.interaction.on('dblclick', (e) => {
  show('双击', e);
  if (blockDoubleClick) {
    e.preventDefault(); // 挡住相机的双击飞近
    e.stopPropagation(); // 挡住优先级更低的监听，包括内置的"双击进入层级"（tag: 'indoor'）
    append('双击 → 已阻止默认行为和后续监听');
  } else {
    append(`双击 → ${describeHit(e)}`);
  }
}, { tag, priority: 10 });

// 选择器：只在点到设备（或设备的子实体）时触发，`e.object` 是选择器匹配到的实体
viewer.interaction.on('click', (e) => {
  append(`  设备监听（优先级 5）：${e.object!.name}`);
  if (stopAtDevices) e.stopPropagation();
}, { tag, selector: '.thing', priority: 5 });

// 悬停：mousemove 每帧最多拾取一次，只在有悬停监听时才拾取
viewer.interaction.on('mousemove', (e) => hover.set(`${describeHit(e)} · ${describePosition(e)}`), { tag });
viewer.interaction.on('mouseenter', (e) => room.set(e.object!.name), { tag, selector: '.room' });
viewer.interaction.on('mouseleave', () => room.set('—'), { tag, selector: '.room' });

ui.section('传播与默认行为');
ui.toggle('设备监听调用 stopPropagation', stopAtDevices, (on) => (stopAtDevices = on));
ui.note('打开后点设备：优先级更低的单击监听（上面的"单击"和内置的选中）不再执行。');
ui.toggle('双击时阻止默认行为', blockDoubleClick, (on) => (blockDoubleClick = on));
ui.note('默认双击建筑会逐级进入，双击地面相机会飞近；打开后两者都不发生。');

ui.section('暂停');
let resume: (() => void) | null = null;
ui.toggle('暂停全部交互（弹窗打开时的做法）', false, (on) => {
  if (on) {
    // 所有监听都不触发；blockDefault 连相机的双击飞近一起挡住
    resume = viewer.interaction.pause({ blockDefault: true });
  } else {
    resume?.();
    resume = null;
  }
  ui.status(on ? '交互已暂停：单击、双击、悬停都没有反应，相机手势照常。' : '');
});

ui.buttons([
  ['飞到建筑', () => void viewer.flyToEntity(building, { heading: 30, pitch: -35 })],
  ['回到地球层级', () => void viewer.indoor.enter(null)],
]);
