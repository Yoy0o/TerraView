# 局部场景（沙盘模式）规范

> 状态：已实现（2026-11-18，分支 `feature/local-scene`，路线图 M4.9）。设计稿（2026-11-17）里的方案比较和取舍并入 §2，以后可做的事在 §10。

代码：`src/local/`（`region.ts` 区域数学、`regionMask.ts` 裁剪遮罩、`RegionWalls.ts` 侧壁、`RegionDimEffect.ts` 区域外压暗、`LocalScene.ts` 调度），以及 `Globe`（区域剔除、裁剪材质）、`TileMaterial`（`GlobeTileClipped`）、`tiles3d/regionMaskPlugin.ts` 与 `nodeMaterials.ts`（3D Tiles 屏蔽与遮罩）、`PickBuffer`（拾取材质带遮罩）、`GlobeCameraController.bounds`（活动范围）、`GeoViewer`（集成）。演示应用：`demo/ui/LocalScenePanel.ts`。测试：`tests/localRegion.test.ts`、`tests/e2e/demo.e2e.ts`（局部场景用例）。

## 1. 是什么

只显示地球上的一块区域（园区到城区，直径不超过 100 km）：区域内的地形、影像、贴地矢量和 3D Tiles 照常按视距分级加载，区域外不绘制、不加载；边缘有一圈土层侧壁（沙盘），背景换成展台天空；相机围着这块区域活动，拖不丢、缩不没。效果参考 three-geo（一块地形浮在纯色背景上），但不另建静态网格，仍是流式地球。

它是**地球场景下的一个子模式**，与建筑 / BIM 层级相互独立：

- 在局部场景里照常可以进出建筑、楼层；进出层级不影响局部场景。
- 退出局部场景不改变当前层级。
- 锚点在区域外的建筑整栋隐藏（`root.visible`，退出时恢复），不裁切建筑本身。

## 2. 取舍（2026-11-18 定）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 区域尺寸 | 圆半径 20 m–50 km；矩形、多边形外接直径 ≤ 100 km | 园区、城区够用；更大的范围 3D Tiles 加载吃力，棱柱和经纬度边界的偏差也变大（§3.2） |
| 默认外观 | 沙盘（土层侧壁）；`walls: false` 为悬浮地块 | 侧壁让斜视时有体积感，也挡住裁口里的瓦片裙边和地形背面；悬浮地块用"只写深度的隐形侧壁"实现，同样干净 |
| 与 BIM 的关系 | 独立开关 `viewer.localScene`，不做"园区层级" | 用户要求与建筑区分；园区层级留作以后（§10） |
| 绘制工具 | 只在演示应用里（`LocalScenePanel`） | SDK 先不定绘制 API，等测量、标绘一起设计 |
| 透明背景 | 不做 | 要在创建渲染器时开 `alpha`，后期管线也要保留 alpha |
| 区域外 | `'hide'`（默认）或 `'dim'`（压暗去饱和，后期效果实现） | `'dim'` 不改材质、不裁剪，保留周边作参照 |
| 背景 | `'studio'`（默认）、`'space'`、纯色 | studio 复用室内展台天空 |

方案比较（设计稿）：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| A 着色器遮罩：区域测试写成 `maskNode`，跨边界的瓦片 discard | **采用** | 地球和 3D Tiles 同一套；任意形状；能做抖动过渡；只改材质 |
| B Worker 构网时按区域切三角形 | 不采用 | 只管地球；打破网格布局约定（象限填充、射线、拾取都依赖 `tileMeshLayout`）；不能渐变 |
| C three 裁剪平面（`ClippingGroup`） | 以后给矩形用（§10） | 只能凸多边形（硬件最多 8 个面），圆要很多面；不能抖动过渡 |
| D 独立网格（three-geo 的做法） | 不采用 | 绕开加载通道和优先级（AGENTS.md §3.5），没有 LOD |
| E 后期遮盖 | 只用于 `'dim'` | 区域外的几何仍会挡住区域内、仍可拾取 |

## 3. 区域模型（`region.ts`）

### 3.1 输入

