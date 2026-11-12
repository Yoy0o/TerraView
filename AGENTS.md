# AGENTS.md：TerraView 开发规范

本文面向在本仓库工作的 AI 编码代理和开发者，改代码前请先读。涉及具体子系统时，再读 `docs/agents/` 下对应的专题文档：

> 本仓库由 three-geo-global 迁移而来（2026-11-11，源提交 `be3bbbd`），从演示应用改成了可复用的 SDK：`src/` 是包的源码，`demo/` 是建在公共入口上的演示应用。迁移对应关系见 §8。

| 专题 | 文档 |
| --- | --- |
| 公共 API、接入方式、样式类名与主题变量（改导出、类名、容器行为前先看） | [docs/api.md](docs/api.md) |
| 相机控制器（手势、不变量、数学） | [docs/agents/camera-controller.md](docs/agents/camera-controller.md) |
| 瓦片加载（底图 / 地形 / 3D Tiles） | [docs/agents/tile-loading.md](docs/agents/tile-loading.md) |
| 室内与 BIM 模型定义、层级导航 | [docs/agents/indoor-bim.md](docs/agents/indoor-bim.md) |
| 建筑数据制作手册（面向数据人员：坐标、字段、类别、模型、自检） | [docs/building-data-manual.md](docs/building-data-manual.md) |
| 顶牌样式与点位标注（数据格式、样式规则、聚合） | [docs/agents/markers.md](docs/agents/markers.md) |
| 开场动画、云层、基础导航控制（核心 API 与 UI 分离、URL 参数） | [docs/agents/intro-and-navigation.md](docs/agents/intro-and-navigation.md) |
| 显存盘点、硬件档位与配置建议、3D Tiles 显存 / 缓存预算（新增占显存的功能前先看） | [docs/agents/gpu-memory.md](docs/agents/gpu-memory.md) |
| 可借鉴与复用路线图（分阶段落地计划，开始新功能前先看） | [docs/agents/roadmap.md](docs/agents/roadmap.md) |
| 改造记录与计划（时间线、Hub 任务对应、待办清单；每个任务合并后更新） | [docs/agents/progress-log.md](docs/agents/progress-log.md) |
| ThingJS 示例分析与能力对照（本地资料，不入库） | `temp/thingjs/thingjs-reference.md` |
| ThingJS 运行时源码分析、可借鉴的实现与落地清单（改层级、拾取、事件、样式前先看；本地资料，不入库） | `temp/thingjs/thingjs-runtime-analysis.md` |

`temp/` 存放本地参考资料和草稿，已在 `.gitignore` 中忽略，不要提交；需要入库的结论整理进 `docs/agents/`。

## 1. 项目速览

基于 three.js 的 WebGPU 优先三维地球 SDK（npm 包 `terra-view`，目前私有、未发布）：WGS84 椭球、四叉树影像与地形、物理大气、OGC 3D Tiles、GeoJSON 矢量与注记、HTML 顶牌、统一拾取事件，以及从地球无缝进入建筑、楼层、房间的室内 / BIM 浏览。宿主应用提供一个容器元素，通过 `GeoViewer` 使用全部能力。

- 技术栈：three r187（0.187.0，`WebGPURenderer` + TSL）、3d-tiles-renderer 0.5.4、TypeScript 5.9（strict）、Vite 8、Vitest 5。依赖版本是锁定的，不要随意升级；升级要先征得同意，并同时更新 `package-lock.json`（本仓库用 npm 安装）。`three` 和 `3d-tiles-renderer` 是 peer 依赖（开发时也装在 devDependencies 里），不打进产物。
- 命令：

  ```bash
  npm run dev         # 演示应用 http://localhost:5173（开发服务器可能已经在跑，先查端口占用，不要杀用户的进程）
  npm run typecheck   # tsc --noEmit（src、demo、tests）
  npm test            # vitest，纯数学与数据逻辑
  npm run build       # 类型检查 + 库构建（dist/terraview.js、terraview.css、assets/*.worker.js）+ 类型声明（dist/types）
  npm run build:demo  # 演示应用的生产构建（dist-demo/）
  npm run verify      # 以上全部，提交前跑
  npm run check:package  # 打包并装进一个临时宿主工程（scripts/host-fixture）检查，需要联网；先 build
  ```

- 两份 Vite 配置：`vite.config.ts` 是库构建和 Vitest，`vite.demo.config.ts` 是演示应用（把 `terra-view` 解析到 `src/index.ts`）。

- 演示应用的 URL 参数：`?webgl` `?imagery=osm` `?noterrain` `?tileset=<url>` `?geojson=<url>` `?points=<url>`（点位标注）`?demo`（示例办公楼）`?building=<url>`，开场动画 `?intro=0|1` `?introDuration` `?introSpeed`，云层 `?clouds=0|1` `?cloudCoverage` `?cloudSpeed` `?cloudTexture=<url>` 等（见 intro-and-navigation.md §5），贡献剔除 `?cull=1` `?cullThreshold` `?cullHysteresis` `?cullInterval` `?cullSelector`（见 indoor-bim.md §5.3），显存档位 `?gpu=low|medium|high|ultra`（见 gpu-memory.md），以及 `#lon,lat,height,heading,pitch`。
- 调试入口：演示应用里，浏览器控制台的 `window.viewer` 就是 `GeoViewer` 实例。

## 2. 目录与职责

