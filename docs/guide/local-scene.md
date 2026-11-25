# 局部场景（沙盘）

`viewer.localScene` 只显示地球上的一块区域（园区、景区到城区，直径不超过 100 km）：区域内的地形、影像、贴地矢量和 3D Tiles 照常按视距分级加载，区域外**不绘制、不加载**；边缘一圈土层侧壁，背景换成展台，相机围着这块区域活动，拖不丢、缩不没。

它适合"只讲这一块地方"的展示：园区大屏、景区导览、项目选址。局部场景是地球场景下的一个子模式，与建筑层级互不影响：在局部场景里照常可以进出建筑和楼层，退出局部场景也不改变当前层级。

## 进入与退出

```ts
// 圆：中心 [经度, 纬度]（度），半径（米）
await viewer.localScene.enter({ region: { type: 'circle', center: [116.39, 39.91], radius: 3000 } });

// 再次调用 enter 就是换区域、改外观
await viewer.localScene.enter({
  region: { type: 'rectangle', west: 7.96, south: 46.55, east: 8.07, north: 46.62 },
  walls: false, // 悬浮地块
});

await viewer.localScene.exit(); // 默认飞回进入前的视点；exit({ restoreView: false }) 留在原地
```

`enter()` 立即生效，相机飞到区域的总览视点，区域外在 0.8 s 内淡出；飞行和淡出都完成时 Promise resolve。区域不合法时**同步**抛出 `TerraViewError`（`code: 'option-invalid'`，`details.option = 'region'`），状态不变。

## 区域

| 形状 | 写法 | 限制 |
| --- | --- | --- |
| 圆 | `{ type: 'circle', center: [经度, 纬度], radius }` | 半径 20 m – 50 km |
| 矩形 | `{ type: 'rectangle', west, south, east, north }` | 度；外接直径 ≤ 100 km |
| 多边形 | `{ type: 'polygon', coordinates: [[经度, 纬度], …] }` | 单环、不自交，首尾不必重复；超过 64 个顶点自动抽稀 |
| 图层范围 | `{ type: 'tileset', layer }` | 一个 3D Tiles 图层的包围盒在地面上的投影 |

所有形状都不能跨反子午线（经度 ±180°），纬度绝对值不超过 84°。导出的常量 `MAX_REGION_DIAMETER`、`MIN_REGION_RADIUS`、`MAX_REGION_VERTICES` 是这几个上限。

区域是区域中心处的一个竖直棱柱，地球瓦片、3D Tiles、侧壁、拾取和相机范围都按同一个棱柱裁剪，彼此一致。它与"按经纬度画的边界"在高差大的地方略有出入（20 km 宽、高差 4 km 时约 12 m），这也是限制尺寸的原因。

只看一个倾斜摄影数据集时，用它自己的范围作区域，并隐藏地球（数据自带地面，地球会从数据里透出来）：

```ts
const layer = viewer.addTileset({ source: { type: 'url', url: '/data/campus/tileset.json' } });
layer.events.on('ready', () => {
  void viewer.localScene.enter({ region: { type: 'tileset', layer }, globe: 'hide' });
});
```

## 外观

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `outside` | `'hide'` | `'hide'`：区域外不画不加载。`'dim'`：区域外压暗、去饱和，照常显示和加载（保留周边作参照；没有侧壁、背景照旧） |
| `walls` | `true` | 土层侧壁（沙盘）。`false`：悬浮地块，裁口处露出背景。对象 `{ depth, color, edge }`：侧壁底面在边界最低点以下多深（米，默认区域直径的 2%，30–1000）、土色、顶边亮线 |
| `background` | `'studio'` | `'studio'` 展台渐变、`'space'` 保留星空和大气，或一个颜色 |
| `globe` | `'clip'` | `'hide'`：局部场景期间隐藏地球（退出时恢复） |
| `transition` | 0.8 | 区域外淡出 / 淡入的秒数，0 立即切换 |
| `camera` | — | 见下一节 |

