/**
 * 实体查询、样式与描边：用选择器查询房间和设备，批量改颜色、描边、发光、显隐；
 * 点击房间或设备弹出属性窗，弹窗打开期间暂停交互（连同相机的双击飞近），关闭时恢复。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, SelectorError, type BimEntity, type EntitySet } from 'terra-viewer';
import sampleBuilding from '../../docs/examples/sample-office.building.json';
import { setupExample } from '../shared/ui';

const ui = setupExample('indoor-query');

const viewer = await GeoViewer.create({
  container: ui.container,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.3962, latitude: 39.9969, height: 260, heading: 25, pitch: -32 },
});
ui.attach(viewer);

const indoor = viewer.indoor;
indoor.add(sampleBuilding);
// 进入建筑后隐藏地球：起伏的地形不会从楼板里露出来挡住点击（周围空着时 SDK 显示展台背景）
indoor.events.on('enterLevel', () => (viewer.showGlobe = !indoor.current));
// 设备只在楼层里显示：直接进入 1F（入口大堂、办公室、会议室、数据机房）
void indoor.enter(indoor.getById('B-F1'));

// ---------------------------------------------------------------- 查询
const PRESETS: Array<[string, string]> = [
  ['.room', '所有房间'],
  ['.room && [category=office]', '办公室'],
  ['.thing', '所有设备'],
  ['[category=rack]', '机柜'],
  ['.thing && [负载>80]', '负载超过 80 的设备'],
  ['tags:or(alarm)', '带 alarm 标签'],
  ['tags:or(monitored) && !tags:or(alarm)', '受监控且没告警'],
  ['/会议|机房/', '名称匹配正则'],
  ['#B-F1-R04', '按 id'],
];

ui.section('选择器');
const input = document.createElement('input');
input.type = 'text';
input.value = '.room && [category=office]';
input.spellcheck = false;
input.style.cssText = 'width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0; font: 13px ui-monospace, monospace;';
ui.note('').append(input);
ui.select('常用', PRESETS.map(([s, label]) => [s, `${label}  ${s}`] as [string, string]), input.value, (s) => {
  input.value = s;
  run();
});
const matched = ui.output('匹配');

/** 被改过的实体：「清除」时还原。 */
const touched = new Set<BimEntity>();
let result: EntitySet | null = null;

function run(): EntitySet | null {
  try {
    result = indoor.query(input.value); // 编译后缓存；语法错误抛 SelectorError
    const names = result.slice(0, 4).map((e) => e.name || e.id);
    matched.set(`${result.length} 个${names.length ? `：${names.join('、')}${result.length > 4 ? ' …' : ''}` : ''}`);
    ui.status('');
  } catch (err) {
    result = null;
    if (err instanceof SelectorError) ui.status(`选择器有误（第 ${err.index + 1} 个字符）：${err.message}`, 'error');
    else throw err;
  }
  return result;
}
input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
input.addEventListener('change', () => run());
run();

/** 对当前查询结果做一件事，并记下被改过的实体。 */
const apply = (fn: (set: EntitySet) => void) => () => {
  const set = run();
  if (!set) return;
  fn(set);
  for (const e of set) touched.add(e);
};

ui.section('批量操作');
ui.buttons([
  ['染成黄色', apply((set) => set.setStyle({ color: '#ffd166' }))],
  ['半透明', apply((set) => set.setStyle({ opacity: 0.35 }))],
  ['描边', apply((set) => set.setEffects({ outline: 'select' }))],
  ['告警闪烁 + 发光', apply((set) => set.setEffects({ outline: 'alarm', glow: 0.6 }))],
]);
ui.buttons([
  ['隐藏', apply((set) => (set.visible = false))],
  ['清除', () => {
    for (const e of touched) {
      e.setStyle({ color: null, opacity: null }); // null 还原文档里的外观
      e.setEffects({ outline: null, glow: null });
      e.visible = true;
    }
    touched.clear();
  }],
]);
ui.select<'select' | 'alarm' | 'none'>(
  '选中描边',
  [
    ['select', '蓝色 select'],
    ['alarm', '红色闪烁 alarm'],
    ['none', '不描边'],
  ],
  'select',
  (v) => (indoor.selectOutline = v === 'none' ? null : v),
);

// ---------------------------------------------------------------- 点击弹出属性，弹窗期间暂停交互
const popup = document.createElement('div');
popup.style.cssText =
  'position: fixed; right: 12px; top: 12px; width: 260px; padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,0.96); color: #0f172a; font: 13px/1.6 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); z-index: 20; display: none;';
document.body.append(popup);
let resume: (() => void) | null = null;

function openPopup(entity: BimEntity): void {
  const title = document.createElement('b');
  title.style.fontSize = '15px';
  title.textContent = entity.name;
  const meta = document.createElement('div');
  meta.style.color = '#64748b';
  meta.textContent = [entity.type, entity.category, entity.id, [...entity.tags].join(', ')].filter(Boolean).join(' · ');
  const table = document.createElement('table');
  table.style.margin = '8px 0';
  for (const [key, value] of Object.entries(entity.properties)) {
    const row = table.insertRow();
    const k = row.insertCell();
    k.style.cssText = 'color:#64748b;padding-right:10px';
    k.textContent = key;
    row.insertCell().textContent = String(value);
  }
  popup.replaceChildren(title, meta, table);
  const close = document.createElement('button');
  close.textContent = '关闭（恢复交互）';
  close.style.cssText = 'color:#0f172a;background:#e2e8f0;border:0;border-radius:6px;padding:4px 10px;cursor:pointer';
  close.addEventListener('click', closePopup);
  popup.append(close);
  popup.style.display = 'block';
  // 弹窗打开期间：所有监听都不触发（不选中、不进出层级），相机的双击飞近也不生效。拖动、缩放照常。
  resume ??= viewer.interaction.pause({ blockDefault: true });
}

function closePopup(): void {
  popup.style.display = 'none';
  resume?.();
  resume = null;
}

// 只对房间和设备触发；tag 方便整体注销：viewer.interaction.off('click', 'app')
viewer.interaction.on('click', (e) => e.object && openPopup(e.object), { selector: '.room, .thing', tag: 'app' });

ui.note('点击房间或设备弹出属性；弹窗打开时单击、双击都不再起作用，关闭后恢复。');
