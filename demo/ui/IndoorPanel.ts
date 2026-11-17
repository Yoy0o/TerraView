import type { BimEntity, Building, GeoViewer } from 'terra-view';
import { createDemoBuilding } from '../data/demoBuilding';
import { describeError } from './errors';
import { h, section, slider, toggle } from './dom';

type Notify = (text: string, kind?: 'info' | 'error') => void;

/** "室内 / BIM" panel section: demo building, document loading, building list, level options. */
export class IndoorPanel {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'layer-list' });
  /** Outline and glow on devices whose 状态 property is an alarm (告警…). */
  private alarmEffects = true;

  constructor(
    private readonly viewer: GeoViewer,
    private readonly notify: Notify,
  ) {
    const indoor = viewer.indoor;
    const demo = h('button', { class: 'chip', title: '程序生成的 5 层办公楼：房间、设备、传感器、机房告警' }, '示例办公楼');
    demo.addEventListener('click', () => this.loadDemo());

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void this.loadFile(file);
    });
    const open = h('button', { class: 'btn ghost' }, '打开 building.json…');
    open.addEventListener('click', () => fileInput.click());

    const urlInput = h('input', { type: 'url', placeholder: 'https://…/model.building.json' });
    const loadUrl = h('button', { class: 'btn' }, '加载');
    loadUrl.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return this.notify('请填写 building.json 地址', 'error');
      void this.loadUrl(url);
    });

    this.root = section(
      '室内 / BIM',
      h('div', { class: 'chips' }, demo),
      h('div', { class: 'row' }, urlInput, loadUrl),
      h('div', { class: 'row' }, open, fileInput),
      toggle('显示顶牌', indoor.showLabels, (on) => (indoor.showLabels = on)),
      toggle('楼层展开（进入建筑时）', indoor.expandFloors, (on) => (indoor.expandFloors = on)),
      toggle('进入建筑时隐藏 3D Tiles', indoor.hideTilesetsIndoor, (on) => {
        indoor.hideTilesetsIndoor = on;
        indoor.refresh();
      }),
      toggle(
        '无地表时显示展台背景',
        viewer.indoorBackdrop,
        (on) => (viewer.indoorBackdrop = on),
        '隐藏地球且 3D Tiles 不显示时，在建筑下方铺网格地面和渐变天空，代替纯黑背景',
      ),
      toggle(
        '层级切换淡入淡出',
        viewer.levelTransition.duration > 0,
        (on) => (viewer.levelTransition.duration = on ? 450 : 0),
        '进出建筑、切换楼层时，从上一帧画面淡出过渡，避免 3D Tiles、外壳、楼层突然出现或消失',
      ),
      ...this.effectControls(),
      ...this.cullingControls(),
      h('p', { class: 'hint' }, '双击建筑 / 楼层 / 房间逐级进入，右键单击或 Esc 返回上一级。'),
      this.list,
    );
    indoor.events.on('buildings-changed', () => {
      this.applyAlarmEffects();
      this.render();
    });
    indoor.events.on('enterLevel', () => this.render());
    this.render();
  }

  /** Outlines and glow (M3.2): alarm devices, outline width. Selection and hover outlines come from the SDK. */
  private effectControls(): HTMLElement[] {
    const effects = this.viewer.effects;
    const width = slider('描边宽度', { min: 1, max: 6, step: 0.5, value: effects.outlineWidth, format: (v) => `${v} px` }, (v) => (effects.outlineWidth = v));
    const alarms = toggle(
      '告警设备描边与发光',
      this.alarmEffects,
      (on) => {
        this.alarmEffects = on;
        this.applyAlarmEffects();
      },
      '状态为“告警…”的设备显示闪烁的红色描边（被遮挡部分也显示）和发光；选中、悬停的描边由 SDK 提供',
    );
    return [alarms, width.root];
  }

  private applyAlarmEffects(): void {
    const alarms = this.viewer.indoor.query((e) => String(e.properties['状态'] ?? '').startsWith('告警'));
    alarms.setEffects(this.alarmEffects ? { outline: 'alarm', glow: 0.6 } : { outline: null, glow: null });
  }

  /** Contribution culling (M2.3): on / off, threshold, and how much is culled right now. */
  private cullingControls(): HTMLElement[] {
    const culling = this.viewer.indoor.culling;
    const status = h('p', { class: 'hint' });
    const threshold = slider(
      '剔除阈值（屏幕占比）',
      { min: 0.1, max: 5, step: 0.1, value: culling.options.threshold * 100, format: (v) => `${v.toFixed(1)}%` },
      (v) => culling.configure({ threshold: v / 100 }),
    );
    const show = (on: boolean) => {
      threshold.root.hidden = !on;
      status.hidden = !on;
    };
    show(culling.enabled);
    const refresh = () => {
      if (!culling.enabled) return;
      const { culled, candidates } = culling.stats;
      status.textContent = `已剔除 ${culled} / ${candidates} 个设备与构件（墙、柱、楼板不参与）`;
    };
    setInterval(refresh, 500);
    const on = toggle(
      '远景剔除小设备',
      culling.enabled,
      (v) => {
        culling.enabled = v;
        show(v);
        refresh();
      },
      '设备、门窗等构件在屏幕上小于阈值时不渲染，拉近后恢复（带回差，阈值附近不闪烁）；墙、柱、楼板始终显示',
    );
    return [on, threshold.root, status];
  }

  loadDemo(): Building | null {
    const existing = this.viewer.indoor.getById('demo-office-a');
    if (existing) {
      void this.viewer.indoor.enter(existing);
      return existing as Building;
    }
    return this.addBuilding(createDemoBuilding(), undefined, true);
  }

  async loadUrl(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.addBuilding(await res.json(), new URL(url, location.href).href, true);
    } catch (err) {
      this.notify(`建筑加载失败：${describeError(err)}`, 'error');
    }
  }

  async loadFile(file: File): Promise<void> {
    try {
      this.addBuilding(JSON.parse(await file.text()), undefined, true);
    } catch (err) {
      this.notify(`建筑加载失败：${describeError(err)}`, 'error');
    }
  }

  private addBuilding(doc: unknown, baseUrl: string | undefined, enter: boolean): Building | null {
    try {
      const b = this.viewer.indoor.add(doc, baseUrl);
      const rooms = this.viewer.indoor.query((e) => e.type === 'room' && e.isDescendantOf(b)).length;
      const things = this.viewer.indoor.query((e) => e.type === 'thing' && e.isDescendantOf(b)).length;
      this.notify(`已加载：${b.name}（${b.floors.length} 层，${rooms} 个房间，${things} 个设备）`);
      if (enter) void this.viewer.indoor.enter(b);
      return b;
    } catch (err) {
      this.notify(`建筑加载失败：${describeError(err)}`, 'error');
      return null;
    }
  }

  private render(): void {
    const indoor = this.viewer.indoor;
    const list = this.list;
    list.replaceChildren();
    if (indoor.buildings.length === 0) {
      list.append(h('p', { class: 'hint' }, '尚未加载建筑。'));
      return;
    }
    for (const b of indoor.buildings) {
      const inside = indoor.current?.closest('building') === b;
      const enter = h('button', { class: 'icon-btn', title: inside ? '回到地球' : '进入建筑' }, inside ? '⤴' : '⤵');
      enter.addEventListener('click', () => void indoor.enter(inside ? null : b));
      const fly = h('button', { class: 'icon-btn', title: '飞到建筑' }, '⌖');
      fly.addEventListener('click', () => void this.viewer.flyToEntity(b, { pitch: -30, rangeScale: 1.4 }));
      const remove = h('button', { class: 'icon-btn', title: '移除' }, '✕');
      remove.addEventListener('click', () => indoor.remove(b));
      list.append(
        h('div', { class: 'layer-row' }, h('span', { class: 'layer-name', title: b.name }, b.name, h('small', {}, ` · ${b.floors.length} 层`)), enter, fly, remove),
      );
    }
  }
}