```
src/            SDK 源码，打成 npm 包；不能依赖 demo/
├─ index.ts     包入口：公共 API 只从这里导出（§3.10）
├─ style.css    SDK 样式，发布为 `terra-view/style.css`，类名前缀 `tv-`
├─ core/        椭球（Ellipsoid）、测地学（geodesy，Worker 可用、无 three 依赖）、EGM96、太阳位置、EventEmitter、
│               gpuProfile（显存档位、预算表、帧缓冲估算，纯函数）
├─ globe/       四叉树地球：Globe（调度）、GlobeTile（状态）、tileSelection（选择规则纯函数）、
│               tileMeshLayout（网格索引布局，Worker 与象限填充共用）、TileMaterial（TSL）、Worker 构网、影像源、地形源
│  └─ terrain/  地形源描述、quantized-mesh 解码、terrainTiling（主线程与 Worker 共用的分块 / 插值规则）
├─ atmosphere/  大气散射 TSL 节点、星空、云层（CloudLayer）
├─ tiles3d/     3D Tiles 图层（含档位预算）；nodeMaterials（节点材质转换 + WebGPU 渐显 + 纹理过滤策略）；
│               lodPolicy（远处放宽、缓存满时自适应降精度，纯函数）
├─ vector/      GeoJSON 图层、矢量 Worker、注记（LabelManager）
├─ indoor/      BIM / 室内：schema（文档格式）、selector（选择器编译，纯函数）、BimEntity（实体、样式、标签）、
│               EntitySet（查询结果与批量操作）、Building（构建与定位）、InstanceBatch（设备合批，InstancedMesh）、
│               StylePool（几何 / 材质按键共享 + 引用计数）、ContributionCulling（贡献剔除，默认关闭）、LevelControl（层级控制策略）、
│               levelView（取景数学）、IndoorManager（层级路径切换、视点缓存、拾取、顶牌）
├─ markers/     MarkerManager（HTML 顶牌：投影、裁剪、避让、遮挡）、occlusion（遮挡代理池与规则，纯逻辑）、cards（顶牌样式模板）、
│               points（点位解析 / 规则，纯函数）、clusterTree（层级聚合树，纯函数 + Worker）、
│               PointLayer（点位图层）
└─ viewer/      GeoViewer（总装、拾取、帧循环）、GlobeCameraController、cameraMath、CameraFlight（弧线 / 注视飞行）、
                NavigationControls（导航命令，无 UI）、IntroAnimation（开场自转）、
                FrameCrossfade（层级切换淡出）、IndoorBackdrop（无地表时的展台背景）、
                InteractionManager（click / dblclick / rightclick / hover + 选择器、标签、优先级、once、停止传播、暂停、顶牌事件代理）、
                PickBuffer（GPU 拾取缓冲）、pickMath（八面体法线、深度反投影，纯函数）、
                OcclusionProxies（顶牌遮挡查询代理）
demo/           演示应用，不进包；只通过 `terra-view` 入口使用 SDK
├─ main.ts      启动、URL 参数、hash 同步、Esc 返回、文件拖放
├─ style.css    演示界面的样式（面板、状态栏等）
├─ ui/          面板（ControlPanel / IndoorPanel / VectorPanel / PointPanel / OverlayPanel）、状态栏、属性弹窗、层级条、
│               导航按钮条（NavigationBar）、URL 参数解析（urlOptions）、本机设置（settings）
└─ data/        示例数据：demoBuilding（示例办公楼）、demoPoints（示例点位）
tests/          vitest：geo / camera / keyboard / flight / navigation / terrain / tileSelection / tileMeshLayout / requestScheduler / vector / points / clusterTree / occlusion / selector / indoor / batching / backdrop / pickBuffer / interaction / surfaceHeight / intro / clouds / culling / gpuProfile
docs/api.md     公共 API 与接入说明
docs/agents/    子系统规范（本文档的展开）
```

## 3. 全局约定（必须遵守）

### 3.1 坐标与单位

- 世界坐标就是 ECEF，单位米，+Z 指向北极。内部角度一律用弧度；对外 API（`ViewPosition`、`TargetView`、BIM 文档、UI 显示）用度，字段名或注释必须写明单位。
- 高度一律指 WGS84 椭球高。海拔类地形在 Worker 里用 EGM96 改正，quantized-mesh 和 3D Tiles 本身就是椭球高。
- 局部坐标系：`Ellipsoid.eastNorthUp` / `eastNorthUpToFixedFrame` 给出 ENU。建筑本地坐标为 X 东、Y 北、Z 上，再按 `heading`（自北顺时针，度）绕 Z 轴旋转。glTF 规定 Y 轴朝上，加载时要转成 Z 轴朝上。
- `Ellipsoid.geodeticSurfaceNormal` 只适用于椭球面上的点。离地点（相机、高空锚点）必须用 `geodeticNormal`；`eastNorthUp` 内部已经这样处理。

### 3.2 精度

- `renderer.highPrecision = true` 不能关：模型视图矩阵在 CPU 上以 float64 计算。
- 每个网格自带原点（RTC，`mesh.position` = 瓦片中心或建筑锚点）。不要把 ECEF 绝对坐标写进 float32 顶点。屏幕空间标签用高低位拆分（RTE），见 `LabelManager.splitDouble`。

### 3.3 渲染（WebGPU 优先）

