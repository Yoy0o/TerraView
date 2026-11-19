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
- `position` 是 `static` 时改成 `relative`（顶牌层相对容器定位）。
- 没有 `tabindex` 时设为 `-1`，用来接收键盘。

### 1.2 样式与主题

`terra-view/style.css` 只管 SDK 创建的元素，类名都以 `tv-` 开头：

| 类 | 元素 |
| --- | --- |
| `.tv-viewer` | 容器 |
| `.tv-canvas` | 渲染用的 canvas |
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

### 1.8 帧率、功耗与静止超采样

画面静止时也按显示器刷新率每帧渲染，开销不小：实测（RTX 40 系列独显、1920×1080）地球静止约占 0.4–0.6 个 CPU 核，建筑场景 0.8–1.3 个核，GPU 每秒忙 100–230 毫秒；集显笔记本、4K 和高刷新率屏幕更高。所以 viewer 默认在画面**安静 1 秒后**：

1. **静止超采样**（默认开）：接下来的十几帧把相机错开不到一个像素（Halton 序列）再画，逐帧平均，得到比 MSAA 更平滑的边缘、更稳的细线和纹理（有 MSAA 时 16 帧，没有时 32 帧，约 0.3–0.5 秒画完）；
2. **然后停止重画**，画面保持在超采样后的结果，直到有变化。这期间 viewer 仍按 `idleFrameRate`（默认每秒 10 次）更新状态、检查变化，但不画帧，GPU 基本空闲；
3. 有变化立刻恢复全帧率的实时画面，再安静 1 秒后重新超采样。

关掉超采样（`supersampling: false`）时，安静的画面按每秒 10 帧重画（原来的空闲降帧）。实测（RTX 40 系列笔记本独显、无头 Chrome、WebGPU、1920×1080，100% 为一个核）：地球静止时 CPU 由每秒 10 帧的 14% 降到 6.9%，建筑场景由 27% 降到 7.9%；每帧都画时分别约 40–57%、80–126%。

| 项 | 说明 |
| --- | --- |
| `GeoViewerOptions.idleFrameRate`、`viewer.idleFrameRate` | 安静时每秒更新几次，默认 10（关掉超采样时也就是每秒画几帧）。0 表示不降帧、每帧都画，**也不做静止超采样**（画面永远不算静止）；其他值限在 10–60（低于 10 时省电不稳定，按时间推进的运动也会变慢） |
| `GeoViewerOptions.supersampling`、`viewer.supersampling` | `true` / `false` 或 `{ enabled, samples }`。`enabled` 默认 true；`samples` 是一幅静止画面平均的帧数，4–64，默认有 MSAA 时 16、没有时 32（`low` 档或 `antialias: false`）。只读：`sampleCount`（屏幕上的画面已平均了几帧）、`converged`（已画完、不再重画）。改 `samples` 时屏幕上的画面接着补帧或直接保持；关掉时释放历史缓冲。类型 `Supersampling`、`SupersamplingOptions` |
| 什么算"有变化" | 相机运动（手势、飞行、动画、惯性、环绕，包括从代码发起的）；加载未完成（`loadState.idle` 为 false）；地球影像淡入、地形渐变、3D Tiles 细节层级淡入淡出、注记淡入淡出；层级切换、选中、悬停；图层增删；尺寸变化；场景开关（`lighting` 等）、`viewer.date` 改变、调色；`timeMultiplier` 不为 0、云层漂移、闪烁的描边（这几样一直在动，画面永远不静止）。从代码做的改动也算，在下一个动画帧（约 16 ms）就恢复：实体的 `setStyle` / `visible` / `levelOpacity` / `refreshTransform()`、建筑模型加载完成或卸载、`indoor.showLabels` / `expandFloors`、`clouds.set()`、3D Tiles 图层的 `visible` / `heightOffset`、GeoJSON 图层的 `visible` / `setStyle` / `setLabelStyle`、叠加图层（`viewer.overlays`）的增删和属性、点位图层的 `visible` / `setStyle` / `setCluster`、`viewer.effects` 与 `entity.effects`。另外每次更新都直接比较相机矩阵、画布尺寸、地球瓦片、色调映射和瓦片调试开关，绕过控制器改了相机也能发现 |
| 输入本身不算变化 | 容器上的指针、滚轮、键盘只让 viewer 按全帧率更新 1 秒（及时响应），不丢掉已超采样的画面：鼠标在静止画面上移动、点在空白处都不会让画面先变糙再变细。输入引起的变化（相机动了、悬停换了对象、选中）照常算变化 |
| 分几帧做完的工作 | 点位顶牌每帧最多建 200 个、顶牌放置：做完之前保持全帧率更新（它们是 DOM，不影响画面是否静止） |
| 云层 | 可见且在漂移时画面一直在变，不做超采样；按它在屏幕上的漂移速度决定帧率（每帧移动不超过约 1.5 px）：整球视角仍是 10 帧，离地 1500 km 左右约 30 帧，更低时每帧都画 |
| `viewer.requestRender()` | 立刻按实时画面重画，并保持全帧率至少 1 秒，之后重新超采样。经 SDK API 做的改动 viewer 都能发现（见上）；**绕过 SDK 直接改 three 对象时必须调用**，例如往 `viewer.scene` 加了对象、改了其中对象的位置或材质、直接改了 `renderer` 的设置：画面已静止时，不调用的话改动要等下一次别的变化才出现（关掉超采样时最多晚 100 ms） |
| 自己做动画的宿主 | 在 `viewer.scene` 里有自己逐帧变化的对象（风扇转动、自定义着色器动画）时，在自己的动画循环里每帧调用 `requestRender()`，或设 `idleFrameRate: 0` |
| 截图 | `captureFrame()`、`navigation.screenshot()` 在画面已超采样且之后没有变化时，直接输出超采样的画面（不重画场景）；否则画一帧实时画面 |
| 容器不可见 | 容器滚出视口或 `display: none` 时完全不画（`IntersectionObserver`），回到视口立刻恢复。这期间加载不推进，`idle` 事件也不会触发 |
| 统计 | `stats.throttled`：当前按安静帧率更新；`stats.still`：画面已超采样完、不再重画；`stats.samples`：屏幕上的画面平均了几帧（实时画面为 0）；`stats.fps` 是每秒实际画的帧数（静止时为 0）。`frame` 事件在每次更新后触发，静止时也按安静帧率触发（不画帧），`stats.still` 为 true |