```ts
type LocalRegion =
  | { type: 'circle'; center: [lon, lat]; radius: number }          // 度；米
  | { type: 'rectangle'; west; south; east; north }                 // 度
  | { type: 'polygon'; coordinates: [lon, lat][] };                 // 单环、不自交，度
// LocalScene 另收 { type: 'tileset', layer }：取图层有向包围盒在地面的投影（凸包，最多 8 个顶点）
```

- 校验失败抛 `TerraViewError('option-invalid')`（`details.option = 'region'`）：坐标非法、|纬度| > 84°、跨反子午线、自交、面积为零、过大或过小。
- 矩形每条边加密成 8 段（32 个顶点），因为纬线投到切平面后是弯的。
- 多边形超过 64 个顶点时按 Douglas-Peucker 抽稀（容差从半径的万分之一起逐步放大）；收尾重复的顶点去掉。

### 3.2 区域坐标系与棱柱

- 原点是区域中心（圆心或经纬度包围盒中心）在地面上的点，轴为该点的 ENU。中心高度先取 0 m，`viewer.surfaceHeight` 可靠后移到地面（最多等 15 s；变化超过 0.5 m 才重算）。
- 区域是这个坐标系里的**竖直棱柱**：顶点按中心高度投到 XY 平面，Z 不限（CPU 判断时只在中心上下 30 km 内有效，挡掉地球背面）。地球裁剪、3D Tiles 裁剪、侧壁、拾取过滤、相机范围都用同一个棱柱，彼此一致。
- 与"按经纬度的边界"相差约 h·d/R（d = 20 km、高差 4 km 时约 12 m），所以限制了尺寸。
- `ResolvedRegion` 提供：`toRegion` / `toWorld`、`signedDistance(x, y)`（内正外负）、`containsWorld(p, margin)`、`contains(lon, lat)`、`relateSphere(center, r)`（外 / 跨 / 内，保守）、`clampXY`（夹回区域并外扩 margin）、`boundaryPoints(spacing)`。

## 4. 渲染

### 4.1 裁剪遮罩（`regionMask.ts`）

- 共享节点 `regionMaskNode()`，作为 `material.maskNode`（片元丢弃）。区域参数按渲染器存（`setRegionGpuState(renderer, state)`），节点图全页共享：`params`、多边形顶点用 `onRenderUpdate` 读当前渲染器的状态，没开局部场景的 viewer 读到 `keepOutside = 1`，遮罩恒为真。
- **精度**：片元的区域坐标是 `modelToRegion × positionLocal`，`modelToRegion = worldToRegion × matrixWorld` 每次绘制在 CPU 上用 float64 相乘（`onObjectUpdate`），着色器里没有 ECEF 量级的数；`positionLocal` 已含地形形变。
- **测试**：圆直接算；多边形一次循环同时求奇偶穿越和到各边的最近距离，得到有符号距离。
- **MSAA 与侧视的竖直面**：片元只有在"到边界的有符号距离 > 该像素在区域坐标里覆盖范围的一半（`fwidth`）"时才保留。原因：MSAA 下一个像素整体保留或丢弃，像素横跨边界时，它覆盖的、其实在区域外的采样点也会画出来。对朝向相机的面这只是半个像素；对被侧视成一条线的竖直面（瓦片裙边穿过边界），一个像素沿面能跨几十米，曾在侧壁上显出白色竖向点线（AGENTS.md §7）。代价是正常的面在边缘内缩不到半个像素。
- 过渡：`keepOutside`（0..1）按 4×4 Bayer 抖动保留区域外的一部分，进出时由 1 渐变到 0（与 3D Tiles 的 LOD 渐显同一图案）。

### 4.2 地球

- `Globe.setRegion(region, cull)`：`cull` 时 `testVisible` 把包围球与区域"外"的瓦片判为不可见（不选、不排队、不加载），预加载兄弟瓦片和下一级预取也跳过区域外的瓦片；区域外已加载的瓦片按 LRU 自然淘汰。极地圆盖隐藏。
- 瓦片材质分两个共享基础材质：`GlobeTile`（原来的）和 `GlobeTileClipped`（多一个遮罩）。瓦片在绘制前按包围球分类：内 → 普通材质（保留 early-Z），跨 → 裁剪材质。`NodeMaterialInstance` 不能换基础材质，所以 `GlobeTile.setClipped` 新建实例、拷贝逐瓦片属性（影像、变换、淡入、形变、叠加层），网格和象限填充一起换。瓦片重建网格或区域变化（`regionGen`）时重新分类。
- 过渡期间（`cull = false`）所有瓦片都用裁剪材质，区域外照常加载，靠 `keepOutside` 淡出。
- `Globe.sampleRenderedHeight(lon, lat)`：沿上一帧的选择结果找到**实际绘制**的瓦片（或顶替它的象限填充）取高，并给出该瓦片的格网间距。侧壁用它，而不是"已加载的最细瓦片"。
- `Globe.raycast(ray, accept)`：带过滤时只取被接受的命中，并且不退回椭球面。