- 着色器只用 TSL 写，同一份代码编译成 WGSL 和 GLSL。禁止用 `onBeforeCompile` 或 GLSL 字符串注入，它们在 WebGPU 下静默失效（3D Tiles 官方渐显插件就是这个原因不工作）。
- 共享节点实例才能共享管线：同类材质指向同一个节点图，逐对象参数用 `materialReference('prop', type)` 读材质属性（参见 `TileMaterial`、`fadeMaskNode`）。
- 纹理采样放在统一控制流里，不要写在依赖逐片元数据的分支中。
- 需要 `discard` 的效果只在需要时挂上（例如 `maskNode` 仅在渐变期间存在），稳态保留 early-Z。

### 3.4 相机

- 相机永远零 roll（地平线保持水平）。
- 航向 / 俯仰只能通过 `cameraMath.getHeadingPitch` 计算。禁止用"视线的水平分量"求航向：俯视时这个分量趋近于零，航向会跳变 180°，画面上下翻转。
- 手势必须满足 [camera-controller.md](docs/agents/camera-controller.md) 中的不变量：缩放保持航向和俯仰、光标处的点不漂移、环绕不越过枢轴头顶、只依据可靠地形防入地。

### 3.5 数据加载

- 地球瓦片的几何、影像、叠加层是三个独立通道，各有优先级桶和并发上限；新数据源要接入这套机制，不要自己 `fetch` 后同步上传。规则见 [tile-loading.md](docs/agents/tile-loading.md)。
- 完成的加载进入上传队列，按每帧预算应用；在应用之前它一直占着并发槽位（形成背压）。
- 3D Tiles 的材质替换必须在插件的 `processTileModel` 钩子里做：库在这个钩子之后才登记要释放的材质，晚于它替换会泄漏显存。

### 3.6 Worker

- 解码、构网、栅格化都放在 Worker 里。Worker 代码不能 import three（会拖进几百 KB），只能用 `core/geodesy`、`globe/terrain/*` 这类无依赖模块。
- 大缓冲区用 transferable 传递。主线程和 Worker 共用的规则（例如地形用哪一级数据）只写一份，放在无依赖模块中。

### 3.7 交互与事件

- 点击、双击、右键单击、悬停一律走 `viewer.interaction`（`on(type, handler, { selector, tag, priority, once })`）。不要在 canvas 上自己注册 pointer 监听来判断点击。
- 监听按优先级（大者先）、再按选择器匹配到的实体由深到浅（冒泡）、再按注册顺序执行。`event.stopPropagation()` 阻止低优先级和祖先上的监听，`stopImmediatePropagation()` 阻止其余全部。
- 默认行为可以被 `event.preventDefault()` 阻止，例如双击进入层级时取消相机的"双击飞近"。
- 临时屏蔽交互（弹窗打开时等）用 `viewer.interaction.pause({ type, tag, selector, blockDefault })`，保存返回的函数用来恢复；不要注销再重新注册内置监听，也不要用 `enabled = false`（它不挡相机默认行为）。暂停只让监听不触发，要连相机双击飞近一起挡住就加 `blockDefault: true`。
- 拾取：交互事件（单击、双击、悬停）经 `viewer.pickAt` 先查 GPU 拾取缓冲（`viewer.pickBuffer`，WebGPU），缓冲与当前相机、场景签名不一致时自动退回 CPU 射线，调用方不用区分。新增拾取需求走 `viewer.pick(ndc, { buffer: true })` / `pickAt`，不要自己对整个场景做射线；改了签名看不到的东西（直接改对象变换、显隐而绘制数不变）要调用 `viewer.pickBuffer?.invalidate()`。相机手势仍用射线（`host.pick`）。实体映射统一用 `indoor.entityForHit(object, instanceId)`。见 roadmap.md M2.1。
- HTML 顶牌盖在 canvas 上方，会截获事件。实体顶牌带上 `userData.entity` 即可：单击、双击、右键单击经 `MarkerManager.eventProxy` 转成 `viewer.interaction` 上对该实体的事件（`event.marker` 指向顶牌）。与实体无关的顶牌（点位、聚合）自己提供 `onClick` / `onDoubleClick`。滚轮已由 `MarkerManager` 转发给 canvas。

### 3.8 代码风格

- TypeScript strict，开启 `noUnused*`。`any` 只允许出现在第三方库边界，并且要加 `eslint-disable-next-line` 注释。
- 每个模块文件开头写清职责。导出的 API 写 JSDoc；注释解释"为什么"，不复述代码。
- 公共 API 的单位、坐标系、取值范围必须写在类型或注释里。
- 演示应用的 UI 文案用中文；DOM 用 `demo/ui/dom.ts` 的 `h()`；样式复用 `demo/style.css` 里的 CSS 变量。SDK（`src/`）里不要新增写死的界面文案，做成选项。

### 3.9 数据与合规

- 访问凭证（天地图、ion、Google、Mapbox）由宿主作为参数传入；演示应用把它们保存在本机 localStorage。凭证不能写进仓库，也不能内置进包。
- 示例国界数据不是审定地图，在国内发布必须使用有审图号的数据。示例数据放在 `demo/`，不随包发布。
- 许可证 Apache-2.0（`LICENSE`、`package.json` 的 `license` 字段；包仍是 `private`，未发布）。移植来的代码保留版权声明，见 `THIRD_PARTY_NOTICES.md`；引入新的第三方代码前先确认其许可与 Apache-2.0 兼容。

### 3.10 SDK 边界（包与演示分离）

