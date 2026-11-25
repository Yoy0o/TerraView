# 顶牌与点位标注

在地图上显示文字、图标、告警卡片有两种做法：

| 做法 | 适合 | 入口 |
| --- | --- | --- |
| **HTML 顶牌** | 少量、内容自定义的元素：一张告警卡片、一个带按钮的气泡、一段实时数值 | `viewer.markers.add({ element, position })` |
| **点位图层** | 一批数据点：站点、设备、兴趣点，按属性统一着色，点多了要聚合 | `viewer.addPoints({ data, style, rules, cluster })` |

两者都是盖在 canvas 上方的 DOM 元素，每帧按 float64 精度投影到屏幕上，做地平线、距离、视口裁剪和避让。点位图层本身就是建在顶牌之上的；建筑、房间、设备的顶牌（[建筑、层级与实体](./indoor.md)）也是。

## HTML 顶牌

`viewer.markers.add()` 把任意一个 DOM 元素钉在一个世界坐标（ECEF，米）上：

```ts
import { DEG2RAD } from 'terra-viewer';

const el = document.createElement('div');
el.className = 'my-label';
el.textContent = '1 号门岗';

const marker = viewer.markers.add({
  element: el,
  // 经纬度（度）+ 椭球高（米）→ ECEF
  position: viewer.ellipsoid.cartographicToCartesian(116.3975 * DEG2RAD, 39.9087 * DEG2RAD, 60),
  maxDistance: 20_000, // 相机远于 20 km 时隐藏
});

marker.remove(); // 不需要时移除（或 viewer.markers.remove(marker)）
```

元素的**底部中点**落在锚点上（`pivot` 默认 `[0.5, 1]`）。改了元素的内容、尺寸变了之后调用 `marker.invalidateSize()`，下一帧重新测量。

### 贴在地面上

顶牌只认 ECEF 坐标，不会自己贴地。`position` 也可以是一个**每帧调用的函数**，配合 `viewer.surfaceHeight()` 把锚点放在地面上（地形还在细化时会跟着变）：

```ts
import { DEG2RAD } from 'terra-viewer';

function groundAnchor(lon: number, lat: number, above = 0) {
  const p = viewer.ellipsoid.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, 0);
  return () => {
    // 度；地形或 3D Tiles 表面的椭球高，没有地面数据（无地形）时为 0
    const ground = viewer.surfaceHeight(lon, lat);
    return viewer.ellipsoid.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, ground.height + above, p);
  };
}

viewer.markers.add({ element: el, position: groundAnchor(116.3975, 39.9087, 2) });
```

函数返回 `null` 时这一帧不显示顶牌。每帧查一次地面高度对几个、几十个顶牌没有问题；一批数据点请用下面的点位图层，它的点不给高度时会自动贴地，并按预算分帧更新。

### 选项

| 选项 | 说明 |
| --- | --- |
| `element` | 顶牌内容，必填。SDK 把它包在一个 `.tv-marker` 外壳里，用 CSS transform 定位 |
| `position` | ECEF 锚点（`Vector3`），或每帧求值的函数（返回 `null` 时隐藏），必填 |
| `pivot` | 元素上哪一点放在锚点上，按元素尺寸的比例，默认 `[0.5, 1]`（底部中点） |
| `offsetPx` | 额外的屏幕偏移，CSS 像素，x 向右、y 向下 |
| `minDistance` / `maxDistance` | 相机距离（米）在这个范围之外时隐藏 |
| `horizonCulling` | 锚点在地球背面（地平线以下）时隐藏，默认 `true` |
| `visible` | 布尔值，或每帧求值的函数（例如"只在进入某层时显示"） |
| `scaleByDistance` | `[near, far, minScale]`：近于 `near` 米时原大，远于 `far` 米时缩到 `minScale` |
| `declutter` | 和更重要的顶牌重叠时隐藏（屏幕空间避让），默认不参与：不参与避让的顶牌总是显示，并作为障碍物挡住别人 |
| `priority` | 避让时的优先级，大者胜，相同时近者胜；可以是每帧求值的函数 |
| `zIndex` | 叠放顺序 |
| `occlusion` | 锚点被建筑、地形、3D Tiles 挡住时：`'none'`（默认）、`'hide'` 隐藏、`'fade'` 淡出 |
| `onClick` / `onDoubleClick` | 顶牌自己的单击、双击处理（有了它们顶牌才可以点，并加上 `.tv-interactive`） |
| `userData` | 任意数据。带 `entity`（一个 BIM 实体）时，顶牌上的单击、双击、右键会转成 `viewer.interaction` 上对这个实体的事件 |

