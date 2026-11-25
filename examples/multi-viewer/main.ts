/**
 * 多个 viewer 与释放：同一页面上并排两个 viewer，左边 WebGPU（不支持时自动回退 WebGL 2），
 * 右边强制 WebGL 2。各自有自己的容器、相机、图层和事件；`dispose()` 之后 canvas 移除、
 * 容器还原，可以在同一个容器里重新创建。
 */
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer, type ViewPosition } from 'terra-viewer';
import { setupExample } from '../shared/ui';

const ui = setupExample('multi-viewer');

// 两个容器：任意有尺寸的元素都可以，不必铺满窗口
const row = document.createElement('div');
row.style.cssText = 'display: flex; gap: 4px; width: 100%; height: 100%';
ui.container.append(row);

interface Slot {
  name: string;
  element: HTMLElement;
  imagery: string;
  forceWebGL: boolean;
  view: ViewPosition;
  viewer: GeoViewer | null;
}

function makeSlot(name: string, imagery: string, forceWebGL: boolean, view: ViewPosition): Slot {
  const element = document.createElement('div');
  element.style.cssText = 'flex: 1; min-width: 0; height: 100%';
  row.append(element);
  return { name, element, imagery, forceWebGL, view, viewer: null };
}

const left = makeSlot('左', 'esri-imagery', false, { longitude: 116.391, latitude: 39.9, height: 3500, heading: 0, pitch: -45 });
const right = makeSlot('右', 'osm', true, { longitude: 121.4996, latitude: 31.2397, height: 6000, heading: 0, pitch: -50 });

const leftInfo = ui.output('左侧');
const rightInfo = ui.output('右侧');
const page = ui.output('页面');

/** WebGL 的适配器名很长（ANGLE 的完整描述），只留开头。 */
const shorten = (text: string) => (text.length > 32 ? `${text.slice(0, 31)}…` : text);

function refresh(): void {
  for (const [slot, out] of [[left, leftInfo], [right, rightInfo]] as const) {
    const v = slot.viewer;
    // dispose() 之后容器上的 tv-viewer 类、position、tabindex 都已还原
    out.set(v ? `${v.info.backend} · ${shorten(v.info.adapter)} · 档位 ${v.gpu.tier}` : `已销毁 · 容器 class="${slot.element.className}"、${slot.element.hasAttribute('tabindex') ? '有' : '无'} tabindex`);
  }
  page.set(`${document.querySelectorAll('canvas').length} 个 canvas`);
}

// 面板的错误提示和控制台里的 window.viewer 跟随还在的那个 viewer（左边优先）
let attached: GeoViewer | null = null;
function attachFirst(): void {
  const first = left.viewer ?? right.viewer;
  if (first && first !== attached) ui.attach(first);
  attached = first;
}

async function create(slot: Slot): Promise<void> {
  if (slot.viewer) return;
  slot.viewer = await GeoViewer.create({
    container: slot.element,
    imagery: findImageryPreset(slot.imagery)!.create(),
    terrain: AWS_TERRARIUM,
    forceWebGL: slot.forceWebGL,
    initialView: slot.view,
  });
  attachFirst();
  slot.viewer.controller.events.on('change', () => follow(slot));
  refresh();
}

function destroy(slot: Slot): void {
  if (!slot.viewer) return;
  // 记下销毁前的视点，重建后接着看
  slot.view = slot.viewer.getView();
  // 停止渲染循环，释放 GPU 资源、Worker 和监听，移除 canvas，还原容器
  slot.viewer.dispose();
  slot.viewer = null;
  attachFirst();
  refresh();
}

// 两个 viewer 的相机互不影响；需要联动时由宿主自己同步
let linked = false;
function follow(source: Slot): void {
  const target = source === left ? right : left;
  if (!linked || source !== left || !target.viewer || !source.viewer) return;
  target.viewer.setView(source.viewer.getView());
}

ui.section('销毁与重建');
const [leftButton, rightButton] = ui.buttons([
  ['销毁左侧', () => void toggle(left, leftButton)],
  ['销毁右侧', () => void toggle(right, rightButton)],
]);

async function toggle(slot: Slot, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  if (slot.viewer) destroy(slot);
  else await create(slot);
  button.textContent = `${slot.viewer ? '销毁' : '重建'}${slot.name}侧`;
  button.disabled = false;
}

ui.toggle('右侧跟随左侧视角', linked, (on) => {
  linked = on;
  if (on) follow(left);
});
ui.note('左边用 WebGPU（浏览器不支持时自动回退 WebGL 2），右边用 forceWebGL 强制 WebGL 2；两个 viewer 的相机、图层和事件互不影响。');

await Promise.all([create(left), create(right)]);
