# 交互、拾取与事件

用户在画面上单击、双击、右键、悬停时，你通常想知道两件事：点到了什么（建筑里的哪个房间、哪栋 3D Tiles 建筑、地面上的哪个经纬度），以及要不要替换掉默认的行为（双击进入建筑、双击飞近）。TerraView 把这两件事合在 `viewer.interaction` 里：事件分发前先做好拾取，监听器拿到的事件对象里就带着结果。

## 监听事件

```ts
const off = viewer.interaction.on('click', (e) => {
  console.log(e.kind, e.entity?.name, e.cartographic);
}, { tag: 'app' });

off(); // 取消这一个监听
viewer.interaction.off('click', 'app'); // 取消某个类型下 tag 为 app 的全部监听
```

| 类型 | 何时触发 |
| --- | --- |
| `click` | 左键按下又抬起，期间移动不超过 5 像素、不超过 500 毫秒（拖动地图不算单击） |
| `dblclick` | 双击 |
| `rightclick` | 右键单击（同样不含拖动） |
| `mousemove` | 指针在画面上移动且没有按键按下；每帧最多拾取一次，只在有悬停类监听时才拾取 |
| `mouseenter` / `mouseleave` | 指针进入 / 离开一个实体（建筑、楼层、房间、设备）。带选择器时按选择器匹配到的实体判断，比如 `{ selector: '.room' }` 只在跨房间时触发 |

::: warning 不要自己在 canvas 上监听 `click`
原生的 `click` 在拖动地图后也会触发，也拿不到拾取结果，还会和 SDK 的默认行为打架。点击、双击、右键、悬停一律走 `viewer.interaction`。
:::

### 选项

| 选项 | 说明 |
| --- | --- |
| `selector` | 只在命中的实体（或它的某个祖先）匹配选择器时触发，如 `'.room'`、`'#B-F1-R03'`、`'[category=camera]'`、`'tags:or(alarm)'`。选择器语法见[建筑、层级与实体](./indoor.md) |
| `tag` | 给监听分组，方便 `off(type, tag)` 一起注销、`pause({ tag })` 一起暂停 |
| `priority` | 优先级，大的先执行，默认 0 |
| `once` | 执行一次后自动注销 |

### 事件对象

| 字段 | 说明 |
| --- | --- |
| `type` | 事件类型 |
| `kind` | 命中了什么：`'entity'`（建筑实体）、`'tiles'`（3D Tiles）、`'splats'`（高斯泼溅）、`'globe'`（地球表面）、`'none'`（天空） |
| `entity` | 命中的实体（`BimEntity`），没有时为 null |
| `object` | 带选择器的监听里，选择器匹配到的实体（命中的实体或它的祖先）；不带选择器时同 `entity` |
| `tileset` / `splats` | 命中的 3D Tiles 图层 / 高斯泼溅图层 |
| `point` | 命中点，ECEF（米） |
| `cartographic` | 命中点的经纬度和椭球高：**弧度** + 米，用 `RAD2DEG` 换算 |
| `tileFeature()` | 指针下的 3D Tiles 要素（编号与属性）；第一次调用时才做一次 CPU 射线，不调用就没有开销（[3D Tiles](./tiles3d.md)） |
| `marker` | 事件来自某个顶牌时是那个顶牌，否则为 null（见下文"[顶牌上的事件](#顶牌上的事件)"） |
| `clientX` / `clientY`、`button`、`originalEvent` | 指针位置（视口坐标）、按键、原生事件（`mousemove` 的原生事件为 null） |
| `preventDefault()`、`defaultPrevented` | 阻止默认行为 |
| `stopPropagation()`、`stopImmediatePropagation()` | 阻止后续监听 |

```ts
import { RAD2DEG } from 'terra-viewer';

viewer.interaction.on('click', (e) => {
  if (e.kind === 'entity') openPanel(e.entity!.properties);
  if (e.kind === 'tiles') console.log(e.tileFeature()?.properties);
  if (e.kind === 'splats') console.log(e.splats!.name);
  if (e.cartographic) console.log(e.cartographic.longitude * RAD2DEG, e.cartographic.latitude * RAD2DEG, e.cartographic.height);
});
```

GeoJSON 的面、线是贴在地面上的，点到它们时 `kind` 是 `'globe'`；要查询 GeoJSON 要素，见下文"[拾取 API](#拾取-api)"里的 `pickFeature`。

## 执行顺序与传播

