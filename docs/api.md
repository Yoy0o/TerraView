# TerraView 公共 API

面向在应用里嵌入 TerraView 的开发者。这里列的是从包入口 `terra-view`（`src/index.ts`）导出的内容；没有导出的模块是内部实现，随时可能变。各子系统的细节在 [docs/agents/](agents/)。

> 状态：0.1.0，私有包。0.x 阶段次版本号可以有破坏性变更，变更记入 [CHANGELOG](../CHANGELOG.md)。

## 1. 接入

```ts
import 'terra-view/style.css';
import { GeoViewer, IMAGERY_PRESETS } from 'terra-view';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: IMAGERY_PRESETS[0].create(), // 底图影像源，必填
});
```

| 事项 | 说明 |
| --- | --- |
| 包入口 | `terra-view`（ES 模块，`dist/terraview.js`，类型在 `dist/types/`）；`terra-view/style.css` |
| peer 依赖 | `three` 0.187.x、`3d-tiles-renderer` 0.5.x，由宿主安装，不打进包。TypeScript 宿主另装 `@types/three@0.187.0` |
| 浏览器 | WebGPU（Chrome / Edge 113+），没有时自动回退 WebGL 2；`forceWebGL: true` 强制 WebGL 2 |
| 打包工具 | Worker 是 `dist/assets/*.worker-*.js`，用 `new URL(..., import.meta.url)` 引用。Vite 8（开发与构建）已实测；webpack 5（style-loader / css-loader）已实测：构建、运行，以及 Draco、KTX2、meshopt 模型的实际解码（不用设解码器路径） |
| 释放 | `viewer.dispose()`：停止渲染循环，释放 GPU 资源、Worker、监听，移除 canvas，恢复容器 |

### 1.1 容器

`container` 可以是任意有尺寸的元素，不必铺满窗口；尺寸变化由内部的 `ResizeObserver` 跟随。`GeoViewer` 对容器做三件事，`dispose()` 时恢复：

- 加 `tv-viewer` 类（样式作用域，并让顶牌的 `z-index` 留在 viewer 内部）。
- `position` 是 `static` 时改成 `relative`（顶牌层和淡出层相对容器定位）。
- 没有 `tabindex` 时设为 `-1`，用来接收键盘。

### 1.2 样式与主题

`terra-view/style.css` 只管 SDK 创建的元素，类名都以 `tv-` 开头：

| 类 | 元素 |
| --- | --- |
| `.tv-viewer` | 容器 |
| `.tv-canvas` | 渲染用的 canvas |
| `.tv-crossfade` | 层级切换时淡出的上一帧 |
| `.tv-marker-layer`（密集时加 `.tv-dense`） | 顶牌层 |
| `.tv-marker`（`.tv-interactive`、`.tv-occluded`） | 单个顶牌的定位外壳 |
| `.tv-card` + `.tv-<样式名>`（`.tv-selected`） | 顶牌内容，样式名见 [markers.md](agents/markers.md) §2 |

主题变量设在容器或任意祖先上：`--tv-font`、`--tv-text`、`--tv-muted`、`--tv-card-bg`；单个顶牌的强调色是 `--tv-accent`（由 `color` 选项设置）。自定义顶牌可以直接给 `viewer.markers.add({ element })` 传自己的元素，不必用内置样式。

### 1.3 键盘与焦点

相机快捷键（W A S D / 方向键平移，Q E 转向，R F 俯仰）只在焦点位于 viewer 内时生效，不监听 `window`：同页多个 viewer 互不影响，宿主的输入框和快捷键不受干扰。点击 canvas 或顶牌会让 viewer 获得焦点；要一打开就能用键盘，调用 `viewer.canvas.focus()`。带 Ctrl / Meta / Alt 的组合键不处理。`viewer.controller.enableKeyboard = false` 关闭。

Esc 返回上一级之类的全局快捷键属于应用，SDK 不注册，写法见 `demo/main.ts`。

### 1.4 解码器

glTF 的 Draco、KTX2（Basis）解码器默认用宿主安装的 three.js 自带的文件，由宿主的打包工具处理。要自己托管时：