`viewer.markers.stats` 给出本帧的总数、显示数、被避让数、被遮挡数和耗时。

### 避让与优先级

参与避让（`declutter: true`）的顶牌互不重叠：重叠时优先级低的隐藏。避让每 150 ms 重算一次，中间帧只更新位置，所以缩放时顶牌不会闪烁。

重要的信息（告警卡片、选中对象的说明）**不要参与避让**：不写 `declutter` 时它总是显示，只作为障碍物让别的顶牌让开。同理，被遮挡时它也只会淡出，不会被 `occlusion: 'hide'` 完全隐藏。

### 遮挡

```ts
viewer.markers.add({ element, position, occlusion: 'fade' }); // 'none' | 'hide' | 'fade'
```

设了 `occlusion` 的顶牌在锚点处放一个很小的遮挡查询代理，锚点被写深度的不透明物体（建筑、地形、3D Tiles）挡住时隐藏或淡出（`.tv-occluded`，不透明度 0.35）。结果比画面晚几帧，并做了防抖，边缘处不会闪。同时最多 256 个顶牌做遮挡判断，超出的按"未遮挡"处理，所以它适合重点顶牌，不适合成千上万的点。半透明的玻璃幕墙、层级淡化的房间不遮挡。

### 事件

- 顶牌盖在 canvas 上方，会挡住画布上的鼠标事件：滚轮由 SDK 转发给 canvas（光标在顶牌上也能缩放），单击、双击要么由你的 `onClick` / `onDoubleClick` 处理，要么带上 `userData.entity` 交给 `viewer.interaction`。
- 和 BIM 实体相关的顶牌带上 `userData: { entity }`，就能和点在实体上一样触发 `viewer.interaction` 的监听，事件的 `event.marker` 指向这个顶牌；与实体无关的顶牌自己处理单击。
- 右键单击只有在按下和松开都发生在顶牌上时才转发，从画布上开始的右键拖动不会被当成"返回上一级"。

### 样式与主题

SDK 只给外壳加类名和定位，元素本身的样式完全由你决定。内置的顶牌样式（点位图层、BIM 顶牌用的）读这些 CSS 变量，可以在 viewer 容器或任意祖先上改：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `--tv-font` | 字体 | 系统无衬线字体 |
| `--tv-text` | 文字颜色 | `#e3ebf7` |
| `--tv-muted` | 次要文字颜色 | `#8d9db5` |
| `--tv-card-bg` | 文字框背景 | `rgba(10, 16, 28, 0.86)` |
| `--tv-accent` | 单个顶牌的强调色（由 `color` 设置） | `#5aa9ff` |

```css
#map {
  --tv-font: 'HarmonyOS Sans SC', sans-serif;
  --tv-card-bg: rgba(255, 255, 255, 0.92);
  --tv-text: #1f2937;
}
```

想直接用内置的外观拼自己的顶牌，可以用 `createCard({ title, subtitle, style, color, icon, badge })`（高级 API）生成元素再交给 `markers.add`。

## 点位图层

```ts
const stations = viewer.addPoints({
  name: '监测站',
  data: [
    { id: 'st001', lon: 116.397, lat: 39.909, name: '天安门', status: '正常', pm25: 35 },
    { id: 'st002', lon: 116.317, lat: 39.991, name: '海淀', status: '告警', pm25: 168 },
  ],
  style: { style: 'badge', icon: '{pm25}', title: '{name}', maxDistance: 80_000 },
  rules: [
    { when: { status: '告警' }, style: { style: 'pulse', color: '#ff4d4f', badge: '告警', priority: 10, declutter: false } },
    { when: { pm25: { gt: 75 } }, style: { color: '#faad14' } },
  ],
  cluster: { radius: 56, minPoints: 3 },
});

stations.events.on('ready', ({ count, bbox }) => bbox && viewer.flyToBBox(bbox));
stations.events.on('click', ({ point }) => showPopup(point.properties));
```