### 4.3 3D Tiles

- `RegionMaskPlugin`：`calculateTileViewError` 里瓦片包围球与棱柱不相交就返回 `inView = false`（库按 mask 语义屏蔽，不遍历不加载）；**相交时返回 false（不干预）**。库的 `LoadRegionPlugin` 不能直接用：插件对瓦片作答时库会把它当作可见，区域内视野外的瓦片也会加载，而且按固定误差全细化。
- 遮罩与 LOD 渐显组合成三个共享节点（`tileMaskNode(fading, clipped)`：渐显 / 区域 / 两者），`NodeFadeMaterialManager` 和 `setMaterialClipped` 都经它选节点；新瓦片在 `NodeMaterialPlugin.processTileModel` 里挂上。要素高亮的叠加网格也裁。
- 目前图层的所有材质都挂遮罩（不按瓦片分类）；倾斜摄影大量重叠时 GPU 时间会上升，见 §10。

### 4.4 侧壁（`RegionWalls.ts`）

- **几何**：沿边界一圈列，每列从地表垂到统一的底面（`base = 边界最低点 − depth`，`depth` 默认区域直径的 2%，30–1000 m）。顶点在区域坐标系里（float32 足够），每段一个平面四边形，法线朝外（环的方向自动判断）。
- **顶部高度**：
  - 地形：按实际绘制的瓦片取高，沿边界以该处瓦片的格网间距行进（最多 8192 列），所以侧壁顶边跟着地形的起伏走；`surfaceSignature` 变化时重建（至少隔 150 ms）。
  - 3D Tiles：固定约 1024 列，竖直射线（`raycastTilesVertical`），每帧 2 ms 预算分摊；图层内容变化 600 ms 后重新量一遍。与地形同时存在时取较高者。
- **外移**：侧壁比裁剪边界向外挪 `max(5 cm, 半径 × 1e-5)`，瓦片裙边止于边界、在侧壁之后，不会与侧壁同深度。
- **外观**：程序着色，无贴图：上浅下深的土色、按绝对高度的细层理线（屏幕上过密时消失）、约 1.5 px 的顶边亮线；按光照着色（`viewer.lighting` 时用太阳方向，否则用西北 45° 的"地图光"），朝向不同的壁面明暗不同。不参与拾取。
- **隐形侧壁**（`walls: false`）：`colorWrite = false`、`renderOrder = -10`，先于其他不透明物体写深度，裁口处露出背景。
- 进出时按 `reveal`（抖动）显隐；遮罩只在半显时挂上。

### 4.5 背景与环境

| 项 | 局部场景中（`outside: 'hide'`） |
| --- | --- |
| 背景 | `'studio'`：展台天空（`studioSkyNode`，以区域中心的竖直方向为地平线）；纯色；`'space'` 保留大气天空 |
| 星空 | 随背景混合量淡出（`'space'` 除外） |
| 空气透视 | 背景混合量过半时关闭（它的雾色按真实天空调，和展台背景不搭） |
| 云层 | 局部场景期间隐藏 |
| 光照 | 沿用 `viewer.lighting` |

`'dim'` 时背景、星空、大气照旧，只叠加压暗效果（§4.6）。

### 4.6 区域外压暗（`RegionDimEffect`）

后期管线 `linear` 阶段的效果（`order = -100`）：用场景深度重建视空间位置，乘 `viewToRegion`（CPU 上 float64），区域外的像素压暗到 32% 并去饱和 65%，天空不变。不改材质、不 discard；区域外照常可见、可拾取、加载。

## 5. 交互

### 5.1 进入与退出