```ts
GeoViewer.create({ container, imagery, decoderPath: '/libs/draco/gltf/', transcoderPath: '/libs/basis/' });
```

### 1.5 凭证

天地图、Cesium ion、Google、Mapbox、MapTiler 的密钥由宿主作为参数传入（`IMAGERY_PRESETS[i].create(key)`、`cesiumIonTerrain(token)`、`addTileset({ source: { type: 'google', apiKey } })` 等）。SDK 不保存、不内置任何凭证。

### 1.6 语言与错误

SDK 自己生成、会给最终用户看的文字只有几类，默认中文（`zh-CN`），可以切换成英文或逐项改写：

```ts
GeoViewer.create({ container, imagery, locale: 'en' });
GeoViewer.create({ container, imagery, messages: { entityProperties: { area: '建筑面积' }, pointLayerName: '站点' } });
```

| 文字 | 来源 | zh-CN / en |
| --- | --- | --- |
| BIM 实体的自动属性名 | `messages.entityProperties` | 楼层数 / Floors、建筑高度 / Building height、楼层 / Floor、标高 / Elevation、层高 / Storey height、面积 / Area、类型 / Type |
| 房间顶牌的默认副标题 | 取 `area` 属性 | 同上 |
| 没有名字、也没有 URL 的点位图层名 | `messages.pointLayerName` | 点位 / Points |
| 内置影像、叠加层预设的显示名 | 预设的 `label`（`LocalizedText`），用 `localize(preset.label, locale)` 取 | 各预设两种语言都有 |

`viewer.locale`、`viewer.messages` 是生效的语言和文字。属性名是实体 `properties` 的键：选择器和样式规则里要用当前语言的名字（`[面积>20]` 或 `[Area>20]`）。服务商署名（attribution）保持服务商要求的原文；输入数据里认的字段别名（"经度""名称"等）与语言无关。

**错误**：SDK 主动抛出的错误都是 `TerraViewError`：`message` 是英文（给日志和开发者看），`code` 稳定、可以据此翻译或处理，`details` 带上相关的值。用 `isTerraViewError(err, code?)` 判断。

| `code` | 何时 | `details` |
| --- | --- | --- |
| `imagery-unreachable` | 底图影像累计 3 次请求失败（每个影像源一次；`viewer.events` 的 `error`，`source: 'imagery'`；高级 API 另有 `globe.onImageryError`、`globe.imageryError`） | `provider`、`reason` |
| `terrain-unreachable` | 地形瓦片累计 3 次构建失败（每个地形源一次；`error` 事件，`source: 'terrain'`；`globe.terrainError`）。失败的瓦片保留原来的网格，之后退避重试 | `source`（地形源名称）、`reason` |
| `tileset-load-failed` | 3D Tiles 的根 tileset 加载失败（图层的 `error` 事件、`layer.error`；`viewer.events` 的 `error`，`source: 'tileset'`）。之后单个瓦片的失败只记日志，由库重试 | `url`、`reason` |
| `terrain-format-unsupported` | quantized-mesh 的 layer.json 格式不认识 | `format` |
| `terrain-projection-unsupported` | quantized-mesh 不是 EPSG:4326 | `projection` |
| `ion-asset-not-terrain` | Cesium ion 资产不是地形 | `assetId`、`type` |
| `building-invalid` | 建筑文档校验失败（`parseBuildingDoc`、`indoor.add`） | `path`（如 `$.floors[0].height`） |
| `building-already-loaded` | 同一 id 的建筑重复加载 | `id` |
| `points-empty` | 点位数据里没有可用的点（`message` 带第一条解析告警） | 无 |
| `geojson-invalid` | GeoJSON 无法识别（`addGeoJson`） | 无 |
| `option-invalid` | `GeoViewer.create` 的必填项缺失或类型不对（`container` 要是元素，`imagery` 要是影像源）；在创建渲染器之前检查 | `option`、`expected` |