- `src/` 不能 import `demo/`；`demo/` 只能从 `terra-view`（`src/index.ts`）和 `terra-view/style.css` 引用 SDK，不要用相对路径伸进 `src/`。演示应用需要的东西没有导出，就说明公共 API 缺了一块：补到 `src/index.ts`，并同步 [docs/api.md](docs/api.md)。
- 新增、改名、删除导出都是公共 API 变更：同步 `docs/api.md`，记入 CHANGELOG。0.x 阶段次版本号可以有破坏性变更。
- 不要在 `src/` 里读 URL 参数、`localStorage`、`location`，也不要在 `window` / `document` 上注册全局监听（键盘读 viewer 容器，见 camera-controller.md）。这些属于应用。
- SDK 创建的 DOM 元素，类名一律以 `tv-` 开头，样式写在 `src/style.css`；可调的外观做成 `--tv-*` 变量并带默认值（`var(--tv-x, 默认值)`），不要依赖宿主页面的变量或全局样式。定位相对 viewer 容器，不要用 `position: fixed`。
- 对容器元素的改动（类、定位、`tabindex`）集中在 `GeoViewer.adoptContainer`，并在 `dispose()` 里恢复。
- `three`、`3d-tiles-renderer` 及其子路径在库构建里是 external。新增运行时依赖要先征得同意，并决定它是打进包还是做成 peer 依赖。
- Worker 一律用 `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`，库构建会把它们输出成独立文件；模块级共享的 Worker 要在最后一个使用者销毁时关闭。
- 模块级的可变状态（共享节点、uniform、队列）会被同页的多个 viewer 共用：新增前想清楚它该按 viewer 持有还是全局共享，共享的写进 `docs/api.md` §4。

## 4. 子系统要点

- **地球 Globe**：屏幕空间误差驱动的四叉树。
  - 瓦片有网格即可渲染；影像不足时用祖先影像放大顶替，新影像到达后交叉淡入。
  - 子瓦片可以先用精确祖先的高度插值出临时网格，最多跨 3 级。地形取数比网格层级低 3 级（一张 256 px 地形图服务 8×8 个网格瓦片，不损失精度）。
  - 选择规则借鉴 CesiumJS：每块瓦片记住上一帧的选择结果。缩小时，父瓦片要等自身影像和地形不比子孙差才替换它们（不丢细节守卫）。新进入视野、还没有网格的子瓦片，由父瓦片的对应象限暂时顶替（象限填充）。
  - 规则写在 `tileSelection.ts`，详见 tile-loading.md §2。
- **3D Tiles**：`NodeMaterialPlugin` 把材质转为节点材质；`TilesFadePlugin` 的材质管理器换成 `NodeFadeMaterialManager`（TSL dither 遮罩）；显存目标、解码缓存上限、纹理过滤按显存档位给（`viewer.gpu.tiles`），隐藏瓦片在显存目标内保留、过了延时才释放；斜视时远处瓦片放宽误差，缓存满时整体降精度而不是局部停止加载（[gpu-memory.md](docs/agents/gpu-memory.md) §5）。图层的 `errorTarget` 改 `layer.errorTarget`，不要直接写 `layer.tiles.errorTarget`（每帧会被覆盖）。
- **相机**：左键抓地平移；右键横向调航向、纵向调俯仰（默认绕屏幕中心点）；滚轮缩放到光标并保持航向和俯仰；另有环绕巡航、俯仰范围、各类开关、双击钩子。
- **室内 / BIM**：层级为 地球 → 建筑 → 楼层 → 房间 / 设备。双击进入，右键单击或 Esc 返回，单击选中，悬停高亮。
  - 每一级的显隐、半透明、拾取映射（`filterObject`）和取景都由层级控制（`LevelControl`）决定，可以按选择器和优先级注册替换。
  - `enter()` 沿层级路径逐级离开、进入，每一级都触发 `beforeEnterLevel` / `enterLevel` / `leaveLevel`；新的 `enter()` 会取消进行中的切换；往下钻时缓存视点，返回时飞回。
  - 选择器支持 `&&` `||` `!` 括号、属性比较和 `tags:or/and/not(...)`，编译后缓存。格式和规则见 [indoor-bim.md](docs/agents/indoor-bim.md)。
  - 切换时淡出上一帧，层级之间短途飞行用注视飞行；建筑周围什么都不画时（地球隐藏、3D Tiles 被压制）显示展台背景（indoor-bim.md §7.1）。
  - 设备按楼层 × 几何 × 基础材质 × 渲染状态合成 `InstancedMesh`，颜色 / 发光 / 不透明度是实例属性，材质走样式池（indoor-bim.md §5.2）。设备显隐用 `entity.visible`，移动后调 `refreshTransform()`，改外观用 `setStyle` / `levelOpacity`，不要找设备的材质。
  - 贡献剔除（`indoor.culling`，默认关闭）让屏幕上太小的设备和非结构构件不渲染，结构与楼板始终保留（indoor-bim.md §5.3）。它只设 `entity.culled`，不要用它改 `visible`，也不要自己改实体网格的 `mesh.visible` 来做显隐。
- **顶牌 Marker**：HTML 元素锚定在世界坐标上，每帧用 float64 投影；做地平线、距离、视口裁剪，并按优先级避让；支持数据驱动的显示模式（always / level / hover / click）。`occlusion: 'hide' | 'fade'` 让锚点被建筑、地形挡住时隐藏或淡出（遮挡查询代理，markers.md §5.2.1）；不参与避让的重要顶牌只淡出。
- **点位 PointLayer**：`viewer.addPoints({ data | url, style, rules, cluster })`。
  - 数据可以是 GeoJSON 点、点记录数组或点位文档；样式由图层默认值、属性规则、点自带 style 依次合并。
  - 无高度的点自动贴地。
  - 聚合用加载时建一次的层级聚合树（借鉴 Supercluster），每帧按节点距离选层；顶牌按需创建 DOM，避让走网格索引并定时放置。见 markers.md §5。
  - 共 8 种样式（card / pin / tag / poi / pulse / beacon / badge / label），见 markers.md。