| 入口 | 说明 |
| --- | --- |
| API | `viewer.localScene.enter({ region, ... })`；再次调用即换区域或改选项 |
| 演示面板"局部场景（沙盘）" | 当前视野（屏幕中心为圆心，画面下方 85% 处的地面距离为半径）、画矩形、画圆、画多边形；外观（沙盘 / 悬浮地块 / 区域外压暗）、背景（展台 / 星空与大气 / 纯黑）；回到总览、退出 |
| URL（演示应用） | `?region=circle:经度,纬度,半径km`、`rect:西,南,东,北`、`poly:经度,纬度;经度,纬度;…`；`?regionLook=sandbox\|float\|dim` |
| Esc（演示应用） | 依次：关属性弹窗 → 室内返回上一级 → 取消绘制 → 退出局部场景 |

进入：飞到总览视点（航向沿用当前、俯仰 −35°，区域包围球放进视场并留 15% 边距；容器窄于 16:9 时按水平视场放大距离），同时区域外在 `transition`（默认 0.8 s）内抖动淡出、背景换成展台、侧壁显出；淡出结束后才打开区域剔除。退出：先关剔除，区域外淡入，默认飞回进入前的视点（`restoreView: false` 留在原地）。

### 5.2 相机（`controller.bounds`）

| 操作 | 局部场景中 |
| --- | --- |
| 左键拖拽 | 抓地平移；光标落在区域外时抓参考面（区域中心高度的椭球面），照样跟手。视线不能离开区域（见下）；光标越过地平线时不再移动 |
| 滚轮 / 捏合 | 光标在区域内向光标缩放；在区域外向区域中心缩放。拉远到 `maxRange`（默认总览距离的 2 倍）为止 |
| 右键 / 中键拖拽 | 绕屏幕中心点；中心落在区域外时绕区域中心（不再原地环视） |
| 双击区域内 | 飞近；建筑照常进入层级 |
| 双击区域外 | 回到总览（`interaction` 上 `tag: 'local-scene'` 的内置监听，可暂停） |
| 右键单击 | 不退出（防误触） |
| Home（`navigation.home()`） | 回到总览 |
| 自动环绕 | 中心落空时绕区域中心 |
| 程序飞行 | 飞行中不约束，结束后拉回 |

`CameraBounds { center, referenceHeight, maxRange, clampFocus }`（高级 API，不开局部场景也能当"活动范围"用）。规则（`holdInBounds`）：

1. **视线不能离开区域**：取屏幕中心射线从相机到参考面的那一段上离 `center` 最近的点，交给 `clampFocus` 夹回区域（外扩 `margin`，默认半径的 0.25 倍），相机随之平移。俯视时这个点就是屏幕中心的地面点；低角度看过区域时视线可以落到很远，不会把相机推回去。
2. **最远距离**：离 `center` 超过 `maxRange` 时水平拉近。
3. **高度不变**：所有约束都在相机原来的椭球高上横向移动，再按原航向、俯仰重建零 roll 姿态。沿直线拉回（朝地面上的中心点、或沿中心的切平面）每帧都会让相机低一点，持续往外拖时会一路滑到地面；有约束时的平移也保持高度（绕地心旋转到别的纬度，椭球半径不同）。
4. 防入地：区域外的"地面"是侧壁底面（`groundOutside`），相机不会低于它。

### 5.3 拾取、贴地、顶牌

- 拾取缓冲：拾取材质带上源材质的区域遮罩（`hasRegionMask`），基础材质按"位置节点 × 是否裁剪"缓存。
- CPU 射线（`viewer.pick` 退回路径、手势拾取）：3D Tiles 取全部命中后过滤，地球用 `raycast(ray, accept)`；手势在区域外落空，由 `bounds` 接手。
- `viewer.surfaceHeight` / 防入地：区域外返回侧壁底面高度（`reliable: true`，`source: 'ellipsoid'`）。
- 顶牌（`MarkerManager.regionFilter`）、注记（`LabelManager.regionFilter`）：锚点在区域外的隐藏。点位聚合按聚合中心判断（跨边界的聚合数字会包含区域外的点）。

## 6. API