图层异步加载失败时，`Tiles3DLayer`、`GeoJsonLayer`、`PointLayer` 的 `error` 事件带上错误（`{ message, error }`），可以照样按 `code` 处理。网络错误（`HTTP 404` 等）和第三方库的错误照原样抛出，不包装。演示应用把 code 译成中文的写法见 `demo/ui/errors.ts`。

**统一监听**：`viewer.events.on('error', ({ source, error, layer }) => …)` 收到上面所有加载失败（`ViewerError`）：`source` 是 `imagery` / `terrain` / `tileset` / `geojson` / `points`，图层的失败带 `layer`。图层自己的 `error` 事件照常触发，两处选一处处理即可。

### 1.7 加载状态

`viewer.loadState`（`LoadState`，截至上一帧）：

| 字段 | 含义 |
| --- | --- |
| `globe` | 地球瓦片正在请求和排队的数量（地形、影像、叠加层）；地球隐藏时为 0 |
| `tilesets` | 正在绘制的 3D Tiles 图层里排队、下载、解析中的瓦片数（`Tiles3DLayer.pending`，根 tileset 加载中算 1） |
| `layers` | 还在加载数据的 GeoJSON、点位图层数 |
| `pending` | 以上三项之和 |
| `idle` | 没有待加载的内容，并且屏幕上的地球瓦片都显示着自己的影像（不是放大的祖先影像）。影像源已报告不可达时，不再等它 |

事件：`load-progress`（`loadState` 变化时，每帧最多一次）、`idle`（`idle` 变为 true 时；之后每轮加载结束都会再触发，启动时即使没有要加载的也触发一次）。等画面加载完再截图：

```ts
viewer.events.on('idle', () => {
  const png = viewer.captureFrame().toDataURL();
});
```

`idle` 只看网络和解码：建筑模型的加载不在其中。楼层和设备的 glTF 模型在楼层第一次显示时才加载（[indoor-bim.md](agents/indoor-bim.md) §5.4），要等它们就 `await building.modelsLoaded(entity)`。

### 1.8 帧率与功耗

画面静止时也按显示器刷新率每帧渲染，开销不小：实测（RTX 40 系列独显、1920×1080）地球静止约占 0.4–0.6 个 CPU 核，建筑场景 0.8–1.3 个核，GPU 每秒忙 100–230 毫秒；集显笔记本、4K 和高刷新率屏幕更高。所以 viewer 默认在画面**安静 1 秒后降到每秒 10 帧**，有变化立刻恢复全帧率；实测静止时的 CPU 占用降到原来的约三分之一到四分之一。

| 项 | 说明 |
| --- | --- |
| `GeoViewerOptions.idleFrameRate`、`viewer.idleFrameRate` | 安静时每秒画几帧，默认 10。0 表示不降帧（每帧都画）；其他值限在 10–60（低于 10 时省电不稳定，按时间推进的运动也会变慢） |
| 什么算"有变化" | 容器上的指针、滚轮、键盘输入；相机运动（手势、飞行、动画、惯性、环绕，包括从代码发起的）；加载未完成（`loadState.idle` 为 false）；层级切换、选中、悬停；图层增删；尺寸变化；场景开关（`lighting` 等）；`timeMultiplier` 不为 0。从代码做的改动也算，在下一个动画帧（约 16 ms）就恢复全帧率：实体的 `setStyle` / `visible` / `levelOpacity` / `refreshTransform()`、建筑模型加载完成或卸载、`indoor.showLabels` / `expandFloors`、`clouds.set()`、3D Tiles 图层的 `visible` / `heightOffset`、GeoJSON 图层的 `visible` / `setStyle` / `setLabelStyle`、叠加图层（`viewer.overlays`）的增删和属性、点位图层的 `visible` / `setStyle` / `setCluster`、顶牌增删。分几帧做完的工作（点位顶牌每帧最多建 200 个、顶牌放置）做完之前一直保持全帧率 |
| 云层 | 可见时按它在屏幕上的漂移速度决定帧率（每帧移动不超过约 1.5 px）：整球视角仍是 10 帧，离地 1500 km 左右约 30 帧，更低时每帧都画 |
| `viewer.requestRender()` | 恢复全帧率至少 1 秒。经 SDK API 做的改动 viewer 都能发现（见上一行）；绕过 SDK 直接改 three 对象时调用，例如往 `viewer.scene` 加了对象、改了 `viewer.scene` 里对象的位置或材质，否则改动要等下一个安静帧（最多 100 ms）才出现 |
| 容器不可见 | 容器滚出视口或 `display: none` 时完全不画（`IntersectionObserver`），回到视口立刻恢复。这期间加载不推进，`idle` 事件也不会触发 |
| 统计 | `viewer.stats.throttled` 表示当前是否按安静帧率在画；`stats.fps` 和 `frame` 事件按实际画的帧走，安静时约为 10 |