一次事件可能有好几个监听都匹配。执行顺序是：

1. **优先级**大的先执行；
2. 同优先级时，选择器匹配到的实体**越深越先**（设备先于房间，房间先于楼层，像 DOM 事件冒泡）；
3. 再按注册顺序。

`stopPropagation()` 让优先级更低的、以及匹配在祖先上的监听不再执行（同一优先级、匹配同一个实体的其余监听照常执行，就像同一个 DOM 节点上的监听）；`stopImmediatePropagation()` 让其余全部监听都不再执行。

```ts
// 点到告警设备时只弹告警，不走后面的通用处理（包括内置的"单击选中"）
viewer.interaction.on('click', (e) => {
  showAlarm(e.object!);
  e.stopPropagation();
}, { selector: 'tags:or(alarm)', priority: 10, tag: 'app' });
```

## 默认行为

viewer 自带几组交互，它们本身也是 `viewer.interaction` 上的监听（优先级 0），可以按 tag 暂停或注销：

| 行为 | 在哪里 | 怎样替换 |
| --- | --- | --- |
| 双击地面：相机飞近 | 相机的默认行为 | 在 `dblclick` 监听里调用 `e.preventDefault()` |
| 双击建筑 / 楼层 / 房间：逐级进入 | `tag: 'indoor'` 的 `dblclick` 监听 | 用更高的优先级监听并 `stopPropagation()`；或 `off('dblclick', 'indoor')` 彻底去掉 |
| 右键单击：返回上一级 | `tag: 'indoor'` 的 `rightclick` 监听 | 同上 |
| 单击：选中实体（描边） | `tag: 'indoor'` 的 `click` 监听 | 同上；或 `viewer.indoor.selectOutline = null` 只去掉描边 |
| 悬停：描边实体 | `tag: 'indoor-hover'`（有建筑时才注册） | `pause({ tag: 'indoor-hover' })`；或 `viewer.indoor.hoverOutline = null` |
| 局部场景里双击区域外：回到总览 | `tag: 'local-scene'` 的 `dblclick` 监听 | 同上 |

```ts
// 双击建筑时打开自己的详情页，而不是进入建筑；地面上的双击照常飞近
viewer.interaction.on('dblclick', (e) => {
  openDetail(e.object!);
  e.preventDefault();   // 挡住相机飞近
  e.stopPropagation();  // 挡住内置的"进入层级"（优先级 0）
}, { selector: '.building', priority: 10, tag: 'app' });
```

## 暂停交互

弹窗、表单打开期间，常常需要让画面上的点击暂时失效。用 `pause()`，不要注销再重新注册：

```ts
const resume = viewer.interaction.pause({ blockDefault: true }); // 所有监听都不触发，相机的双击飞近也不生效
// ……关闭弹窗时
resume();
```

| `pause(scope)` 的范围 | 说明 |
| --- | --- |
| `type` | 只暂停某种或某几种事件 |
| `tag` | 只暂停某个 tag 的监听，如 `{ tag: 'indoor' }` 暂停内置的进出层级和选中 |
| `selector` | 只在命中的实体匹配时暂停，如 `{ type: 'click', selector: '.floor' }`；点到地球、3D Tiles、天空不受影响 |
| `blockDefault` | 连默认行为（相机双击飞近）一起挡住。默认 false：只让监听不触发 |

暂停可以叠加，`pause()` 返回的函数只撤销它自己那一次；`viewer.interaction.resume()` 撤销全部，`viewer.interaction.paused` 表示是否有暂停生效。相机的拖动、滚轮缩放不受暂停影响，要锁住相机用 `viewer.controller.enabled` 或各手势开关（[相机与导航](./camera.md)）。

::: tip 不要用 `interaction.enabled = false`
它让所有监听失效，却挡不住相机的默认行为，也会把内置的悬停状态停在半截。暂停交互用 `pause()`。
:::

## 顶牌上的事件

HTML 顶牌盖在 canvas 上方，会截获指针事件：

- **实体的顶牌**（房间、设备的顶牌，或你创建顶牌时带上 `userData: { entity }`）：单击、双击、右键单击会转成 `viewer.interaction` 上对该实体的事件，所有监听照常收到，`e.marker` 指向那个顶牌。
- **和实体无关的顶牌**（点位、聚合点、你自己的顶牌）：用顶牌自己的 `onClick` / `onDoubleClick`，或点位图层的 `click` 事件。
- 滚轮在顶牌上照样缩放地图。