`outside`、`globe` 和区域本身只能经 `enter()` 改；侧壁、背景、相机和过渡可以用 `set()` 直接改，不重新飞行：

```ts
viewer.localScene.set({ walls: { depth: 200, color: '#6b4f3a' }, background: 'space' });
```

## 相机

进入时相机飞到总览视点（航向沿用当前，俯仰 -35°，整个区域放进画面），之后被限制在区域周围：

| 操作 | 局部场景中 |
| --- | --- |
| 左键拖动 | 平移；视线不能离开区域（屏幕中心最多越出边界半径的 25%），相机高度不变 |
| 滚轮 | 光标在区域内时向光标缩放，在区域外时向区域中心缩放；拉远到总览距离的 2 倍为止 |
| 右键拖动 | 绕屏幕中心旋转；中心落在区域外时绕区域中心 |
| 双击区域外 | 回到总览（内置监听，`viewer.interaction` 上 `tag: 'local-scene'`，可以暂停） |
| 右键单击 | 不退出局部场景（防误触） |
| `viewer.navigation.home()` | 回到总览 |
| 程序飞行（`flyTo` 等） | 飞行中不约束，结束后拉回区域 |

`camera` 选项：`fit`（进入时飞到总览，默认 `true`）、`heading` / `pitch`（总览的航向、俯仰，度）、`constrain`（是否限制，默认 `true`）、`margin`（视线可越出区域的距离，占半径的比例，默认 0.25）、`maxRangeScale`（最远距离 = 总览距离 × 它，默认 2）。`viewer.localScene.fit(duration?)` 随时飞回总览。

活动范围本身是通用的 `viewer.controller.bounds`（`CameraBounds`，高级 API），不开局部场景也可以单独用来限制相机，见 [camera-controller.md](../agents/camera-controller.md) §3.6。

## 和其他功能的关系

- **拾取**：区域外拾取落空（`viewer.pick`、交互事件的 `point` 为 null），被裁掉的东西点不到。
- **贴地**：`viewer.surfaceHeight` 在区域外返回侧壁底面的高度。
- **顶牌、注记、建筑**：锚点在区域外的隐藏；跨边界的点位聚合按聚合中心判断。
- **高斯泼溅**：场景中心在区域外的整层隐藏，不裁切。
- **云**：局部场景期间不画云。
- **你自己加进 `viewer.scene` 的对象**不会被裁剪，需要时用 `viewer.localScene.contains(经度, 纬度)` 自己判断显隐。

## 状态与事件

```ts
viewer.localScene.active;               // 是否在局部场景里
viewer.localScene.region;               // ResolvedRegion | null：longitude / latitude（中心，度）、radius（米）、outline 等
viewer.localScene.contains(116.4, 39.9); // 某个经纬度（度）是否在区域内

viewer.localScene.events.on('enter', ({ region }) => console.log('进入，半径', region.radius));
viewer.localScene.events.on('exit', () => console.log('回到地球'));
```

`enter` 在调用 `enter()` 时发出（换区域也会再发），`exit` 在区域外完全淡回后发出。

## 代价

区域外的瓦片不选、不排队、不加载，所以局部场景通常比同样视角的完整地球更省：实测 11 km × 8 km 的山区矩形，区域内只有 17 块地形瓦片（同视角完整地球 152 块），GPU 时间与不开局部场景相当。圆和多边形开销相同。3D Tiles 目前对整个图层挂裁剪遮罩（片元丢弃），大量重叠的倾斜摄影会多一些 GPU 时间。

设计、裁剪做法和实测见 [local-scene.md](../agents/local-scene.md)，完整选项见 [API 参考 §1.12](../api.md#_1-12-局部场景-沙盘)。

## 示例

<ExampleFrame id="local-scene" />

示例源码：[examples/local-scene/main.ts](../../examples/local-scene/main.ts)。三个按钮分别进入圆形（黄山）、矩形（艾格峰）和多边形（西湖）区域，可以切换区域外压暗、侧壁和背景。