标签页隐藏时浏览器本来就会停掉渲染，不需要额外处理。

## 2. 约定

- **坐标**：世界坐标是 ECEF，单位米，+Z 指向北极。公共 API 的经纬度用度，高度是 WGS84 椭球高（米），航向自北顺时针（度），俯仰向下为负（度）。带 `Vector3` 的参数是 ECEF 点。
- **事件**：各对象的 `events` 是 `EventEmitter`，`on(type, handler)` 返回取消函数。
- **相机**：不要直接改 `viewer.camera` 的位姿，用 `setView` / `flyTo` / `viewer.navigation` / `controller.playAnimation`，否则手势打断不了，也不触发按需更新。
- **API 分级**：§3 每项都标了级别。
  - **稳定**：不加标记。0.x 期间也尽量不破坏，破坏时记入 CHANGELOG。
  - **高级**：源码和声明里标 `@advanced`。给扩展和调试用，直接接触引擎对象（`viewer.renderer` / `scene` / `camera` / `globe` / `pickBuffer` / `levelTransition` 等）或暴露实现细节；次版本可以改，不预先废弃。
  - **内部**：不从包入口导出，公开对象上的内部成员（`@internal`）也不出现在类型声明里。JavaScript 宿主仍能在运行时访问它们，但随时可能变。

## 3. 导出清单

"级别"一列见 §2：没写的都是稳定。一个类经 viewer 的成员使用时（如 `viewer.indoor`），级别指通过这个成员的用法；类里只给 viewer 自己调用的方法是内部，不在声明里。

### 3.1 viewer