- **矢量**：GeoJSON 在 Worker 中解析和栅格化，按瓦片贴地；注记做屏幕空间避让。
- **开场动画、云层、导航控制**：核心 API 是 `viewer.playIntro()`、`viewer.clouds`、`viewer.navigation`，演示界面（`ui/NavigationBar`、面板开关、URL 参数）只调用它们。脚本化的相机运动走 `controller.playAnimation`，程序缩放 / 环绕走 `zoomBy` / `orbitBy`，不要直接改相机位姿，否则手势打断不了。见 [intro-and-navigation.md](docs/agents/intro-and-navigation.md)。

## 5. 常见任务

| 任务 | 做法 |
| --- | --- |
| 新增影像源 | 实现 `ImageryProvider`（`requestImage` 返回 `ImageBitmap`，404 返回 null），在 `imagery/presets.ts` 注册。只支持 HTTP/1.1 的服务要声明 `maxRequestsPerHost: 6`。不要绕开 Globe 的通道。 |
| 新增栅格地形源 | 在 `TerrainSource.ts` 描述，写明 `tileSize`（决定取数层级偏移）和 `heightReference`。 |
| 新增 BIM 字段 | 先改 `indoor/schema.ts` 的类型和 `parseBuildingDoc` 校验，再改 `Building` 构建，最后同步 [indoor-bim.md](docs/agents/indoor-bim.md)、[建筑数据制作手册](docs/building-data-manual.md)（含默认值表）和样例 `docs/examples/sample-office.building.json`（有单测校验），并补 `tests/indoor.test.ts`。 |
| 新增交互行为 | 用 `viewer.interaction.on(...)` 并带上 `tag`，方便整体注销；需要阻止默认行为时调用 `preventDefault()`，需要压过默认行为时给 `priority` 并调用 `stopPropagation()`。 |
| 改某类层级的效果或取景 | 实现 `LevelControl`，用 `viewer.indoor.registerLevelControl(control, tag)` 注册（`condition` 选择器 + `priority`）；要整体替换默认行为就先 `unregisterLevelControls('builtin')`。效果要写成幂等的绝对状态（返回上级时会重新进入父级）。见 indoor-bim.md §6。 |
| 新增顶牌样式 | 在 `markers/points.ts` 的 `MarkerStyleName` 加名字，在 `markers/cards.ts` 加 `style` 分支，在 `src/style.css` 写 `.tv-<style>`。锚点约定为元素底部中点（pivot `[0.5, 1]`）；以符号中心为锚点的样式用负下外边距让元素止于符号中心。同步 markers.md 的样式表和演示应用 `PointPanel` 的中文名。 |
| 新增或修改公共 API | 在 `src/index.ts` 导出，写 JSDoc（单位、坐标系、取值范围），同步 [docs/api.md](docs/api.md) 和 CHANGELOG；演示应用里用起来，确认从包入口够用。 |
| 验证打出的包 | `npm run build && npm run check:package`：检查 tarball 内容，并把它装进 `scripts/host-fixture` 的宿主工程做类型检查和构建（CI 也跑）。改了 Worker、样式、容器或导出时，再在那个宿主工程里实际打开页面看一遍：两个 viewer 都能跑、Worker 能加载、页面上只有一份 three。 |
| 加载点位数据 | `viewer.addPoints(...)`、面板"点位标注"、`?points=<url>`，或拖入 `*.points.json`；规则写法见 markers.md §4。大批量（上万）或高频刷新的数值不要用 DOM 顶牌，走路线图 M3.6 / M4.6。 |
| 调加载性能 | 先看状态栏和 `viewer.globe.stats`，再按 [tile-loading.md](docs/agents/tile-loading.md) 的调参表调整；不要改坏桶的优先顺序。 |

## 6. 提交前验证

1. 运行 `npm run verify`（typecheck、test、库构建与类型声明、演示构建），全部通过。
2. 涉及数学、调度规则或数据格式的改动，必须在 `tests/` 里补单测（相机不变量、地形分块、BIM 解析与层级都已有测试，可以照着写）。
3. 浏览器手测（可以用 `window.viewer` 编程驱动）：
   - 全球俯视状态下，光标分别放在北、南、东、西，滚轮放大，航向保持 0°、俯仰保持 -90°，画面不翻转。
   - 右键横向拖动只改航向，纵向拖动只改俯仰；拖到极限时停在 -90° 或俯仰上限，不翻转。
   - 加载过程中没有空洞、台阶或拉长的裙边，相机不会被顶高。
   - 用 `?demo` 依次进入建筑 → 楼层 → 房间，再用右键 / Esc 逐级返回；事件顺序正确，顶牌不重叠。
   - 3D Tiles 加载后控制台没有着色器报错。
   - 改了样式、容器或键盘相关的代码时，在一个不铺满窗口的容器里再看一遍：顶牌留在容器内，键盘只在 viewer 有焦点时生效。
4. 自动化浏览器（扩展驱动的 Chrome）里，窗口被遮挡时 rAF 可能只有约 1 帧/秒。不要据此判断性能：看每帧 CPU 耗时（`viewer.stats.frameMs`）和逐帧的状态变化。

## 7. 已知陷阱（踩过的坑）