/**
 * Breadcrumb of the current level (地球 › 建筑 › 楼层 › 房间) and a vertical
 * floor switcher while inside a building, like ThingJS's level UI.
 */
export class LevelBar {
  readonly root: HTMLElement;
  readonly floors: HTMLElement;
  private readonly crumbs = h('nav', { class: 'level-crumbs', 'aria-label': '层级' });

  constructor(private readonly viewer: GeoViewer) {
    const back = h('button', { class: 'level-back', title: '返回上一级（Esc / 右键）', 'aria-label': '返回上一级' }, '‹');
    back.addEventListener('click', () => void viewer.indoor.back());
    this.root = h('div', { class: 'level-bar', hidden: true }, back, this.crumbs);
    this.floors = h('div', { class: 'floor-switcher', hidden: true, role: 'toolbar', 'aria-label': '楼层' });
    viewer.indoor.events.on('enterLevel', () => this.render());
    viewer.indoor.events.on('buildings-changed', () => this.render());
    viewer.indoor.events.on('select', () => this.render());
    this.render();
  }

  private render(): void {
    const indoor = this.viewer.indoor;
    const current = indoor.current;
    this.root.hidden = current === null;
    this.crumbs.replaceChildren();
    if (current) {
      const chain: (BimEntity | null)[] = [null, ...current.ancestors(), current];
      chain.forEach((e, i) => {
        if (i > 0) this.crumbs.append(h('span', { class: 'sep' }, '›'));
        const last = i === chain.length - 1;
        const b = h('button', { class: last ? 'crumb current' : 'crumb' }, e ? e.name : '地球');
        if (!last) b.addEventListener('click', () => void indoor.enter(e));
        this.crumbs.append(b);
      });
    }

    const building = (current?.closest('building') as Building | null) ?? null;
    this.floors.hidden = !building;
    this.floors.replaceChildren();
    if (!building) return;
    const currentFloor = current?.closest('floor') ?? null;
    const all = h('button', { class: currentFloor ? 'floor-btn' : 'floor-btn active', title: '整栋建筑' }, '全部');
    all.addEventListener('click', () => void indoor.enter(building));
    this.floors.append(all);
    // Top floor first, like an elevator panel.
    for (const f of [...building.floors].reverse()) {
      const b = h('button', { class: f === currentFloor ? 'floor-btn active' : 'floor-btn', title: f.name }, f.name);
      b.addEventListener('click', () => void indoor.enter(f));
      this.floors.append(b);
    }
  }
}
