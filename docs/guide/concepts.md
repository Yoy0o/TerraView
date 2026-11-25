# 基本概念

接入前值得花五分钟弄清楚的几件事：坐标和单位、API 的分级、事件、画面什么时候会重画。

## 坐标与单位

TerraView 的世界坐标就是 **ECEF**（地心地固坐标系）：原点在地心，单位米，+Z 指向北极，+X 指向经度 0°、纬度 0°。three.js 场景里的 `Vector3` 都是 ECEF 坐标。

对外的 API 尽量用人熟悉的单位：

| 量 | 单位与约定 |
| --- | --- |
| 经度、纬度 | 度（`ViewPosition`、`TargetView`、图层选项、建筑文档、点位数据） |
| 高度 | **WGS84 椭球高**，米 |
| 航向 heading | 度，自正北顺时针（90 = 朝东） |
| 俯仰 pitch | 度，水平为 0，向下为负（-90 = 垂直俯视） |
| 距离、半径 | 米 |
| 时长 | 飞行等相机运动用秒；过渡、淡入等效果用毫秒（各选项的说明里写明） |

例外是几个"贴近引擎"的接口，用弧度：`viewer.ellipsoid`（`Ellipsoid`）的方法、`viewer.pickCartographic()` 的返回值（`Cartographic`，弧度 + 米）、`cameraMath` 一组函数。包里导出了 `DEG2RAD`、`RAD2DEG` 方便换算：

```ts
import { DEG2RAD, RAD2DEG } from 'terra-viewer';

// 经纬度（度）→ ECEF（米）
const p = viewer.ellipsoid.cartographicToCartesian(116.39 * DEG2RAD, 39.91 * DEG2RAD, 50);

// 屏幕上的点 → 经纬度
const c = viewer.pickCartographic(event.clientX, event.clientY);
if (c) console.log(c.longitude * RAD2DEG, c.latitude * RAD2DEG, c.height);
```

### 椭球高与海拔

GPS 测得的、3D Tiles 里存的高度是椭球高；地图上标的"海拔"是相对大地水准面的高度。两者在全球范围内相差 -106 到 +85 米。TerraView 内部统一用椭球高：海拔类的地形数据（AWS Terrarium、Mapbox、MapTiler）在加载时按 EGM96 改正成椭球高，quantized-mesh 和 3D Tiles 本来就是椭球高。

实际使用中最省心的做法是**不给高度、让它贴地**：点位、建筑、高斯泼溅在不给高度时都会落在地面上（地形，或者地球隐藏时的 3D Tiles 表面），并随地形加载自动跟随。要查询某处地面的高度，用 `viewer.surfaceHeight(经度, 纬度)`（度），见[交互、拾取与事件](./interaction.md)。

### 局部坐标

在某个经纬度处放东西时，用东北天（ENU）坐标系：X 朝东、Y 朝北、Z 朝上。`viewer.ellipsoid.eastNorthUpToFixedFrame(原点)` 给出从 ENU 到 ECEF 的矩阵。建筑文档里的本地坐标也是这样（再按建筑的 `heading` 旋转），glTF 模型规定 Y 朝上，加载时会转成 Z 朝上。完整写法见[描边、调色与自定义对象](./effects.md)。

::: warning 不要把 ECEF 坐标直接写进顶点
ECEF 坐标的数值在 640 万米左右，float32 的顶点精度只有半米。自己往场景里加网格时，把网格的 `position` 设成一个附近的原点（ECEF），顶点用相对这个原点的局部坐标。TerraView 的每块瓦片、每栋建筑都是这样做的。
:::

## API 分级