标签页隐藏时浏览器本来就会停掉动画帧；动画帧停了 2 秒以上再恢复时（切回标签页、电脑唤醒），viewer 重画一次，不依赖画布还保留着之前的画面。

做法（[roadmap.md](agents/roadmap.md) §0.2"P3.3 落地"）：每个样本用 `camera.setViewOffset` 平移亚像素，场景和描边、发光的遮罩一起平移；色调映射和描边之后的画面按 1 / (n + 1) 的权重混合进一张半精度历史缓冲（结果就是前 n 帧的平均），再显示到画布。第一帧不平移，所以开始超采样时画面没有跳变。没有用 three 的 `TRAANode`：它的速度缓冲在 GPU 上用 float32 乘 ECEF 矩阵，地球尺度上误差达到米级，而且历史永远不收敛到简单平均。历史缓冲（画布大小 × 8 字节，1920×1080 约 16 MB）在第一次超采样时分配，计入 `viewer.memory.framebuffers`。

### 1.9 描边、发光、调色与后期处理

每帧都经过后期管线（`viewer.postProcessing`，路线图 M3.1）：场景先画进 viewer 自己的 HDR 渲染目标，再跑启用的效果，最后一个全屏 pass 做色调映射并输出到画布。没有效果启用时，它做的事和 three 的 `renderer.render` 自己做的一样（开了色调映射的渲染器本来就先画进 HDR 目标再全屏输出），没有额外开销。

描边和发光是两个内置效果，只在有对象用到时才运行：