| 导出 | 用途 | 级别 |
| --- | --- | --- |
| `GeoViewer` | 总入口。`GeoViewer.create(options)` 创建；`setView` / `getView` / `flyTo` / `flyToTarget` / `flyToBBox` / `flyToSphere` / `flyToEntity` / `resetNorth`；`startAutoOrbit` / `stopAutoOrbit` / `playIntro`；`addTileset` / `addGeoJson` / `addPoints` 及对应的 `remove*`，列表 `tilesets` / `vectorLayers` / `pointLayers`；`pick` / `pickAt` / `pickCartographic` / `pickFeature`、`highlightFeature` / `highlightedFeature`；3D Tiles 要素 `pickTileFeature`、`highlightTileFeature` / `highlightedTileFeature`（§3.3）；`surfaceHeight`；`loadModel`；`captureFrame`；开关 `atmosphere` / `lighting` / `showStars` / `showGlobe` / `indoorBackdrop`，时间 `date` / `timeMultiplier`；`ellipsoid`；`dispose` | 稳定 |
| `viewer.renderer`、`viewer.scene`、`viewer.camera` | three.js 的渲染器、场景、相机（定位 DOM、投影坐标、加自己的对象）。不要直接改相机位姿（§2） | 高级 |
| `viewer.levelTransition` | 层级切换淡出（`duration = 0` 关闭）；类型 `FrameCrossfade` 不从入口导出 | 高级 |
| `GeoViewerOptions`、`ViewPosition`、`TargetView`、`SphereFlightOptions`、`SurfacePick`、`FeaturePick` | 创建参数、视点与拾取结果类型 | 稳定 |
| `viewer.events`（`ViewerEvents`） | 帧统计、图层增删、点位单击，加载失败 `error`（`ViewerError`、`ViewerErrorSource`，§1.6）、加载进度 `load-progress` 与 `idle`（§1.7） | 稳定 |
| `viewer.loadState`（`LoadState`） | 还有什么在加载（§1.7） | 稳定 |
| `viewer.info`（`RendererInfo`）、`viewer.stats`（`FrameStats`）、`viewer.memory`（`MemoryReport`，含建筑模型 `buildings`）、`viewer.gpu`（`GpuProfile`）、`viewer.locale`、`viewer.messages` | 后端与适配器、帧耗时、显存估算、档位预算、语言与文案 | 稳定 |
| `viewer.canvas` | 渲染用的 canvas | 稳定 |
| `viewer.idleFrameRate`、`viewer.requestRender()`、`stats.throttled` | 安静时降帧与唤醒（§1.8） | 稳定 |
| `GlobeCameraController`（`viewer.controller`） | 手势开关（`enablePan` / `enableRotate` / `enableTilt` / `enableZoom` / `enableKeyboard`）、`zoomBy` / `orbitBy`、`playAnimation`、环绕巡航；[camera-controller.md](agents/camera-controller.md) | 稳定 |
| `NavigationControls`（`viewer.navigation`）、`AUTO_ROTATE_DEFAULTS`、`INTRO_DEFAULTS` | 放大缩小、转向、2D/3D、回到初始视角、自动旋转、全屏、截图；[intro-and-navigation.md](agents/intro-and-navigation.md) | 稳定 |
| `InteractionManager`（`viewer.interaction`） | `on(type, handler, { selector, tag, priority, once })`、`off`、`pause`；类型 `InteractionEvent`（`event.tileFeature()`：指针下的 3D Tiles 要素，§3.3）、`ListenerOptions`、`PauseScope`、`PickInfo` | 稳定 |
| `PickBuffer`（`viewer.pickBuffer`）、`GpuPick`、`PickTarget`、`PickBufferOptions` | GPU 拾取缓冲；改了签名看不到的东西后调用 `invalidate()`。拾取本身用 `viewer.pick` / `pickAt` | 高级 |
| `SurfaceHeight`、`SurfaceSample`、`SurfaceSource`、`SurfaceHeightOptions` | `viewer.surfaceHeight(lon, lat)` 的结果类型（地形或可见 3D Tiles 的高度，带可信度） | 稳定 |
| `getHeadingPitch`、`lookAtHeadingPitchRange`、`orientationFromHeadingPitch`、`cameraDirection` / `cameraUp` / `cameraRight` | 相机数学（弧度） | 高级 |

### 3.2 globe

| 导出 | 用途 | 级别 |
| --- | --- | --- |
| `ImageryProvider`、`XYZImageryProvider`、`EquirectangularImageryProvider`、`DebugImageryProvider` | 底图影像源；自定义源实现 `ImageryProvider` | 稳定 |
| `IMAGERY_PRESETS` / `findImageryPreset`、`OVERLAY_PRESETS` / `findOverlayPreset` | 内置底图与叠加层预设；显示名是 `label`（`LocalizedText`），见 §1.6 | 稳定 |
| `TerrainSource`、`AWS_TERRARIUM`、`mapboxTerrain`、`maptilerTerrain`、`cesiumIonTerrain`、`quantizedMeshFromLayerJson` | 地形源 | 稳定 |
| `RasterOverlay`、`OverlayCompositor`（`viewer.overlays`） | 半透明栅格叠加层：`addRaster` / `removeRaster` / `setOpacity` / `setVisible` / `move` / `rasterLayers`。地球调用的合成接口（`version`、`hasContent`、`isCurrent`、`requestOverlay`）是高级 | 稳定 |
| `Globe`（`viewer.globe`）、`GlobeOptions`、`GlobeStats` | 四叉树地球：`setImagery` / `setTerrain`、`imageryProvider` / `terrainSource` / `terrainExaggeration`、`onImageryError` / `imageryError` / `terrainError`（§1.6；稳定的做法是 `viewer.events` 的 `error`）、`stats`、`gpuBytes`、加载调参（`maxScreenSpaceError` 等）、`getHeight`（只看地形，弧度；贴地用 `viewer.surfaceHeight`）、调试（`setWireframe`、`freeze`）；[tile-loading.md](agents/tile-loading.md) | 高级 |
| `tileDebugUniforms`、`refreshTileMaterials` | 瓦片着色器的调试开关（页面上所有 viewer 共用） | 高级 |