`addPoints` 立即返回图层，数据在后台解析（可以给 `url` 让它自己下载），好了发 `ready`。

### 数据格式

| 输入 | 说明 |
| --- | --- |
| GeoJSON | `FeatureCollection` / `Feature` / 几何，取 `Point`、`MultiPoint` 和 `GeometryCollection` 里的点，坐标 `[经度, 纬度, 高度?]`；其他几何跳过并计数 |
| 记录数组 | 经度字段 `lon` / `lng` / `longitude` / `经度`，纬度字段 `lat` / `latitude` / `纬度`，可选高度 `height` / `alt` / `altitude` / `elevation` / `高度`，或 `coordinates: [经度, 纬度, 高度?]`；`id` 可选，其余字段都成为属性 |
| 点位文档 | `{ "points": [...], "style": {...}, "rules": [...] }`：`style`、`rules` 作为图层默认值（调用时传的优先） |

经纬度用度，高度是 WGS84 椭球高（米）。**没有高度的点自动贴地**（地形，或地球隐藏时的 3D Tiles 表面），地形细化时跟着调整。坐标不合法的记录跳过，`ready` 事件的 `skipped` 和 `warnings` 给出数量和前几条问题的位置；一个点都没有时发 `error`（`code: 'points-empty'`）。

### 样式

每个点的样式依次合并：图层 `style` → 命中的规则（后面的覆盖前面的）→ 点自己的 `style` 属性（对象）。

| 字段 | 说明 |
| --- | --- |
| `style` | 外观，见下表 |
| `color` | 强调色（CSS） |
| `title` / `subtitle` / `icon` / `badge` | 文字、前置图标或 emoji、状态徽章。都是模板：`{字段}` 换成该点的属性值。不写 `title` 时依次取 `name`、`title`、`label`、`名称`、`id` |
| `badgeColor` | 徽章颜色 |
| `heightOffset` | 在地面（或点自己的高度）之上再抬高多少米 |
| `minDistance` / `maxDistance` | 相机距离范围（米），之外隐藏 |
| `scaleByDistance` | `[near, far, minScale]` |
| `declutter` | 参与避让，默认 `true` |
| `priority` / `zIndex` | 避让优先级（也决定聚合时用哪个点代表一簇）、叠放顺序 |

| `style` | 外观 | 适用 |
| --- | --- | --- |
| `card` | 气泡卡片 + 引线 | 告警详情、重点对象 |
| `pin` | 胶囊文字 + 小圆点 | 设备 |
| `tag` | 紧凑标签 | 房间、区域名 |
| `poi` | 水滴图钉，图标在圆内，文字在上方 | 地标、兴趣点 |
| `pulse` | 呼吸点 + 扩散波纹 | 告警、实时点位 |
| `beacon` | 光柱 + 地面光环 | 远距离也要醒目的点 |
| `badge` | 实心圆徽章（图标或数字） | 分类站点 |
| `label` | 带描边光晕的纯文字 + 小圆点 | 密集注记 |

`title` 设为空字符串时 `poi` / `pulse` / `beacon` / `badge` 只画符号，适合大批量的点。`MARKER_STYLES` 是全部样式名。

### 规则

```ts
rules: [
  { when: { type: '视频' }, style: { color: '#a78bfa' } },                       // 相等
  { when: { status: ['离线', '停用'] }, style: { color: '#8a94a6' } },            // 属于其中之一
  { when: { status: '告警', value: { gt: 80 } }, style: { style: 'pulse' } },     // 多个条件同时成立
  { when: { owner: null }, style: { subtitle: '未分配' } },                       // 空值或缺失
]
```