| 项 | 说明 |
| --- | --- |
| `entity.effects` / `entity.setEffects({ outline, glow, glowColor })`、`EntitySet.setEffects` | 实体的描边样式名（`'select'` / `'hover'` / `'alarm'` 或自定义）和发光强度（0..1）。覆盖实体和它下面正在显示的内容（楼层连同房间、设备；合批设备只描它自己那一个实例）。`setEffects` 合并，字段给 `null` 清除 |
| `indoor.selectOutline` / `indoor.hoverOutline` | 选中、悬停用的描边样式（默认 `'select'` / `'hover'`，`null` 关闭；建筑悬停不描边）。选中期间顶替实体自己的描边，取消后还原。**原来的选中 / 悬停改的是自发光颜色，现在不改实体的材质和样式** |
| `viewer.effects.set(object, effects)` | 给加进 `viewer.scene` 的 three.js 对象设描边 / 发光（对象可见时才画，`null` 移除）；`get`、`clear`。只画普通网格（实例化网格按单个几何画） |
| `viewer.effects.defineOutline(name, { color, hiddenColor, fill, pulse })` | 定义或替换描边样式：边的颜色；被遮挡部分的颜色（透视显示，不给就只描可见部分）；可见表面的染色 0..1；闪烁周期（秒）。内置 `select`（蓝，透视，染色 0.18）、`hover`（浅蓝）、`alarm`（红，透视，1.2 s 闪烁），见 `BUILTIN_OUTLINES` |
| `viewer.effects.outlineWidth` | 描边宽度，CSS 像素，1–6（默认 2） |
| `viewer.effects.glowStrength` / `glowRadius` | 发光光晕的强度（默认 1）和扩散（0..1，默认 0.5）。发光颜色默认取描边样式的颜色，没有描边时为白色 |

**调色**（`viewer.colorGrading`，类 `ColorGrading`；创建时 `GeoViewerOptions.colorGrading`）：

| 项 | 说明 |
| --- | --- |
| `exposure` | 色调映射前的亮度倍数，0.1–4，默认 1（就是渲染器的 `toneMappingExposure`，不增加 pass） |
| `contrast` | 以中灰为中心的对比度，0–2，默认 1 |
| `saturation` | 饱和度，0（灰度）–2，默认 1 |
| `set(options)`、`reset()`、`options` | 改其中几项（超出范围的夹到范围内，无效值忽略）、回到中性、读当前值 |
| `COLOR_GRADING_PRESETS` | `neutral`（默认，不改画面）和 `vivid`（对比度 1.05、饱和度 1.1：大屏上影像和模型不发灰），如 `viewer.colorGrading.set(COLOR_GRADING_PRESETS.vivid)`。类型 `ColorGradingOptions` |

对比度和饱和度是一个 `display` 阶段的效果（名为 `grading`，在描边之前，所以描边颜色仍和给定的一致），只在其中一项不为 1 时运行，默认不增加开销；数值是 uniform，调节时不重编着色器。

**层级切换过渡**（`viewer.levelTransition`，高级）：进出建筑、切换楼层等会改变显示内容的层级切换，先在 GPU 上截下当前画面和深度，之后 `duration` 毫秒（默认 450，0 关闭）内把它按深度重投影到飞行中的相机、叠在新画面上溶解：消失的外壳、楼层留在原处淡去，地面不会出现错开的两层。`reproject = false` 时退回整屏溶解（不跟随相机）。它是 display 阶段的 `transition` 效果（调色之后、描边之前）；做法和代价见 [indoor-bim.md](agents/indoor-bim.md) §7.1，过渡期间的显存（1080p 约 31 MB，结束即释放）计入 `viewer.memory.framebuffers`。原来盖在画布上的 `.tv-crossfade` 元素已经去掉。

做法：被标记的网格单独再画一遍到小的遮罩里（与场景深度比较，分出可见和被遮挡的部分），描边在色调映射之后叠加（颜色和给定的一致），发光用 three 的 `BloomNode` 模糊遮罩后加到场景上。实体自己的材质不变，合批设备不拆批。闪烁的样式在用时让 viewer 保持全帧率（§1.8）。代价：有描边时每帧多一次只含被标记网格的绘制和一次全屏边缘搜索（高分屏上在半分辨率做）；有发光时再加遮罩和 bloom 的几个半分辨率 pass。显存计入 `viewer.memory.framebuffers`。

自定义效果（高级）：实现 `PostEffect`（`name`、`stage: 'linear' | 'display'`、`order`、`active`、`graphVersion`、`build(input, inputs)`，可选 `attachments`、`prepare(frame)`、`animating`、`gpuBytes`、`dispose`），用 `viewer.postProcessing.add(effect)` 注册。`linear` 效果在色调映射之前（光照类：泛光、AO、调色），`display` 效果在之后（描边、叠加层）；同一阶段按 `order` 从小到大。`attachments` 声明需要场景额外输出的 MRT 附件（如 `{ normal: normalView }`），只在该效果启用时写；节点图只在启用的效果、`graphVersion` 或色调映射变化时重建。静止超采样期间 `prepare(frame)` 拿到的 `frame.camera` 带着该样本的亚像素平移，效果自己的 pass 用它画就会和场景对齐（不要跨帧缓存它的矩阵）；会自己动的效果设 `animating`，画面就不会被当成静止。不要给场景材质设 `material.mrtNode`：带自己 MRT 的材质在任何渲染目标里都会替换输出（拾取缓冲也是）。