### 3.3 3D Tiles

`Tiles3DLayer`（`viewer.addTileset(options)` 的返回值）：`visible`、`errorTarget`、`heightOffset`、`events`（`ready`、`error`、`change`：有瓦片加载完成，或设了 `visible` / `heightOffset`）、`ready` / `error`、`pending`（排队、下载、解析中的瓦片数）、`memory`。来源 `TilesetSource`：`url` / `ion` / `google`。预算见 [gpu-memory.md](agents/gpu-memory.md)。级别：稳定。

**要素拾取与属性**（`TileFeature`、`FeatureHighlightStyle`，稳定）：

```ts
viewer.interaction.on('click', (e) => {
  const f = e.tileFeature(); // 指针下的要素：{ layer, id, table, properties, point, object }，没有时为 null
  viewer.highlightTileFeature(f, { color: '#ffd23f', opacity: 0.5 }); // null 清除
});
const f = viewer.pickTileFeature(clientX, clientY); // 不在监听里时
```

| 项 | 说明 |
| --- | --- |
| 要素编号（`id`） | `EXT_mesh_features` 的要素编号属性（`_FEATURE_ID_n`）和隐式编号（顶点序号），b3dm 的 `_BATCHID`，i3dm 的实例序号。编号只在一块瓦片的内容里唯一。**要素编号纹理不读**：库读纹理要自建一个 WebGL 渲染器，3D Tiles 保持只用 WebGPU |
| 属性（`properties`、`table`） | `EXT_structural_metadata` 的属性表（`table` 是表名，没有名字时是类名），或 b3dm / i3dm 的批量表（`table: 'batch'`）；没有属性时为空对象、`table` 为 null。属性纹理、属性属性（property attributes）不读 |
| 代价 | `event.tileFeature()` 第一次调用时按该事件拾取时的相机发一条 CPU 射线，之后缓存；不调用就没有开销（悬停仍走 GPU 拾取缓冲）。WebGL 后端同样可用 |
| 高亮 | 把该要素的三角形复制一份、半透明叠在拾取到的瓦片网格上（默认 `#ffd23f`、50 %），不改瓦片材质。整页同时只高亮一个要素；那块瓦片被卸载或换成别的细节层级时高亮随之消失（`highlightedTileFeature` 变为 null），移除图层也会清除。点云（pnts）没有三角形，只能拾取不能高亮 |

实现与规则见 [tile-loading.md](agents/tile-loading.md) §7.1。

### 3.4 矢量

`GeoJsonLayer`（`viewer.addGeoJson`）、`GeoJsonLayerOptions`、`VectorStyle`、`LabelStyle`、`DEFAULT_VECTOR_STYLE`、`DEFAULT_LABEL_STYLE`、`FeatureHit`、`LayerSummary`；`lonLatToMerc` / `mercToLonLat`。级别：稳定。

### 3.5 顶牌与点位

| 导出 | 用途 | 级别 |
| --- | --- | --- |
| `MarkerManager`（`viewer.markers`）、`Marker`、`MarkerOptions` | HTML 顶牌：`add({ element, position, ... })`、`remove`；遮挡 `occlusion: 'none' \| 'hide' \| 'fade'` | 稳定 |
| `PointLayer`（`viewer.addPoints`）、`PointLayerOptions`、`ClusterOptions`、`MARKER_STYLES` | 点位图层：数据、样式规则、聚合 | 稳定 |
| `createCard`、`CardOptions` | 内置顶牌样式模板（自己拼顶牌时用） | 高级 |
| `parsePoints`、`resolvePointStyle`、`matchesRule`、`fillTemplate`、`pointsBBox`、`defaultTitle` | 点位解析与规则（纯函数，`PointLayer` 内部用的同一套） | 高级 |

