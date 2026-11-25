/**
 * Catalog of the runnable examples (`examples/<id>/`): the gallery page lists it, each example's
 * header reads its own entry, and the browser smoke test opens every one of them.
 *
 * `guide` is the manual page the example belongs to (`docs/guide/<guide>.md`, published at
 * `<site>/guide/<guide>`). Keep the entries in the order of the manual.
 */

export interface ExampleInfo {
  /** Folder name under `examples/`. */
  id: string;
  title: string;
  /** One or two sentences: what the example shows. */
  summary: string;
  /** Manual page, without extension (`docs/guide/<guide>.md`). */
  guide: string;
  /** Gallery section. */
  group: ExampleGroup;
  /** Third-party data the example loads, with its license (shown in the panel). */
  credit?: string;
}

export type ExampleGroup = 'basics' | 'data' | 'indoor' | 'scene' | 'runtime';

export const GROUP_TITLES: Record<ExampleGroup, string> = {
  basics: '入门',
  data: '底图与数据图层',
  indoor: '室内与 BIM',
  scene: '场景与画面',
  runtime: '交互与运行',
};

export const EXAMPLES: ExampleInfo[] = [
  {
    id: 'hello-globe',
    title: '最小接入',
    summary: '一个容器、一个底图、一个地形源：创建 GeoViewer 并停在北京上空。',
    guide: 'getting-started',
    group: 'basics',
  },
  {
    id: 'camera',
    title: '视点、飞行与导航',
    summary: '设置与读取视点、飞到目标、导航命令（缩放、指北、俯视、回到初始视角、自动旋转）和开场动画。',
    guide: 'camera',
    group: 'basics',
  },
  {
    id: 'multi-viewer',
    title: '多个 viewer 与释放',
    summary: '同一页面上并排两个 viewer（一个 WebGPU、一个 WebGL），逐个销毁再重建。',
    guide: 'viewer',
    group: 'basics',
  },
  {
    id: 'imagery-terrain',
    title: '影像、叠加层与地形',
    summary: '切换底图预设、叠加半透明图层、开关地形与地形夸张，自定义 XYZ 影像源。',
    guide: 'imagery-terrain',
    group: 'data',
  },
  {
    id: 'tiles3d',
    title: '3D Tiles 与要素拾取',
    summary: '加载 3D Tiles，贴到地形上，点击建筑读取批量表属性并高亮。',
    guide: 'tiles3d',
    group: 'data',
    credit: '数据：CesiumGS 3d-tiles-samples「TilesetWithRequestVolume」（CC BY 3.0，建筑模型作者 Richard Edwards）',
  },
  {
    id: 'geojson',
    title: 'GeoJSON 矢量与注记',
    summary: '贴地的面、线、点，按属性分类着色，名称注记，点击要素查看属性并高亮。',
    guide: 'vector',
    group: 'data',
  },
  {
    id: 'points',
    title: '点位标注与聚合',
    summary: '一组点位记录：样式、按属性的样式规则、文本模板和点击放大的聚合。',
    guide: 'markers',
    group: 'data',
  },
  {
    id: 'markers',
    title: '自定义 HTML 顶牌',
    summary: '把自己的 DOM 元素锚定在经纬度上，被地形挡住时淡出，点击、悬停、显示模式。',
    guide: 'markers',
    group: 'data',
  },
  {
    id: 'splats',
    title: '高斯泼溅（3DGS）',
    summary: '把一个 .spz 场景放到地球上：位置、朝向、缩放、轴向，点击拾取，盒裁剪。',
    guide: 'splats',
    group: 'data',
    credit: '数据：three.js 示例库的 lion.v3.spz（作者 Renaud，CC BY 4.0，https://superspl.at/scene/56155c3f）',
  },
  {
    id: 'indoor',
    title: '建筑与层级导航',
    summary: '加载建筑文档，从地球逐级进入建筑、楼层、房间并返回，监听层级事件。',
    guide: 'indoor',
    group: 'indoor',
  },
  {
    id: 'indoor-query',
    title: '实体查询、样式与描边',
    summary: '用选择器查询房间和设备，批量改颜色、描边、发光，点击实体弹出属性并暂停交互。',
    guide: 'indoor',
    group: 'indoor',
  },
  {
    id: 'lighting-clouds',
    title: '光照、阴影与云',
    summary: '真实太阳光照与日期时间、建筑的日照阴影、云壳与近地的体积云。',
    guide: 'environment',
    group: 'scene',
  },
  {
    id: 'local-scene',
    title: '局部场景（沙盘）',
    summary: '只显示一块圆形、矩形或多边形区域：侧壁、展台背景、相机活动范围。',
    guide: 'local-scene',
    group: 'scene',
  },
  {
    id: 'custom-objects',
    title: '放置自己的 three.js 对象',
    summary: '在经纬度处建立东北天坐标系，放入自己的网格，加描边，并在改动后通知 viewer 重画。',
    guide: 'effects',
    group: 'scene',
  },
  {
    id: 'picking',
    title: '拾取与交互事件',
    summary: '单击、双击、右键、悬停事件，拾取经纬度与高度，贴地高度查询，事件优先级与暂停。',
    guide: 'interaction',
    group: 'runtime',
  },
  {
    id: 'load-state',
    title: '加载状态、错误与截图',
    summary: '加载进度条、idle 事件、统一的错误事件与错误码、静止画面截图和诊断快照。',
    guide: 'performance',
    group: 'runtime',
  },
];

/** The repository the "source" links point to. */
export const REPO = 'https://github.com/Yoy0o/TerraView';

export function findExample(id: string): ExampleInfo {
  const info = EXAMPLES.find((e) => e.id === id);
  if (!info) throw new Error(`Unknown example "${id}": add it to examples/catalog.ts`);
  return info;
}