### 1.10 光照、空气透视与楼层环境光遮蔽

**光照跟随大气**（路线图 M3.5）：`viewer.lighting = true`（按 `viewer.date` 的真实太阳）时，照亮建筑、设备和 3D Tiles 的灯光来自地球用的同一个大气模型：

| 灯光 | 来源 |
| --- | --- |
| 太阳（平行光） | 颜色是视点处（进入建筑时取建筑锚点，否则取相机正下方的地面）的太阳透射率，强度 π：白色朝阳面反射出的颜色就是透射率，和地球瓦片的直射项一致。正午约 (0.94, 0.87, 0.77)，太阳高度 6° 时约 (0.57, 0.28, 0.09)，日落后为 0 |
| 天光（`LightProbe`，二阶球谐） | 上半球是单次散射的天空亮度，下半球是被太阳和天空照亮的地面（反照率 0.2）。正午朝上的面约得到 (0.07, 0.14, 0.27) × 反照率，竖直的墙因为有地面反光约 (0.16, 0.20, 0.26) |
| 夜间补光 | 半球光只在夜里保留一点（强度 0.25，白天为 0），室内仍看得清 |

太阳转过 0.1° 或视点移动 500 m 才重算一次（CPU 约 0.3–0.8 ms）。不开光照时（默认的地图模式）仍是相机上方的头灯加固定半球光，与原来相同。

**空气透视**：建筑（程序生成的和楼层、外壳、设备的 glTF）、合批设备、3D Tiles 的材质都带上了与地球瓦片相同的空气透视（大气模型沿视线积分，按 `viewer.atmosphere` 开关），城市尺度上远处的模型和周围地面一起变淡，不再比地面"更清楚"。它是共享的 `outputNode`（逐像素，100 m 以内跳过，所以室内没有开销）。视线最多积分到椭球面下 0.5 km（`AERIAL_GROUND_DEPTH_KM`）：远处 3D Tiles 的粗网格是平面拼成的，面片中部可以比椭球面低几十公里，积分到那里会把面片画成带彩色环的暗斑。宿主自己加进场景的模型不受影响。

**楼层环境光遮蔽**（路线图 M3.4，`viewer.indoor.ambientOcclusion`，类 `FloorOcclusion`；创建时 `GeoViewerOptions.ambientOcclusion`）：楼层地面沿墙根、柜体和桌子周围柔和变暗，墙面底部随高度淡出。默认开。

| 项 | 说明 |
| --- | --- |
| `enabled` | 开关。关掉时所有楼层去掉 AO 并释放贴图 |
| `configure({ intensity, radius, height, texelSize, maxResolution })` | `intensity` 完全遮挡处变暗多少，0..1（默认 0.6，立即生效，不重新烘焙）；`radius` 变暗的范围，米（默认 0.9）；`height` 离地多高以内的东西算遮挡物，米（默认 1.8）；`texelSize` 烘焙的目标纹素大小，米（默认 0.08）；`maxResolution` 贴图长边的纹素上限（默认按显存档位 512 / 1024 / 1024 / 2048）。只改给出的字段，超出范围的夹到范围内 |
| `options`、`bakedFloors`、`bytes`、`bakedFor(floor)` | 当前设置、已烘焙的楼层数、贴图字节数（也计入 `viewer.memory.buildings`）、某层的烘焙结果（`BakedOcclusion`：`texture`、`grid`、`bytes`） |

楼层**第一次显示时**烘焙一次（GPU 上画一张俯视遮挡图再做两次可分离滤波，主线程 3–7 ms，结果读回成一张单通道贴图），之后只是材质里多采样一次贴图，不增加每帧的 pass；楼层模型加载 / 卸载、楼层上的设备显隐或移动（`entity.visible`、`refreshTransform()`）之后，改动稳定 250 ms 再重新烘焙。做法、哪些网格接收和投射见 [indoor-bim.md](agents/indoor-bim.md) §5.6。