格式与规则见 [markers.md](agents/markers.md)。

### 3.6 室内 / BIM

| 导出 | 用途 | 级别 |
| --- | --- | --- |
| `IndoorManager`（`viewer.indoor`） | `add(doc, baseUrl?)`、`remove`、`enter(entity)`、`back()`、`query(selector)`、`getById`、`events`（`beforeEnterLevel` / `enterLevel` / `leaveLevel`）、`registerLevelControl`；模型按需加载 `lazyModels`（默认 true）、预算 `modelBytesTarget` / `modelUnloadDelayMs`（按显存档位给）、读数 `modelBytes`，见 [indoor-bim.md](agents/indoor-bim.md) §5.4 | 稳定 |
| `Building`、`BuildingOptions`、`BimEntity`、`EntitySet` | 建筑（`modelsLoaded(entity)`：加载并等待该实体用到的模型，可用来预加载楼层；`modelBytes`）、实体（`setStyle`、`visible`、`levelOpacity`、`refreshTransform`）、查询结果的批量操作 | 稳定 |
| `parseBuildingDoc`、`BuildingDoc`、`FloorDef`、`RoomDef`、`ThingDef`、`StructureDef` 等 | `three-geo-building` 文档格式与校验；[building-data-manual.md](building-data-manual.md) | 稳定 |
| `compileSelector`、`SelectorError`、`matchesSelector`、`closestMatching` | 选择器 | 稳定 |
| `LevelControl`、`BUILTIN_LEVEL_CONTROLS`、`buildingLevelControl` 等 | 层级的显隐、半透明、取景策略，可替换 | 稳定 |
| `ContributionCuller`（`viewer.indoor.culling`）、`ContributionCullingOptions`、`DEFAULT_CULLING` | 贡献剔除，默认关闭：`enabled`、`configure`、`options`、`stats`、`invalidate` | 稳定 |

格式、层级事件和选择器语法见 [indoor-bim.md](agents/indoor-bim.md)。

### 3.7 大气与 core

| 导出 | 级别 |
| --- | --- |
| `CloudLayer`（`viewer.clouds`）、`CloudOptions`、`CLOUD_DEFAULTS` | 稳定 |
| `Ellipsoid`、`cartographic`、`WGS84_A` / `WGS84_B`、`geodeticToEcef`、`geodeticNormal`、`sunDirectionECEF` | 稳定 |
| `EventEmitter`；`DEG2RAD`、`RAD2DEG`、`clamp`、`formatDegrees`、`formatDistance` | 稳定 |
| `GpuTier`、`GpuProfile`、`TilesQuality`、`IndoorQuality`（`viewer.gpu`、`GeoViewerOptions.gpuTier` 的类型） | 稳定 |
| `gpuProfile`、`classifyGpu`、`parseGpuTier`、`GPU_TIERS`、`GpuHints` | 高级 |
| 语言与错误（§1.6）：`LocaleId`、`DEFAULT_LOCALE`、`MESSAGES`、`ViewerMessages`、`ViewerMessageOverrides`、`resolveMessages`、`LocalizedText`、`localize`；`TerraViewError`、`TerraViewErrorCode`、`TerraViewErrorDetails`、`isTerraViewError` | 稳定 |

### 3.8 内部（不再导出）

2026-11-13 从入口移除（CHANGELOG）：`FrameCrossfade`（类型仍经 `viewer.levelTransition` 可见）、`decodeImage`、`isQuantizedMesh`、`WebMercatorTilingScheme` / `MERCATOR_MAX_LATITUDE` / `GeoRect`、`greenwichMeanSiderealTime`、`geoidUndulation`（EGM96 网格只在瓦片 Worker 里用，不再进主入口）、聚合树（`buildClusterTree` / `clusterLeaves` / `ClusterSelector` / `ClusterTree*` / `ClusterView`）、`createClusterCard` / `setClusterCount`。