条件可以写值（数字与数字字符串互相匹配）、数组（属于其中之一）、`null`（空值或缺失），或比较对象 `{ eq, ne, gt, gte, lt, lte, in }`。所有命中的规则依次应用，后面的覆盖前面的。

### 聚合

`cluster: true`（或 `{ radius, minPoints, maxZoom }`）把屏幕上挨得近的点合成一个数量圆盘：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `radius` | 56 | 屏幕上相距小于多少 CSS 像素的点合并 |
| `minPoints` | 3 | 成员少于它的簇直接显示其中的点 |
| `maxZoom` | 18 | 还做聚合的最细层级（约 0.6 m/px） |

聚合树只在数据、样式或半径变化时建一次（1 万点以上在 Worker 里建），之后每帧按每个节点到相机的距离选层：倾斜视角下近处拆开、远处保持聚合，平移时簇不重排。聚合点画在簇里优先级最高的点上，单击时飞到这簇点的范围（同时发 `clusterclick`）。

### 事件与操作

| 项 | 说明 |
| --- | --- |
| `events`：`ready` | `{ count, skipped, warnings, bbox }`，`bbox` 是 `[西, 南, 东, 北]`（度） |
| `events`：`error` | `{ message, error }`；也会汇总到 `viewer.events` 的 `error`（`source: 'points'`） |
| `events`：`click` / `clusterclick` | 单击点位（同时选中它）/ 聚合点；所有点位图层的单击也经 `viewer.events` 的 `point-click` 发出 |
| 双击点位 | 相机飞近 |
| `setStyle(style, rules?)` | 换图层样式（和规则），规则照常生效 |
| `setCluster(cluster)` | 开关聚合或改参数，只在半径、`maxZoom` 变化时重建 |
| `select(id)` / `select(null)` | 高亮一个点（`.tv-selected`），避让中优先 |
| `visible` | 显隐 |
| `points`、`count`、`bbox`、`positionOf(id)` | 解析后的点、数量、范围、某个点的 ECEF 锚点 |
| `stats` | 本帧画出的点数和聚合数、已建的 DOM 数、建树耗时 |
| `viewer.removePoints(layer)` | 移除并释放 |

单击点位不经过 `viewer.interaction`：顶牌是 DOM 元素，单击由图层自己处理。点在画布别处时如何取消选中、关闭弹窗，由你的应用决定（`layer.select(null)`）。

## 大批量数据

DOM 顶牌的开销取决于**同时显示**多少个，而不是总共多少个：

- 点多时开聚合。开聚合时 10 万个点也只画几十到几百个元素；建树约 3 千点 20 ms、10 万点 0.2 s。
- 只有第一次需要显示的点才创建 DOM，每帧最多 200 个，其余在后面几帧补齐（这期间 viewer 保持全帧率）。
- 用 `maxDistance` 让远处的点不显示，`title: ''` 只画符号。
- 显示数超过 80 时顶牌层自动进入**密集模式**（加 `.tv-dense`），去掉模糊滤镜和投影。**自定义样式不要给大批量元素加 `backdrop-filter`、`filter` 或常驻 CSS 动画**：`backdrop-filter` 每帧都要把下面的 WebGPU 画面重新模糊一次，几百个就会明显掉帧。
- 不聚合又要同时显示上千个、或者每秒刷新的数值，不适合 DOM 顶牌。这类需求（GPU 批量图标、高频数值标签）在路线图上，还没有提供。

## 示例

<ExampleFrame id="points" />

源码：[examples/points/main.ts](../../examples/points/main.ts)。一组按状态着色的站点：样式规则、文本模板、聚合开关和点击读数。

<ExampleFrame id="markers" />

源码：[examples/markers/main.ts](../../examples/markers/main.ts)。自己的 DOM 元素钉在地面上：遮挡淡出、按距离显示详情、点击处理。

格式、规则和聚合算法的完整说明见 [markers.md](../agents/markers.md)；全部导出见 [API 参考 §3.6](../api.md#_3-6-顶牌与点位)。