包入口 `terra-viewer` 导出的内容分三级，每一项的级别在 [API 参考](../api.md#_3-导出清单)里都标了：

| 级别 | 含义 | 举例 |
| --- | --- | --- |
| 稳定 | 不加标记。0.x 期间也尽量不破坏，破坏时记入 CHANGELOG | `GeoViewer` 的创建、视点、图层、拾取，`viewer.indoor`、`viewer.interaction`、`viewer.navigation` |
| 高级 | 源码和类型声明里标 `@advanced`。直接接触 three.js 对象或实现细节，给扩展和调试用，次版本可以改 | `viewer.renderer` / `scene` / `camera`、`viewer.globe`、`viewer.postProcessing`、`viewer.snapshot()` |
| 内部 | 不从包入口导出，不在类型声明里 | — |

优先用稳定的 API 完成需求；确实需要高级 API 时（比如把自己的 three.js 对象加进 `viewer.scene`），升级版本时留意 CHANGELOG。

## 事件

SDK 里的对象都用同一种事件接口：`events.on(类型, 回调)`，返回一个取消订阅的函数。

```ts
const off = viewer.events.on('idle', () => console.log('当前视图加载完了'));
off(); // 不再需要时取消
```

| 对象 | 事件举例 |
| --- | --- |
| `viewer.events` | `idle`、`load-progress`、`error`、`frame`、`tilesets-changed`、`point-click` |
| `viewer.controller.events` | `change`（相机动了）、`interactionstart`（用户开始操作） |
| `viewer.indoor.events` | `beforeEnterLevel`、`enterLevel`、`leaveLevel` |
| 图层的 `events` | `ready`、`error`、`change`、`progress` |

鼠标交互（单击、双击、右键、悬停）是单独的一套：`viewer.interaction.on(类型, 回调, 选项)`，支持选择器、优先级、阻止默认行为，见[交互、拾取与事件](./interaction.md)。**不要自己在 canvas 上注册 `click` 监听来判断点到了什么**：拖动地图时也会触发，也拿不到拾取结果。

## 异步与加载

几乎所有加载都是异步的：`GeoViewer.create()` 返回 Promise；`addTileset()`、`addGeoJson()`、`addPoints()`、`addSplats()` 立即返回图层对象，数据在后台加载，好了发 `ready` 事件，失败发 `error` 事件。

```ts
const layer = viewer.addGeoJson({ url: '/data/parks.geojson' });
layer.events.on('ready', (summary) => viewer.flyToBBox(summary.bbox!));
layer.events.on('error', ({ message }) => console.warn(message));
```

所有图层、地球瓦片的加载情况汇总在 `viewer.loadState`，加载完成时 `viewer.events` 发 `idle`。所有加载失败也会汇总到 `viewer.events` 的 `error`，带上稳定的错误码。见[加载、错误与性能](./performance.md)。

## 画面什么时候重画

viewer 有自己的渲染循环，你不需要（也不应该）调用 `renderer.render()`。为了省电，画面**安静 1 秒后**会做一次静止超采样（边缘更平滑），然后**停止重画**，直到有变化。

经 SDK API 做的改动都会自动唤醒画面：设视点、飞行、增删图层、改实体样式、改云层、开关光照等。只有一种情况需要你自己通知：

::: tip 绕过 SDK 直接改 three.js 对象后，调用 `viewer.requestRender()`
例如往 `viewer.scene` 里加了自己的网格、改了它的位置或材质、直接改了渲染器的设置。画面已经静止时，不调用的话改动要等到下一次别的变化才出现。场景里有自己逐帧变化的对象（转动的风扇、自定义着色器动画）时，在你的动画循环里每帧调用 `requestRender()`，或者创建时设 `idleFrameRate: 0`。
:::

同理，**不要直接改 `viewer.camera` 的位置和朝向**：用 `setView`、`flyTo`、`viewer.navigation`、`controller.playAnimation`。直接改的话，用户的手势打断不了它，也不会触发上面的重画逻辑。见[相机与导航](./camera.md)。

## 错误

SDK 主动抛出的错误都是 `TerraViewError`：`message` 是英文（给日志和开发者看），`code` 是稳定的字符串，可以据此给用户显示自己的提示；`details` 带上相关的值。

```ts
import { isTerraViewError } from 'terra-viewer';

try {
  viewer.indoor.add(doc);
} catch (err) {
  if (isTerraViewError(err, 'building-invalid')) alert(`建筑文档有误：${err.details.path}`);
  else throw err;
}
```

全部错误码见 [API 参考 §1.6](../api.md#_1-6-语言与错误)。

## 语言

SDK 自己生成、会给最终用户看的文字很少（BIM 实体的自动属性名、房间顶牌的默认副标题、点位图层的默认名、内置影像预设的显示名），默认中文，可以切换成英文或逐项改写：

```ts
GeoViewer.create({ container, imagery, locale: 'en' });
GeoViewer.create({ container, imagery, messages: { pointLayerName: '站点' } });
```

面板、按钮、提示这些界面由你的应用自己做，SDK 不带界面文案。