- **俯视翻转**：俯视时视线水平分量接近 0，用它求航向就会跳 180°。航向公式是 `H = f_h·cos p − up_h·sin p`，详见相机文档。
- **高空法线偏差**：`geodeticSurfaceNormal(p)` 用在离地点上，在 17,000 km 高度会偏 0.42°；改用 `geodeticNormal`。
- **地形空洞**：临时网格如果从另一个临时网格插值，误差会一层层传下去；子瓦片又按错误的高度做裁剪，就会被误剔除。规则是只从精确祖先插值、最多跨 3 级，子瓦片的包围体用精确祖先的高度范围。
- **相机被顶高**：粗分辨率或插值地形可能比真实地面高出数百米。防入地只采用网格间距不超过 `max(50 m, 离地高度 × 1.5)` 的地形。
- **3D Tiles 显存泄漏**：在 `load-model` 事件里替换材质，库释放的仍是旧材质；必须在 `processTileModel` 里替换。
- **HTML 顶牌吞事件**：双击落在顶牌上时 canvas 收不到。实体顶牌走事件代理（`userData.entity` → `interaction.dispatchProxy`），其他顶牌自己处理单击和双击；滚轮要转发。右键只在右键按下也发生在顶牌上时才转发，否则从 canvas 开始、在顶牌上松开的右键拖动会被当成"返回"。
- **Google 3D Tiles 下建筑、点位埋进地面**（ISSUE-1，已修复）：原来贴地只问地球地形，地球隐藏时建筑、点位落在 0 m，比倾斜摄影地面低几十米。现在一切"贴地"都走 `viewer.surfaceHeight`（地球显示用地形，隐藏时对可见 3D Tiles 做竖直射线，压制期间沿用缓存）。新增贴地逻辑不要直接调 `globe.getHeight`，也不要自己对 3D Tiles 做射线：射线每帧有时间预算，结果要看 `reliable`，不可靠时保持原高度（返回 null），不要回落到 0 m。
- **无地球时手势失灵**：隐藏地球（Google 3D Tiles 会自动隐藏）后进入建筑，3D Tiles 也被压制，光标下只剩建筑。控制器拾取落空时原来抓的是椭球最小半径上的点（中纬度地下约 13 km），拖动 100 px 相机飞出 4000 多公里，右键也只能原地转。现在落空时用参考地面（建筑地面高度的椭球，`GeoViewer.pickReferenceSurface`），新增依赖拾取的手势必须走控制器的 `host.pick`，不要自己做射线兜底。
- **渐变量在目标值处来回跳**：`a < target ? 加 : 减` 这种写法在 `a === target` 时会走减的分支，每帧在 1 和 0.29 之间翻（展台背景出现过）。到达目标要夹在目标值上：`a < t ? min(t, a + k) : max(t, a - k)`。
- **瓦片材质改了 `needsUpdate` 不生效**：瓦片材质是 `NodeMaterialInstance`，版本号跟随共享的节点材质，在实例上设 `needsUpdate` 没有作用。改了影响管线的属性（如 `wireframe`）要调用 `refreshTileMaterials()`。
- **层级半透明与用户样式冲突**：同级半透明用 `entity.levelOpacity`（与 `setStyle` 的不透明度相乘），不要用 `setStyle({ opacity })` 实现层级效果，否则返回时会抹掉用户自己设的样式。
- **建筑贴地后取景偏移**：页面刚打开就进入建筑时，飞行目标还是建筑贴地前的位置。贴地平移必须同步给相机（`followMove` 调用 `controller.translate`）。
- **告警被避让隐藏**：重要信息（卡片样式）不能参与避让，只作为障碍物。同理，遮挡也不能把它完全隐藏：`occlusion: 'hide'` 对不参与避让的顶牌按 `fade` 处理。
- **`renderer.isOccluded` 在渲染外返回空**：它读当前渲染上下文，渲染结束后上下文已恢复为空。遮挡代理要在 `onBeforeRender` 里读结果；代理不足一个像素时会被误判为遮挡，半径要按距离换算成像素大小。
- **顶牌数量一多就掉帧**：3000 个点时，每帧的 O(n²) 避让、每帧重算屏幕空间聚合、给所有顶牌写 transform 和随距离变化的 z-index、每个标签上的 `backdrop-filter`（每帧都要重新模糊下方的 WebGPU 画面），叠加起来会让帧率明显下降。现在的规则：
  - 避让走 `CollisionGrid`，并定时放置。
  - 聚合走聚合树。
  - 样式只写变化值。
  - 大批量显示时进入 `dense` 模式，去掉滤镜。
  - 新增顶牌样式不要给大批量元素加 `backdrop-filter`、`filter` 或常驻动画（markers.md §5）。