### 1.11 局部场景（沙盘）

`viewer.localScene` 只显示地球上的一块区域（园区到城区，直径不超过 100 km）：区域内的地形、影像、贴地矢量和 3D Tiles 照常分级加载，区域外不绘制、不加载；边缘一圈土层侧壁，背景换成展台天空，相机围着区域活动。它是地球场景的子模式，与建筑层级独立。规范见 [local-scene.md](agents/local-scene.md)。

```ts
await viewer.localScene.enter({ region: { type: 'circle', center: [116.39, 39.91], radius: 3000 } });
viewer.localScene.enter({ region: { type: 'rectangle', west: 7.96, south: 46.55, east: 8.07, north: 46.62 }, walls: false });
viewer.localScene.enter({ region: { type: 'tileset', layer }, globe: 'hide' }); // 只看一个倾斜摄影数据集
await viewer.localScene.exit(); // 默认飞回进入前的视点
```

| 项 | 说明 |
| --- | --- |
| `enter(options)` | 进入或换区域（再次调用即换区域、改选项）；飞行和区域外淡出都完成时 resolve。区域不合法时同步抛 `option-invalid`（`details.option = 'region'`），状态不变 |
| `region` | 圆（`center` 度、`radius` 米，20 m–50 km）、矩形（`west / south / east / north` 度）、多边形（`coordinates` 度，单环、不自交，超过 64 个顶点自动抽稀）或 `{ type: 'tileset', layer }`（图层包围盒在地面的投影）。不能跨反子午线，|纬度| ≤ 84° |
| `outside` | `'hide'`（默认）不画不加载；`'dim'` 压暗去饱和，照常显示和加载（后期效果，不裁剪、无侧壁） |
| `walls` | 默认 `true`（沙盘侧壁）；`false` 为悬浮地块（隐形侧壁，裁口露出背景）；对象 `{ depth, color, edge }`：底面在边界最低点以下多深（米，默认区域直径的 2%，30–1000）、土色、顶边亮线 |
| `background` | `'studio'`（默认）、`'space'`（保留星空和大气）或颜色 |
| `globe` | `'clip'`（默认）；`'hide'` 在局部场景期间隐藏地球（数据自带地面时用，退出时恢复） |
| `camera` | `fit`（进入时飞到总览，默认 true）、`heading` / `pitch`（度，默认当前航向、-35）、`constrain`（活动范围，默认 true）、`margin`（视线可越出区域的距离，占半径的比例，默认 0.25）、`maxRangeScale`（最远距离 = 总览距离 × 它，默认 2） |
| `transition` | 区域外淡出 / 淡入的秒数（默认 0.8，0 立即） |
| `exit({ restoreView })` | 退出；`restoreView: false` 留在原地 |
| `fit(duration?)`、`set(options)`、`contains(lon, lat)`、`active`、`region`（`ResolvedRegion`）、`events`（`enter`、`exit`） | 回到总览；只改外观 / 相机 / 过渡；判断位置（度）；状态；事件 |