```ts
viewer.localScene.enter(options: LocalSceneOptions): Promise<void>
viewer.localScene.exit({ restoreView?: boolean }): Promise<void>
viewer.localScene.fit(duration?: number): Promise<void>
viewer.localScene.set(options)           // 侧壁、背景、相机、过渡；不含 region / outside / globe
viewer.localScene.contains(lon, lat)     // 度
viewer.localScene.active / region        // ResolvedRegion | null
viewer.localScene.events                 // 'enter' { region } / 'exit'

interface LocalSceneOptions {
  region: LocalRegion | { type: 'tileset'; layer: Tiles3DLayer };
  outside?: 'hide' | 'dim';                                   // 默认 'hide'
  walls?: boolean | { depth?: number; color?: ColorRepresentation; edge?: boolean };  // 默认 true
  background?: 'studio' | 'space' | ColorRepresentation;      // 默认 'studio'
  globe?: 'clip' | 'hide';                                    // 默认 'clip'；自带地面的数据用 'hide'
  camera?: { fit?; heading?; pitch?; constrain?; margin?; maxRangeScale? };
  transition?: number;                                        // 秒，默认 0.8
}
```

导出：`LocalScene`、`LocalSceneOptions` 等类型、`LocalRegion`、`ResolvedRegion`、`MAX_REGION_DIAMETER` / `MAX_REGION_VERTICES` / `MIN_REGION_RADIUS`（稳定）；`CameraBounds`（高级）。详见 [api.md](../api.md) §1.11。

## 7. 帧率

过渡和侧壁重建是"自己会变"的工作：`LocalScene.update` 返回 `busy` 时 viewer 请求下一帧并让拾取缓冲失效（裁剪和淡出改变画面但不改变绘制数）。静止后回到空闲降帧。

## 8. 实测（2026-11-18，本机 Chrome 无头，Intel Iris Xe，1280×720，4×MSAA）

- 艾格峰一带（ESRI 影像 + AWS 地形）11 km × 8 km 矩形：区域内 17 块瓦片（不开局部场景同视角 152 块）；GPU 时间 9–10 ms，与不开局部场景（约 9 ms）相当；4 顶点和 32 顶点多边形开销相同。
- 侧壁顶边与地形裁边贴合，近看（1.7 km）无点线、无缝。
- WebGL2 后端外观一致；拾取区域外为空，`surfaceHeight` 区域外返回底面高度。
- 3D Tiles（CesiumGS 样例 `TilesetWithDiscreteLOD`）：取图层投影为区域时模型连同下方地形成为沙盘；半个模型大小的圆形区域把模型在边界处切开。
- 演示面板：画矩形（两次单击）、画多边形（单击 + 双击结束）、当前视野、Esc 退出均正常；把光标拖出窗口（越过地平线）后相机高度不变。
- `npm run smoke`：6 项通过（新增局部场景用例 WebGL / WebGPU 各一）。

## 9. 测试

- `tests/localRegion.test.ts`：形状解析与校验（含抽稀、自交、跨反子午线、过大过小）、有符号距离、包围球分类（含地球背面、过高）、夹回、边界采样、凸包与包围盒投影、侧壁几何朝外与绕序；相机约束：视线拉回且保持航向俯仰与零 roll、区域内不动、低角度看过区域不被推回、拉远停在 `maxRange`、落空时绕区域中心、往外拖到地平线以外高度不变。
- `tests/e2e/demo.e2e.ts`："局部场景"用例：`?region=` 进入、区域中心拾取到地球、角落拾取为空、区域外贴地高度可靠、`contains`、退出后清空约束。

## 10. 以后可做

- 3D Tiles 按瓦片分类挂遮罩（完全在区域内的瓦片不挂，恢复 early-Z），先实测倾斜摄影的开销。
- Worker 按瓦片自身高度网格生成侧壁（与地形边缘严丝合缝、随形变同步），目前按绘制瓦片采样已看不出缝，暂不需要。
- 矩形区域改用硬件裁剪平面（WebGPU `clip-distances`），省掉 discard。
- 点位按区域过滤后重建聚合树。
- "园区"层级：建筑文档加 `site.region`，进入建筑时可选进入它的场地。
- SDK 层的绘制 API（与测量、标绘一起）。
- 跨边界的建筑剖面只有侧壁挡着，侧壁的竖直射线量不到的部分（屋檐、悬挑）是空心的；封口要用模板缓冲画剖面。