见[顶牌与点位标注](./markers.md)。

## 拾取 API

不在事件监听里时，也可以随时问"屏幕上这个点是什么"：

| 方法 | 返回 |
| --- | --- |
| `viewer.pickAt(clientX, clientY)` | `PickInfo`：与事件对象相同的拾取字段（`kind`、`entity`、`tileset`、`splats`、`point`、`cartographic`、`tileFeature()`）。参数是视口坐标（`MouseEvent.clientX / clientY`） |
| `viewer.pickCartographic(clientX, clientY)` | 命中点的经纬度和椭球高（弧度 + 米），什么都没点到时为 null |
| `viewer.pickTileFeature(clientX, clientY)` | 3D Tiles 要素，没有时为 null |
| `viewer.pickFeature(clientX, clientY)` | **异步**。GeoJSON 要素（先查注记，再查贴地的几何），`{ hit, layer, position }`；`hit.properties` 是属性。配合 `viewer.highlightFeature(hit)` 高亮 |
| `viewer.pick(ndc, { buffer })` | 底层接口：参数是归一化设备坐标（-1..1），返回 `SurfacePick`（命中点、来源、距离、法线） |

```ts
// 单击 GeoJSON 要素：查属性并高亮
viewer.interaction.on('click', async (e) => {
  const picked = await viewer.pickFeature(e.clientX, e.clientY);
  viewer.highlightFeature(picked?.hit ?? null);
  if (picked) showProperties(picked.hit.properties);
});
```

能被拾取的是建筑实体、3D Tiles、高斯泼溅和地球表面。你自己加进 `viewer.scene` 的 three.js 对象不在其中，需要时用 three.js 的 `Raycaster` 对自己的对象求交。

### GPU 拾取缓冲

在 WebGPU 下，单击和悬停的拾取先查一张半分辨率的 **GPU 拾取缓冲**（每个像素记着对象、实例、深度和法线），查询耗时与场景规模无关；缓冲和当前相机、场景不一致时自动退回 CPU 射线，调用方不需要区分（`SurfacePick.via` 是 `'buffer'` 或 `'ray'`）。WebGL 2 下始终用射线。高斯泼溅不写深度，不在缓冲里，总是用射线。

经 SDK API 做的改动（实体的显隐、移动、样式，层级切换，图层增删）都会让缓冲自动失效。只有绕过 SDK 直接改了建筑或 3D Tiles 网格的变换、显隐时，要调用 `viewer.pickBuffer?.invalidate()`（高级 API），否则下一次点击可能命中旧的位置。

## 贴地高度

`viewer.surfaceHeight(经度, 纬度)` 查询某处的地面高度（参数用度），建筑、点位、相机防入地用的都是它：

```ts
const ground = viewer.surfaceHeight(116.3975, 39.999);
if (ground.reliable) console.log(`地面椭球高 ${ground.height.toFixed(1)} m，来自 ${ground.source}`);
```

| 字段 | 说明 |
| --- | --- |
| `height` | WGS84 椭球高，米 |
| `source` | `'terrain'`：地球显示时取地形；`'tiles'`：地球隐藏时（如加载了 Google 真实感 3D Tiles）对可见 3D Tiles 做竖直射线；`'ellipsoid'`：一无所知，高度为 0 |
| `reliable` | 数据是否足够精细（网格间距或几何误差不超过 `maxCellSize`，默认 150 米）。不可靠时不要拿它贴地，等数据加载 |
| `resolution` | 数据有多粗，米 |
| `held` | 3D Tiles 的结果是之前测得、暂时沿用的（瓦片被压制、还没加载，或这一帧的射线预算用完了） |

它总是立即返回一个值，地形、3D Tiles 加载得越细，结果越准；对 3D Tiles 的射线每帧有时间预算，连续查询几帧内会收敛。**不给高度的点位、建筑、高斯泼溅会自动贴地并随数据加载跟随**，通常不需要你自己查。

## 示例

<ExampleFrame id="picking" />

示例源码：[examples/picking/main.ts](../../examples/picking/main.ts)。场景里有一栋样例建筑：单击地面、建筑、设备看拾取结果和贴地高度；打开"设备监听调用 stopPropagation"后再点设备，内置的选中不再发生；打开"双击时阻止默认行为"后双击建筑不再进入；"暂停全部交互"演示弹窗打开时的做法。