局部场景中：拾取（含拾取缓冲）、`surfaceHeight`、防入地在区域外分别落空、返回侧壁底面高度；锚点在区域外的顶牌、注记、建筑隐藏；双击区域外回到总览（`interaction` 上 `tag: 'local-scene'`），`navigation.home()` 回到总览；云层隐藏。相机的活动范围是通用的 `controller.bounds`（`CameraBounds`，高级），不开局部场景也能用。

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
| `ViewerEffects`（`viewer.effects`）、`ObjectEffects`、`OutlineStyle`、`BUILTIN_OUTLINES` | 三维对象的描边与发光、描边样式、宽度与光晕（§1.9） | 稳定 |
| `ColorGrading`（`viewer.colorGrading`）、`ColorGradingOptions`、`COLOR_GRADING_PRESETS` | 曝光、对比度、饱和度（§1.9） | 稳定 |
| `Supersampling`（`viewer.supersampling`）、`SupersamplingOptions` | 静止超采样：开关、样本数、`sampleCount` / `converged`（§1.8） | 稳定 |
| `PostPipeline`（`viewer.postProcessing`）、`PostEffect`、`PostFrame`、`PostInputs`、`PostStage` | 后期管线与自定义效果（§1.9） | 高级 |
| `viewer.levelTransition` | 层级切换过渡：上一帧按深度重投影、随相机飞行溶解（`duration` 毫秒，0 关闭；`reproject`，§1.9）；类型 `LevelTransition` 不从入口导出 | 高级 |
| `GeoViewerOptions`、`ViewPosition`、`TargetView`、`SphereFlightOptions`、`SurfacePick`、`FeaturePick` | 创建参数、视点与拾取结果类型 | 稳定 |
| `viewer.events`（`ViewerEvents`） | 帧统计、图层增删、点位单击，加载失败 `error`（`ViewerError`、`ViewerErrorSource`，§1.6）、加载进度 `load-progress` 与 `idle`（§1.7） | 稳定 |
| `viewer.loadState`（`LoadState`） | 还有什么在加载（§1.7） | 稳定 |
| `viewer.info`（`RendererInfo`）、`viewer.stats`（`FrameStats`；绘制数和三角形数只算场景 pass，不含后期和拾取）、`viewer.memory`（`MemoryReport`，`buildings` 含建筑模型和楼层 AO 贴图）、`viewer.gpu`（`GpuProfile`）、`viewer.locale`、`viewer.messages` | 后端与适配器、帧耗时、显存估算、档位预算、语言与文案 | 稳定 |
| `viewer.canvas` | 渲染用的 canvas | 稳定 |
| `viewer.snapshot()`、`ViewerSnapshot` | 诊断快照：后端、帧统计、显存、加载状态、视点、地球、3D Tiles、室内（AO、剔除）、后期效果、灯光，纯 JSON 值（路线图 M5.1） | 高级 |
| `viewer.idleFrameRate`、`viewer.requestRender()`、`stats.throttled` / `still` / `samples` | 安静时降帧、静止后停画与唤醒（§1.8） | 稳定 |
| `GlobeCameraController`（`viewer.controller`） | 手势开关（`enablePan` / `enableRotate` / `enableTilt` / `enableZoom` / `enableKeyboard`）、`zoomBy` / `orbitBy`、`playAnimation`、环绕巡航；[camera-controller.md](agents/camera-controller.md) | 稳定 |
| `LocalScene`（`viewer.localScene`）、`LocalSceneOptions`、`LocalSceneRegion`、`LocalSceneWallOptions`、`LocalSceneCameraOptions`、`LocalSceneEvents`、`LocalRegion`、`ResolvedRegion`、`MAX_REGION_DIAMETER` / `MAX_REGION_VERTICES` / `MIN_REGION_RADIUS` | 局部场景（沙盘）：只显示一块区域、侧壁、展台背景、相机范围（§1.11） | 稳定 |
| `CameraBounds`（`viewer.controller.bounds`） | 相机活动范围：视线不离开区域、最远距离、落空时的枢轴与参考地面；[camera-controller.md](agents/camera-controller.md) §3.6 | 高级 |
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