- **three 射线检测不看 `visible`**：拾取后要自行过滤不可见的对象（见 `IndoorManager.pick`）。合批设备命中的是楼层下的 `BatchMesh`，要用 `hit.instanceId` 经 `entityAt` 取实体，沿父链找 `userData.entity` 会错拿成楼层。
- **整数渲染目标画不了天空**：拾取缓冲是 `RGBA32Uint`，场景的 `backgroundNode`（浮点着色器）、混合（`blending`）都会让管线校验失败。拾取 pass 期间要清空背景、雾和环境，拾取材质用 `NoBlending`。
- **拾取缓冲在同一 tick 内过期**：签名只在每帧 `update()` 时刷新的话，进入层级后同一 tick 里的点击仍读到旧画面（建筑外壳）。`invalidate()` 要立即改签名，相机部分在查询时现场比较。地球瓦片换网格和形变不改变绘制数，要靠 `Globe.surfaceSignature`。
- **`BatchedMesh` 在 WebGPU 上退化成每实例一次绘制**：r187 只合并同几何、下标连续的实例；默认的 `sortObjects = true` 或几何交错添加都会打散（1 万实例约 1 万次绘制）。设备合批用的是 `InstancedMesh`，以后要用 `BatchedMesh` 时关闭排序并按几何分组添加（roadmap.md M3.6）。
- **缩放闪烁：淡入从过期画面开始**：渲染循环先置了 `visible` 和 `lastRenderedFrame` 再判断"上一帧是否在屏幕上"，结果对新上屏的瓦片永远成立，瓦片会从很久以前显示过的粗影像开始淡入。判断"上一帧是否在屏幕上"必须在更新这两个字段之前做（`showNewTile`）。
- **缩放闪烁：缩小时先模糊再变清晰**：父瓦片的影像还没加载就替换了清晰的子瓦片。必须走不丢细节守卫（`losesDetail`），不要绕过 `TileSelection` 直接按 SSE 决定。
- **缩放闪烁：父子来回切换**：子瓦片刚进入视野时还没有网格，父瓦片被迫退回，下一帧又细化。现在靠视野外兄弟瓦片预建网格、本地构网的独立并发额度，以及象限填充来避免。
- **取消请求不等于释放**：只打取消标记时，槽位和 HTTP 连接要等网络返回才释放；地形服务多为 HTTP/1.1，每个域名约 6 个连接，过期请求会把细化卡住几秒。取消必须立即归还槽位，并中止没人等待的下载。
- **地形跳动**：临时网格（祖先数据插值）和精确网格在山区可以相差数百米，层级切换时直接换网格，倾斜视角下画面会错动。换网格和父子替换都要走地形渐变（`startMorph`，tile-loading.md §2），不要直接把 `material.morph` 置 1 了事。
- **TSL 纹理槽被合并**：three 按哈希合并 uniform，纹理节点的哈希是编译时所持纹理的 uuid。两个 `materialReference(..., 'texture')` 在编译时指向同一张纹理，就会共用一个绑定，之后各自赋不同纹理也没用。瓦片的交叉淡入因此一直在混合"旧画面 + 缩小的旧画面"（重影、错位副本），这是加载闪烁的根因。需要同时采样多张纹理时用 `TileMaterial.textureReference` 这种固定独立哈希的写法。
- **影像逐格闪烁**：每块瓦片影像一到就各自淡入，祖先影像逐级到达时还会连续淡入好几次，画面像棋盘一样闪。屏幕上的瓦片换影像要走 `updateShownImagery`（合并中间层级、兄弟成组揭示，tile-loading.md §2），不要在影像到达时直接 `resolveImagery(tile, true)`。
- **HTTP/1.1 影像源排队失控**：浏览器每个域名只开约 6 个连接，多派发的请求在浏览器里先来先服务，优先级失效，屏幕中心要等十几秒才清晰。HTTP/1.1 的源（如 `server.arcgisonline.com`）必须在预设里声明 `maxRequestsPerHost`，见 tile-loading.md §3.1。
- **零尺寸视口**：窗口最小化时 canvas 宽高为 0，手势算出的 NDC 是 NaN，会把相机永久写成 NaN，`syncHash` 还会把它写进 URL。控制器已在视口为零时忽略手势，并在每帧检查位姿、恢复到上一个有效位姿。自动化测试遇到窗口最小化时，要伪造视口尺寸，或者改用只驱动逻辑的测试方式。
- **3D Tiles 缓存顶满后局部永远糊**：库的 `lruCache` 到上限后只会拒绝新瓦片（`stats.refused`），画面停在粗层级，遍历还每帧重试上千次。预算按档位给，满了走自适应降精度（`lodPolicy.stepAdaptiveError`）；判断"有余量"要看在用瓦片的字节数，缓存总量会被没用到的瓦片一直填到下限，看不出余量。
- **隐藏的东西不会被淘汰**：地球隐藏时 `Globe.update()` 不运行，缓存淘汰也不运行，几百块瓦片的纹理一直占显存（正好是 Google 3D Tiles 最缺显存的时候）。隐藏超过档位规定的时间由 `globe.releaseHidden` 释放。新增缓存时不要只靠"每帧 update 里顺便淘汰"。
- **瓦片纹理参数要在上传前设**：GPU 纹理创建时就定了有没有 mip 链，之后改 `generateMipmaps` / 过滤方式不生效。3D Tiles 的纹理策略在 `processTileModel` 里做（`applyTexturePolicy`）。
- **读不到显存大小，`powerPreference` 在 Windows 上无效**：浏览器不暴露显存容量和用量，档位只能按适配器厂商 / 架构猜（`classifyGpu`，可用 `?gpu=` 指定），`viewer.memory` 是自己分配量的估算。Chrome 在 Windows 上忽略 `powerPreference`，双显卡笔记本可能跑在集显上，测性能前先看状态栏徽标里的适配器名。
- **Windows 环境**：`python` 可能只是应用商店的占位程序，脚本请用 Node；Bash 中使用 POSIX 路径。
- **Git Bash 里 vitest 全部失败**：用 `cd /d/...` 进入仓库时，Node 看到的当前目录是小写盘符 `d:\`（推测 vitest 因此按大小写不同的路径加载了两份自身），24 个套件全部报 `Cannot read properties of undefined (reading 'config')`、0 个测试。这不是代码回归：改用 `cd D:/Person/...`（大写盘符）或在 PowerShell 里跑。

## 8. 从 three-geo-global 迁移（2026-11-11）

源仓库 three-geo-global 的 `main`（提交 `be3bbbd`）整体搬到本仓库，并按 [roadmap.md](docs/agents/roadmap.md) §10 改造成 SDK。功能和优化结果没有删减；变化的是工程结构和对宿主页面的要求。

### 8.1 路径对应

| 原路径 | 现路径 | 说明 |
| --- | --- | --- |
| `src/core` `globe` `atmosphere` `tiles3d` `vector` `indoor` `markers` `viewer` | 同名，仍在 `src/` 下 | SDK 源码 |
| 无 | `src/index.ts` | 包入口 |
| `src/style.css` | `src/style.css`（SDK 部分）+ `demo/style.css`（演示界面部分） | 拆分并改类名 |
| `src/main.ts`、`index.html` | `demo/main.ts`、`demo/index.html` | 演示应用 |
| `src/ui/*` | `demo/ui/*` | 演示界面 |
| `src/indoor/demoBuilding.ts`、`src/markers/demoPoints.ts` | `demo/data/` | 示例数据，不进包 |
| `tests/*` | `tests/*` | 新增 `keyboard.test.ts` |
| `docs/*` | `docs/*` | 新增 `docs/api.md` |

### 8.2 行为变化（对照旧文档、旧脚本时注意）

| 项目 | 原来 | 现在 |
| --- | --- | --- |
| 类名 | `.viewer-canvas` `.frame-crossfade` `.marker-layer` `.marker` `.tg-*`，状态类 `.interactive` `.occluded` `.dense` `.selected` | `.tv-canvas` `.tv-crossfade` `.tv-marker-layer` `.tv-marker` `.tv-*`，状态类 `.tv-interactive` `.tv-occluded` `.tv-dense` `.tv-selected` |
| CSS 变量 | 顶牌用页面的 `--font` `--text` `--muted`，强调色 `--accent`，圆盘尺寸 `--size` | `--tv-font` `--tv-text` `--tv-muted` `--tv-card-bg`（带默认值），`--tv-accent`，`--tv-size` |
| 顶牌层定位 | `position: fixed`，铺满窗口 | `position: absolute`，铺满 viewer 容器 |
| 相机键盘 | 监听 `window` | 监听 viewer 容器，有焦点才生效；演示应用启动时自动聚焦 |
| 演示应用的本机设置 | localStorage `three-geo-global:settings` | `terraview:settings`（没有时读旧键） |
| 构建产物 | `dist/` 是演示应用 | `dist/` 是 npm 包，演示应用在 `dist-demo/` |
| three | 打进产物 | peer 依赖，库构建里 external |

### 8.3 没有迁过来的

- **agent-hub 任务流**（`scripts/agent/`、`.githooks/`、`.claude/settings.json`、`specs/`）：那套脚本绑定的是 Hub 项目 `three-geo-global`。本仓库目前没有接入任务流；要接入，需要在 Hub 上为 TerraView 建项目后重新生成。文档里出现的任务编号（`T2611xx-xxx`）指的是原仓库在 Hub 上的任务，留作历史。
- **`cad-to-building` 技能**（`.claude/skills/`）和本地 CAD 数据（`data/`）：含具体站点的资料，2026-11-12 决定不迁移，留在源仓库。本仓库只通过 [建筑数据制作手册](docs/building-data-manual.md) 约定 `*.building.json` 的格式，不收录 CAD 转换工具和站点数据。
- **Git 历史**：本仓库从一次导入提交开始，历史在源仓库。

### 8.4 工作约定

- 提交前运行 `npm run verify`，全部通过。
- 不要顺手改 `package-lock.json`；依赖变更先征得同意。
- 不读取、不输出、不提交 `.env`、密钥、证书等敏感文件。
- 不通过修改或删除测试让检查变绿。
- 推送到远端、发布到 npm 都要先得到明确同意。

### 8.5 CI 与发布

- `.github/workflows/ci.yml`：推送到 main 和每个 PR 都跑。`verify`（Node 22、24）：typecheck、单测、库构建与类型声明、演示构建；`package`：`npm run check:package`，并把 tgz 存为工作流产物。CI 跑在 Linux 上，文件名大小写必须和 import 一致。
- `.github/workflows/release.yml`：推送标签 `v<版本>`（必须等于 `package.json` 的 `version`）时触发：验证、打包自检、创建 GitHub Release 并附 tgz（版本号带 `-` 的标为预发布）。发布到 npm 这一步只在 `package.json` 不再是 `"private": true` 时执行，需要仓库密钥 `NPM_TOKEN`；版本号带 `-` 的发到 `next` 标签。手动运行（workflow_dispatch）是演练，不创建 Release、不发布。
- 发版步骤：改 `package.json` 的 `version`（`package-lock.json` 里的两处同步）→ 把 CHANGELOG 的「未发布」整理成该版本 → 合并到 main → 打标签并推送。打标签和推送要先得到明确同意。
- 包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒；这一点只有真正发布时才能确认。被拒时改用带 scope 的 `@<scope>/terra-view`（scope 不受这条规则限制）。改包名要同时改 `package.json`、`package-lock.json`、`tsconfig.json` 的 `paths`、两份 Vite 配置的别名、`demo/` 和 `scripts/host-fixture/` 里的 import，以及文档。