公开对象上的内部成员（不在类型声明里）：`viewer` 的 `stars`、`sunLight`、`skyLight`、`labels`、`vectors`、`markerOcclusion`、`backdrop`、`pickReferenceSurface`；`viewer.globe` 的 `group`、`scheme`、`surfaceSignature`、`setOverlaySource`、`update`、`releaseHidden`、`sampleHeight`、`raycast`、`dispose`；`viewer.indoor.culling` 的 `update`、`forget`；`Building` 的 `updateModels`、`unloadableModels`、`unloadFloorModel`，`BimEntity.releaseMeshes`；`Tiles3DLayer` 的 `highlighted`、`setHighlight`（用 `viewer.highlightTileFeature`）；`Marker` 的放置与测量方法。

## 4. 多个 viewer

同一页面可以创建多个 `GeoViewer`（各自的容器、相机、图层、事件），可以混用 WebGPU 和 WebGL 后端（`forceWebGL`）。

模块级的共享状态（2026-11-12 逐项核对）：

| 共享的东西 | 位置 | 为什么安全 |
| --- | --- | --- |
| 按域名的请求队列 | `globe/imagery/RequestScheduler` | 有意共享：浏览器的连接数本来就按页面算 |
| 瓦片着色器的节点图、占位纹理、形变位置节点 | `globe/TileMaterial` | 节点和纹理对象由每个渲染器各自编译、上传；从不释放，不会被某个 viewer 的 `dispose()` 带走 |
| `tileDebugUniforms` | `globe/TileMaterial` | 调试开关，有意让所有 viewer 一起变 |
| 大气 uniform（太阳方向、相机位置与高度、光照 / 大气开关） | `atmosphere/AtmosphereNodes` | 每个 viewer 渲染前重写全部值（帧内在 `updateEnvironment` 里；帧外的截图和层级切换截帧也先重写，见下） |
| 注记的相机 uniform 与节点 | `vector/LabelManager` | 同上，渲染前 `syncCamera` |
| 3D Tiles 渐显遮罩节点 | `tiles3d/nodeMaterials` | 只读节点图，逐材质参数走 `materialReference` |
| 设备的几何与材质池 | `indoor/StylePool`（`sharedStylePool`） | 按键共享、引用计数：最后一个使用者释放后才 `dispose` |
| 选择器编译缓存 | `indoor/selector` | 纯函数结果 |
| 点位聚合 Worker | `markers/PointLayer` | 引用计数，最后一个点位图层销毁时关闭 |
| EGM96 网格 | `core/Geoid` | 只读数据，首次使用时解码；只在瓦片 Worker 里用（每个 Worker 一份） |

实测（2026-11-12，Chrome，演示应用的 WebGPU viewer 旁边再建 viewer）：一个 WebGL viewer 与演示应用的 WebGPU viewer 同时加载同一栋建筑（共用样式池的材质），然后销毁；再轮流以 WebGPU / WebGL 创建 6 个 viewer，各加建筑和 300 个聚合点位、渲染后销毁。全程控制台无错误，演示应用的建筑照常渲染（材质没有被别的 viewer 的销毁释放），最后只剩一个 canvas。另外，反复创建、销毁 40 次的泄漏测试见路线图 §10.5：Worker、canvas、`tv-*` 节点、窗口 / 文档监听、rAF 都回到基线。

**新增模块级状态时**：先想清楚它该按 viewer 持有还是全局共享（AGENTS.md §3.10）；共享的写进上表。存放"当前相机""当前开关"这类按 viewer 不同的值的共享 uniform，必须在该 viewer 的每次渲染前重写，包括帧循环之外的渲染。

## 5. 还没有的东西

- 没有发布到 npm（`package.json` 里是 `private`）。许可证 Apache-2.0，见仓库根目录的 `LICENSE`。包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒；这一点只有真正发布时才能确认。被拒时改用带 scope 的 `@<scope>/terra-view`（scope 不受这条规则限制）。
- 显示文案只内置 `zh-CN` 和 `en` 两种语言（§1.6）；其他语言用 `messages` 逐项改写。
- 没有 CommonJS / UMD 产物，只有 ES 模块。
- 示例数据（`demo/data/`）和演示面板（`demo/ui/`）不随包发布。