`Tiles3DLayer`（`viewer.addTileset(options)` 的返回值）：`visible`、`errorTarget`、`heightOffset`、`events`（`ready`、`error`、`change`：有瓦片加载完成，或设了 `visible` / `heightOffset`；`moved`：设了 `heightOffset`）、`ready` / `error`、`pending`（排队、下载、解析中的瓦片数）、`memory`。来源 `TilesetSource`：`url` / `ion` / `google`。预算见 [gpu-memory.md](agents/gpu-memory.md)。级别：稳定。

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
| `IndoorManager`（`viewer.indoor`） | `add(doc, baseUrl?)`、`remove`、`enter(entity)`、`back()`、`query(selector)`、`getById`、`events`（`beforeEnterLevel` / `enterLevel` / `leaveLevel`）、`registerLevelControl`；模型按需加载 `lazyModels`（默认 true）、预算 `modelBytesTarget` / `modelUnloadDelayMs`（按显存档位给）、读数 `modelBytes`，见 [indoor-bim.md](agents/indoor-bim.md) §5.4；选中 / 悬停的描边样式 `selectOutline` / `hoverOutline`（§1.9） | 稳定 |
| `Building`、`BuildingOptions`、`BimEntity`、`EntitySet` | 建筑（`modelsLoaded(entity)`：加载并等待该实体用到的模型，可用来预加载楼层；`modelBytes`）、实体（`setStyle`、`effects` / `setEffects`（§1.9）、`visible`、`levelOpacity`、`refreshTransform`）、查询结果的批量操作（`setStyle`、`setEffects`、`visible`） | 稳定 |
| `parseBuildingDoc`、`BuildingDoc`、`FloorDef`、`RoomDef`、`ThingDef`、`StructureDef` 等 | `three-geo-building` 文档格式与校验；[building-data-manual.md](building-data-manual.md) | 稳定 |
| `compileSelector`、`SelectorError`、`matchesSelector`、`closestMatching` | 选择器 | 稳定 |
| `LevelControl`、`BUILTIN_LEVEL_CONTROLS`、`buildingLevelControl` 等 | 层级的显隐、半透明、取景策略，可替换 | 稳定 |
| `ContributionCuller`（`viewer.indoor.culling`）、`ContributionCullingOptions`、`DEFAULT_CULLING` | 贡献剔除，默认关闭：`enabled`、`configure`、`options`、`stats`、`invalidate` | 稳定 |
| `FloorOcclusion`（`viewer.indoor.ambientOcclusion`）、`FloorOcclusionOptions`、`FLOOR_OCCLUSION_DEFAULTS`、`BakedOcclusion`、`OcclusionGrid` | 楼层环境光遮蔽，默认开：`enabled`、`configure`、`options`、`bakedFloors`、`bytes`、`bakedFor`（§1.10）。`Building.contentVersion(floor)`：楼层上内容的版本号，变了就重新烘焙 | 稳定 |

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

2026-11-13 从入口移除（CHANGELOG）：`FrameCrossfade`（2026-11-18 起由 `LevelTransition` 取代，类型经 `viewer.levelTransition` 可见）、`decodeImage`、`isQuantizedMesh`、`WebMercatorTilingScheme` / `MERCATOR_MAX_LATITUDE` / `GeoRect`、`greenwichMeanSiderealTime`、`geoidUndulation`（EGM96 网格只在瓦片 Worker 里用，不再进主入口）、聚合树（`buildClusterTree` / `clusterLeaves` / `ClusterSelector` / `ClusterTree*` / `ClusterView`）、`createClusterCard` / `setClusterCount`。

公开对象上的内部成员（不在类型声明里）：`viewer` 的 `stars`、`sunLight`、`skyLight`、`skyProbe`、`labels`、`vectors`、`markerOcclusion`、`backdrop`、`pickReferenceSurface`；`viewer.globe` 的 `group`、`scheme`、`surfaceSignature`、`setOverlaySource`、`update`、`releaseHidden`、`sampleHeight`、`raycast`、`dispose`；`viewer.indoor.culling` 的 `update`、`forget`；`viewer.indoor.ambientOcclusion` 的 `update`、`pending`、`forget`、`dispose`；`Building` 的 `updateModels`、`unloadableModels`、`unloadFloorModel`、`floorContentChanged`，`BimEntity` 的 `releaseMeshes`、`highlight`、`resolvedEffects`、`collectDrawables`、`onEffects`；`viewer.indoor.markedEntities`；`Tiles3DLayer` 的 `highlighted`、`setHighlight`（用 `viewer.highlightTileFeature`）；`Marker` 的放置与测量方法。

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
| 空气透视的 `outputNode` | `atmosphere/AtmosphereNodes`（`aerialPerspectiveOutputNode`） | 只读节点图，读的是上面的大气 uniform（渲染前按 viewer 重写） |
| 楼层 AO 的 `colorNode` | `indoor/FloorOcclusion` | 只读节点图；贴图、范围、强度是材质属性，楼层坐标是逐对象 uniform（取自网格的 `userData`），都不跨 viewer |
| 局部场景的裁剪遮罩节点、瓦片裁剪基础材质 `GlobeTileClipped`、3D Tiles 的遮罩组合节点 | `local/regionMask`、`globe/TileMaterial`、`tiles3d/nodeMaterials` | 区域参数按渲染器存（`setRegionGpuState`，WeakMap），节点在每次渲染 / 每次绘制时读当前渲染器的状态，没开局部场景的 viewer 遮罩恒为真；不需要渲染前重写。地球瓦片只有跨区域边界时才用裁剪材质，别的 viewer 的瓦片不受影响 |
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
