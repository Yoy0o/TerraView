# AGENTS.md：TerraView 开发规范

本文面向在本仓库工作的 AI 编码代理和开发者，改代码前请先读。涉及具体子系统时，再读 `docs/agents/` 下对应的专题文档：

> 本仓库由 three-geo-global 迁移而来（2026-11-11，源提交 `be3bbbd`），从演示应用改成了可复用的 SDK：`src/` 是包的源码，`demo/` 是建在公共入口上的演示应用。迁移对应关系见 §8。

| 专题 | 文档 |
| --- | --- |
| 公共 API、接入方式、样式类名与主题变量（改导出、类名、容器行为前先看） | [docs/api.md](docs/api.md) |
| 使用手册（面向接入 SDK 的开发者，按功能分章，每章配一个可运行示例；发布在 GitHub Pages） | [docs/guide/](docs/guide/)，示例在 [examples/](examples/) |
| 相机控制器（手势、不变量、数学） | [docs/agents/camera-controller.md](docs/agents/camera-controller.md) |
| 瓦片加载（底图 / 地形 / 3D Tiles） | [docs/agents/tile-loading.md](docs/agents/tile-loading.md) |
| 室内与 BIM 模型定义、层级导航 | [docs/agents/indoor-bim.md](docs/agents/indoor-bim.md) |
| 建筑数据制作手册（面向数据人员：坐标、字段、类别、模型、自检） | [docs/building-data-manual.md](docs/building-data-manual.md) |
| 顶牌样式与点位标注（数据格式、样式规则、聚合） | [docs/agents/markers.md](docs/agents/markers.md) |
| 开场动画、云层、基础导航控制（核心 API 与 UI 分离、URL 参数） | [docs/agents/intro-and-navigation.md](docs/agents/intro-and-navigation.md) |
| 显存盘点、硬件档位与配置建议、3D Tiles 显存 / 缓存预算（新增占显存的功能前先看） | [docs/agents/gpu-memory.md](docs/agents/gpu-memory.md) |
| 可借鉴与复用路线图（分阶段落地计划，开始新功能前先看） | [docs/agents/roadmap.md](docs/agents/roadmap.md) |
| 局部场景 / 沙盘模式（区域裁剪地形与 3D Tiles、侧壁、展台背景、相机活动范围） | [docs/agents/local-scene.md](docs/agents/local-scene.md) |
| 体积云（近地积云、天气跟随云壳、低分辨率交错追踪与时域重投影、云影） | [docs/agents/volumetric-clouds.md](docs/agents/volumetric-clouds.md) |
| 高斯泼溅 / 3DGS 图层（文件格式、预算、地理锚定、绘制、拾取、裁剪、分期） | [docs/agents/splats.md](docs/agents/splats.md) |
| 改造记录与计划（时间线、Hub 任务对应、待办清单；每个任务合并后更新） | [docs/agents/progress-log.md](docs/agents/progress-log.md) |
| 贡献指南（对外，中英两版；含中英成对文档的清单）、行为准则、安全策略、赞助页 | [CONTRIBUTING.md](CONTRIBUTING.md) / [CONTRIBUTING.en.md](CONTRIBUTING.en.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、[SECURITY.md](SECURITY.md)、[docs/sponsor.md](docs/sponsor.md) |
| ThingJS 示例分析与能力对照（本地资料，不入库） | `temp/thingjs/thingjs-reference.md` |
| ThingJS 运行时源码分析、可借鉴的实现与落地清单（改层级、拾取、事件、样式前先看；本地资料，不入库） | `temp/thingjs/thingjs-runtime-analysis.md` |

`temp/` 存放本地参考资料和草稿，已在 `.gitignore` 中忽略，不要提交；需要入库的结论整理进 `docs/agents/`。

## 1. 项目速览

基于 three.js 的 WebGPU 优先三维地球 SDK（npm 包 `terra-viewer`）：WGS84 椭球、四叉树影像与地形、物理大气、OGC 3D Tiles、高斯泼溅（3DGS）、GeoJSON 矢量与注记、HTML 顶牌、统一拾取事件，以及从地球无缝进入建筑、楼层、房间的室内 / BIM 浏览。宿主应用提供一个容器元素，通过 `GeoViewer` 使用全部能力。

- 技术栈：three r187（0.187.0，`WebGPURenderer` + TSL）、3d-tiles-renderer 0.5.4、TypeScript 5.9（strict）、Vite 8、Vitest 5。依赖版本是锁定的，不要随意升级；升级要先征得同意，并同时更新 `package-lock.json`（本仓库用 npm 安装）。`three` 和 `3d-tiles-renderer` 是 peer 依赖（开发时也装在 devDependencies 里），不打进产物。
- 命令：

  ```bash
  npm run dev         # 演示应用 http://localhost:5173（开发服务器可能已经在跑，先查端口占用，不要杀用户的进程）
  npm run typecheck   # tsc --noEmit（src、demo、examples、tests）
  npm run check:layers  # 分层检查：目录间的依赖方向、文件循环 import（§2.1）
  npm test            # vitest，纯数学与数据逻辑
  npm run build       # 类型检查 + 库构建（dist/terraview.js、terraview.css、assets/*.worker.js）+ 类型声明（dist/types）
  npm run build:demo  # 演示应用的生产构建（dist-demo/）
  npm run build:examples  # 示例的生产构建（dist-examples/）
  npm run verify      # 以上全部，提交前跑
  npm run check:package  # 打包并装进一个临时宿主工程（scripts/host-fixture）检查，需要联网；先 build
  npm run smoke:build    # 冒烟前的构建：库、演示应用、示例、打包宿主（保留在 .smoke/host），需要联网
  npm run smoke          # Playwright 浏览器冒烟：演示应用和打包宿主（WebGL / WebGPU 各一遍）、全部示例；本机用已装的 Chrome，端口 4180 / 4181 / 4182
  npm run examples:dev   # 示例 http://localhost:5175
  npm run docs:dev       # 文档站点（VitePress），页内示例取自 examples:dev，两个一起开
  npm run site:build     # Pages 站点：手册（dist-site/）+ 示例（/examples/）+ 演示应用（/demo/）；改了 docs/ 后跑，死链和 Markdown 里的 Vue 模板错误会让它失败
  ```

- 三份 Vite 配置：`vite.config.ts` 是库构建和 Vitest，`vite.demo.config.ts` 是演示应用，`vite.examples.config.ts` 是示例（后两个都把 `terra-viewer` 解析到 `src/index.ts`）。文档站点的配置在 `docs/.vitepress/config.mts`。

- 演示应用的 URL 参数：`?webgl` `?imagery=osm` `?noterrain` `?tileset=<url>` `?geojson=<url>` `?points=<url>`（点位标注）`?demo`（示例办公楼）`?building=<url>`，开场动画 `?intro=0|1` `?introDuration` `?introSpeed`，云层 `?clouds=0|1` `?cloudCoverage` `?cloudSpeed` `?cloudTexture=<url>` 等（见 intro-and-navigation.md §5），体积云 `?cloudVolumetric=0|1` `?cloudBase` `?cloudThickness` `?cloudWind` `?cloudWindHeading` `?cloudDensity` `?cloudShadows=0|1`（见 volumetric-clouds.md），贡献剔除 `?cull=1` `?cullThreshold` `?cullHysteresis` `?cullInterval` `?cullSelector`（见 indoor-bim.md §5.3），局部场景 `?region=circle:经度,纬度,半径km` / `rect:西,南,东,北` / `poly:经度,纬度;…`、`?regionLook=sandbox|float|dim`（见 local-scene.md §5.1），高斯泼溅 `?splats=<url>` `?splatsAt=经度,纬度[,椭球高]` `?splatsScale` `?splatsHeading` `?splatsUp=-y|+y|+z` `?splatsMax`（见 splats.md §8），显存档位 `?gpu=low|medium|high|ultra`（见 gpu-memory.md），静止帧率 `?idleFps=0|10–60`、静止超采样 `?ss=0|1` `?ssSamples=4–64`、调色 `?grade=neutral|vivid`（见 docs/api.md §1.8、§1.9），以及 `#lon,lat,height,heading,pitch`。
- 调试入口：演示应用里，浏览器控制台的 `window.viewer` 就是 `GeoViewer` 实例。

## 2. 目录与职责

```
src/            SDK 源码，打成 npm 包；不能依赖 demo/
├─ index.ts     包入口：公共 API 只从这里导出（§3.10）
├─ style.css    SDK 样式，发布为 `terra-viewer/style.css`，类名前缀 `tv-`
├─ core/        椭球（Ellipsoid）、测地学（geodesy，Worker 可用、无 three 依赖）、EGM96、太阳位置、EventEmitter、i18n（显示文案与语言）、errors（TerraViewError）、
│               gpuProfile（显存档位、预算表（含高斯泼溅的泼溅数与球谐阶数）、帧缓冲估算，纯函数）、tsl（TSL 节点类型）、cameraBounds（相机活动范围的约定类型）
├─ globe/       四叉树地球：Globe（配置、每帧更新、瓦片选择、缓存淘汰、高程与射线查询）、
│               TileLoader（请求调度：分通道优先级队列与并发、取消、下一级预取、每帧上传预算、失败上报）、requestSlots（Worker 下载向主线程领域名名额）、
│               TileContent（内容应用：影像揭示与交叉淡入、地形渐变）、PolarCaps（两极补洞）、GlobeTile（状态）、
│               tileSelection（选择规则纯函数）、tileMeshLayout（网格索引布局，Worker 与象限填充共用）、TileMaterial（TSL）、
│               Worker 构网、影像源、地形源
│  └─ terrain/  地形源描述、quantized-mesh 解码、terrainTiling（主线程与 Worker 共用的分块 / 插值规则）、terrainDownloads（Worker 里的共享下载、取消与限流）
├─ atmosphere/  大气散射 TSL 节点（含建筑与 3D Tiles 的空气透视 `aerialPerspectiveOutputNode`）、大气的 CPU 版（atmosphereModel：透射率、天空、SH，常数两边共用）、
│               AtmosphereLighting（光照跟随大气：太阳颜色、天光探针）、星空
├─ clouds/      云层（CloudLayer，远看的云壳）、体积云（VolumetricClouds：后期效果的渲染目标、帧状态、何时画什么；
│               cloudNodes：天气图、云影图、追踪、时域重投影、合成各 pass 的 TSL 节点图；volumetricCloudMath 纯函数；
│               cloudNoise 可平铺 3D 噪声 + Worker）
├─ lighting/    日照阴影：shadowFit（阴影图范围适配：包围盒足迹 ∩ 视锥足迹、纹素对齐、分档，纯函数）、
│               SunShadows（viewer.shadows：自管的仅深度阴影图、共享接收节点 sunShadowFactor / unlitShadowOutputNode）、
│               cloudShadows（体积云的云影接收节点，乘进 sunShadowFactor）
├─ tiles3d/     3D Tiles 图层（含档位预算）；nodeMaterials（节点材质转换 + WebGPU 渐显 + 纹理过滤策略）；
│               lodPolicy（远处放宽、缓存满时自适应降精度，纯函数）；tileFeatures（要素编号与属性、高亮叠加网格）
├─ splats/      高斯泼溅（3DGS）：splatData（数据布局、核心包围盒、预算、裁剪、显存估算，纯函数）、splatFormats（.ply / .splat / .spz 解码，Worker 可用）、
│               splatIndex（拾取用的 BVH 与沿射线累积不透明度的查询，纯函数）、splatPlacement（轴向、枢轴、模型矩阵，纯函数）、
│               splat.worker（每次加载一个，下载 + 解码 + 预算 + BVH）、SplatLayer（图层：锚定、three 的 GaussianSplat、显示选项、拾取、释放）
├─ vector/      GeoJSON 图层、矢量 Worker、注记（LabelManager）
├─ indoor/      BIM / 室内：schema（文档格式）、selector（选择器编译，纯函数）、BimEntity（实体、样式、标签）、
│               EntitySet（查询结果与批量操作）、Building（构建与定位）、InstanceBatch（设备合批，InstancedMesh）、
│               StylePool（几何 / 材质按键共享 + 引用计数）、modelBudget（模型按需加载的卸载规则与字节估算，纯函数）、ContributionCulling（贡献剔除，默认关闭）、
│               FloorOcclusion（楼层环境光遮蔽：GPU 烘焙、读回、共享 colorNode、调度）、LevelControl（层级控制策略）、
│               levelBinding（层级绑定：图层等内容挂到层级节点、按所在层级显隐，规则是纯函数）、
│               levelView（取景数学）、IndoorManager（层级路径切换、视点缓存、拾取、顶牌）
├─ markers/     MarkerManager（HTML 顶牌：投影、裁剪、避让、遮挡）、occlusion（遮挡代理池与规则，纯逻辑）、cards（顶牌样式模板）、
│               points（点位解析 / 规则，纯函数）、clusterTree（层级聚合树，纯函数 + Worker）、
│               PointLayer（点位图层）
├─ region/      局部场景的区域：region（区域数学与棱柱，纯函数）、regionMask（共享裁剪遮罩，按渲染器取区域）；globe、tiles3d、local 共用
├─ local/       局部场景（沙盘）：RegionWalls（侧壁）、RegionDimEffect（区域外压暗）、LocalScene（调度，viewer.localScene）
├─ post/        后期管线（PostPipeline：场景 pass → linear 效果 → 色调映射 → display 效果；静止超采样的抖动样本与历史缓冲）、EffectMarks（描边 / 发光对象登记）、
│               OutlineEffect（遮罩 + 边缘搜索，可描单个合批实例）、GlowEffect（遮罩 + BloomNode）、ViewerEffects（viewer.effects）、
│               Supersampling（viewer.supersampling）、ColorGrading（viewer.colorGrading + 对比度 / 饱和度效果）、
│               LevelTransition（viewer.levelTransition：层级切换时截帧，按深度重投影后溶解）、
│               Transparency（viewer.transparency：建筑和设备的透明顺序无关混合，透明 pass 在 PostPipeline 里）、postMath（纯函数）
└─ viewer/      GeoViewer（总装：创建子系统并接线、公共 API、容器）及其部件（各自声明所需的窄接口，不 import GeoViewer）：
                ViewerEnvironment（大气 / 星空 uniform、灯光、阴影适配输入、体积云帧状态）、
                FrameLoop（帧循环：降帧与静止判定、各部件的更新顺序、帧外渲染、统计、加载状态）、
                ViewerPicking（拾取、要素拾取、手势拾取与参考地面）、ViewerLayers（图层增删、glTF 加载、贴地高程与防入地）、
                diagnostics（显存估算、快照、GPU 识别）、viewerState（部件共享的状态）、viewerTypes（公共类型）、
                indoorBehaviors（默认的室内交互）；GlobeCameraController、cameraMath、CameraFlight（弧线 / 注视飞行）、
                NavigationControls（导航命令，无 UI）、IntroAnimation（开场自转）、
                IndoorBackdrop（无地表时的展台背景）、
                InteractionManager（click / dblclick / rightclick / hover + 选择器、标签、优先级、once、停止传播、暂停、顶牌事件代理）、
                PickBuffer（GPU 拾取缓冲）、pickMath（八面体法线、深度反投影，纯函数）、loadState（加载状态与 idle 判定，纯函数）、framePacing（静止降帧、变化 / 唤醒、静止判定与绘制方式，纯函数）、
                OcclusionProxies（顶牌遮挡查询代理）
demo/           演示应用，不进包；只通过 `terra-viewer` 入口使用 SDK
├─ main.ts      启动、URL 参数、hash 同步、Esc 返回、文件拖放
├─ style.css    演示界面的样式（面板、状态栏等）
├─ ui/          面板（ControlPanel / IndoorPanel / VectorPanel / PointPanel / SplatPanel / OverlayPanel）、状态栏、属性弹窗、层级条、
│               导航按钮条（NavigationBar）、URL 参数解析（urlOptions）、本机设置（settings）
└─ data/        示例数据：demoBuilding（示例办公楼）、demoPoints（示例点位）、demoSplats（开放的高斯泼溅场景：地址与署名，数据不入库）
examples/       可运行示例，不进包；每个目录一页（index.html + main.ts），同样只通过 `terra-viewer` 入口使用 SDK
├─ catalog.ts   示例清单（标题、简介、所属手册章节、数据署名）：示例列表页、各页标题和冒烟测试都读它
├─ shared/      示例页面的面板与控件（ui.ts、example.css），不是 SDK API
└─ index.html   示例列表页（gallery.ts）
tests/          vitest：geo / camera / keyboard / flight / navigation / terrain / tileSelection / tileMeshLayout / requestScheduler / terrainDownloads / vector / points / clusterTree / occlusion / selector / indoor / batching / backdrop / pickBuffer / interaction / surfaceHeight / intro / clouds / culling / gpuProfile / i18n / loadState / framePacing / models / tileFeatures / post / atmosphere / floorOcclusion / shadows / localRegion / volumetricClouds / splats / levelBinding；tests/e2e/ 是 Playwright 浏览器冒烟（*.e2e.ts，不归 vitest）
docs/           文档站点的源（VitePress，发布到 GitHub Pages；docs/agents/ 除外）
├─ .vitepress/  站点配置（侧栏、搜索、链接改写）与主题（ExampleFrame：页内嵌入示例）
├─ index.md     站点首页
├─ guide/       使用手册（面向接入 SDK 的开发者）
├─ api.md       公共 API 与接入说明（站点上的"API 参考"）
├─ releases/    各版本的发布说明（GitHub Release 的正文）
├─ en/          英文页面（站点的 /en/：首页、快速开始、发布说明、赞助页），与中文页成对维护
├─ sponsor.md   赞助页（收款码在 images/sponsor/）
└─ agents/      子系统规范（本文档的展开，面向贡献者，不发布到站点）
```

### 2.1 分层

目录之间的运行时依赖只能自下而上，由 `npm run check:layers`（`scripts/check-layers.mjs`，`verify` 和 CI 都跑）检查，规则表是脚本里的 `ALLOWED`：

| 目录 | 可以依赖 |
| --- | --- |
| core | 无 |
| atmosphere、region、post、markers、splats | core |
| lighting | core、atmosphere |
| clouds | core、atmosphere、lighting、post |
| globe、tiles3d | core、atmosphere、lighting、region |
| vector | core、globe |
| indoor | core、atmosphere、lighting、post、markers |
| local | core、region、post、globe、tiles3d |
| viewer | 以上全部 |

- 文件之间不能有运行时的循环 import。只导入类型的（`import type`，或说明符全部带 `type`）构建时会被擦掉，方向不限；`node scripts/check-layers.mjs --types` 把它们也算上做审查，故意保留的类型循环列在 `ACCEPTED_TYPE_CYCLES`（目前一处：`IndoorManager` ↔ `LevelControl`，公共的 `LevelContext.indoor` 就是管理器本身）。
- 下层要用上层的东西时，在下层声明它需要的窄接口，由上层把自己或一组引用传进来（`ViewerPicking` 的 `PickingHost`、`TileLoader` 的 `LoaderHost`、`NavigationControls` 的 `NavigationHost`），不要反向 import。
- 新增目录或新增一条依赖方向是设计决定：改 `ALLOWED`，在提交说明里写理由。

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
- HTTP/1.1 的服务（影像或地形）声明 `maxRequestsPerHost`，下载经按域名的队列（`RequestScheduler`）；Worker 里的下载经 `requestSlots` 向主线程领名额，不要在 Worker 里各自限流（tile-loading.md §3.1）。
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
- 拾取：交互事件（单击、双击、悬停）经 `viewer.pickAt` 先查 GPU 拾取缓冲（`viewer.pickBuffer`，WebGPU），缓冲与当前相机、场景签名不一致时自动退回 CPU 射线，调用方不用区分。高斯泼溅不在缓冲里（不写深度），`viewer.pick` 求出表面后再对每个泼溅图层发一条射线（`SplatLayer.raycast`，BVH），结果 `kind: 'splats'`。新增拾取需求走 `viewer.pick(ndc, { buffer: true })` / `pickAt`，不要自己对整个场景做射线；改了签名看不到的东西（直接改对象变换、显隐而绘制数不变）要调用 `viewer.pickBuffer?.invalidate()`。相机手势仍用射线（`host.pick`）。实体映射统一用 `indoor.entityForHit(object, instanceId)`。见 roadmap.md M2.1。
- HTML 顶牌盖在 canvas 上方，会截获事件。实体顶牌带上 `userData.entity` 即可：单击、双击、右键单击经 `MarkerManager.eventProxy` 转成 `viewer.interaction` 上对该实体的事件（`event.marker` 指向顶牌）。与实体无关的顶牌（点位、聚合）自己提供 `onClick` / `onDoubleClick`。滚轮已由 `MarkerManager` 转发给 canvas。

### 3.8 代码风格

- TypeScript strict，开启 `noUnused*`。`any` 只允许出现在第三方库边界，并且要加 `eslint-disable-next-line` 注释。
- 每个模块文件开头写清职责。导出的 API 写 JSDoc；注释解释"为什么"，不复述代码。
- 公共 API 的单位、坐标系、取值范围必须写在类型或注释里。
- 演示应用的 UI 文案用中文；DOM 用 `demo/ui/dom.ts` 的 `h()`；样式复用 `demo/style.css` 里的 CSS 变量。SDK（`src/`）里不要新增写死的界面文案：给用户看的文字加到 `src/core/i18n.ts`（每种语言都要有，默认 `zh-CN`，经 `viewer.messages` 读取）；错误用 `TerraViewError`（英文消息 + `code` + `details`，新 code 同步 `demo/ui/errors.ts` 的中文和 docs/api.md §1.6）。`tests/i18n.test.ts` 会扫描 `src/`，注释以外出现中文就失败（输入字段别名、服务商署名等白名单除外）。

### 3.9 数据与合规

- 访问凭证（天地图、ion、Google、Mapbox）由宿主作为参数传入；演示应用把它们保存在本机 localStorage。凭证不能写进仓库，也不能内置进包。
- 示例国界数据不是审定地图，在国内发布必须使用有审图号的数据。示例数据放在 `demo/`，不随包发布。
- 许可证 Apache-2.0（`LICENSE`、`package.json` 的 `license` 字段）。移植来的代码保留版权声明，见 `THIRD_PARTY_NOTICES.md`；引入新的第三方代码前先确认其许可与 Apache-2.0 兼容。

### 3.10 SDK 边界（包与演示分离）

- `src/` 不能 import `demo/`、`examples/`；`demo/`、`examples/` 只能从 `terra-viewer`（`src/index.ts`）和 `terra-viewer/style.css` 引用 SDK，不要用相对路径伸进 `src/`。演示应用或示例需要的东西没有导出，就说明公共 API 缺了一块：补到 `src/index.ts`，并同步 [docs/api.md](docs/api.md)。
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
- **3D Tiles**：`NodeMaterialPlugin` 把材质转为节点材质；`TilesFadePlugin` 的材质管理器换成 `NodeFadeMaterialManager`（TSL dither 遮罩）；显存目标、解码缓存上限、纹理过滤按显存档位给（`viewer.gpu.tiles`），隐藏瓦片在显存目标内保留、过了延时才释放；斜视时远处瓦片放宽误差，缓存满时整体降精度而不是局部停止加载（[gpu-memory.md](docs/agents/gpu-memory.md) §5）。图层的 `errorTarget` 改 `layer.errorTarget`，不要直接写 `layer.tiles.errorTarget`（每帧会被覆盖）。要素拾取用 `event.tileFeature()` / `viewer.pickTileFeature`，高亮用 `viewer.highlightTileFeature`（tile-loading.md §7.1）。
- **相机**：左键抓地平移；右键横向调航向、纵向调俯仰（默认绕屏幕中心点）；滚轮缩放到光标并保持航向和俯仰；另有环绕巡航、俯仰范围、各类开关、双击钩子。
- **室内 / BIM**：层级为 地球 → 建筑 → 楼层 → 房间 / 设备。双击进入，右键单击或 Esc 返回，单击选中，悬停高亮。
  - 每一级的显隐、半透明、拾取映射（`filterObject`）和取景都由层级控制（`LevelControl`）决定，可以按选择器和优先级注册替换。
  - `enter()` 沿层级路径逐级离开、进入，每一级都触发 `beforeEnterLevel` / `enterLevel` / `leaveLevel`；新的 `enter()` 会取消进行中的切换；往下钻时缓存视点，返回时飞回。
  - 选择器支持 `&&` `||` `!` 括号、属性比较和 `tags:or/and/not(...)`，编译后缓存。格式和规则见 [indoor-bim.md](docs/agents/indoor-bim.md)。
  - 切换时截下上一帧（连同深度，不读回 CPU），按深度重投影到飞行中的相机并溶解（`viewer.levelTransition`，后期管线的 `transition` 效果），层级之间短途飞行用注视飞行；建筑周围什么都不画时（地球隐藏、3D Tiles 被压制）显示展台背景（indoor-bim.md §7.1）。
  - 设备按楼层 × 几何 × 基础材质 × 渲染状态合成 `InstancedMesh`，颜色 / 发光 / 不透明度是实例属性，材质走样式池（indoor-bim.md §5.2）。设备显隐用 `entity.visible`，移动后调 `refreshTransform()`，改外观用 `setStyle` / `levelOpacity`，不要找设备的材质。
  - 楼层和设备的 glTF 在楼层第一次显示时才加载，隐藏楼层的模型超出 `indoor.modelBytesTarget` 时卸载（indoor-bim.md §5.4）。要在显示前用到模型（取景、包围体）先 `await building.modelsLoaded(entity)`；不要假设 `add()` 之后房间、设备上已经有模型网格。
  - 贡献剔除（`indoor.culling`，默认关闭）让屏幕上太小的设备和非结构构件不渲染，结构与楼板始终保留（indoor-bim.md §5.3）。它只设 `entity.culled`，不要用它改 `visible`，也不要自己改实体网格的 `mesh.visible` 来做显隐。
  - **层级绑定**（`indoor.bindings`，indoor-bim.md §6.5）：层级树只有一棵，节点是实体；高斯泼溅、3D Tiles 等图层不是层级，而是用 `level` 选项绑到某个节点（`{ entity, show, entityOpacity }`），所在层级决定显隐，实体的模型可以让位（`bindingOpacity`，0 时仍可拾取、描边、带顶牌）。要让层级之外的东西跟着层级走就用它，不要在 `enterLevel` 监听里手写显隐，也不要另起一套层级或新增实体类型。规则是 `levelBinding.ts` 的纯函数；图层的显隐统一经 `GeoViewer.hiddenByLevel`。
  - 楼层环境光遮蔽（`indoor.ambientOcclusion`，默认开）在楼层第一次显示时烘焙一次，之后只是接收材质里共享的 `colorNode` 采样一张贴图（indoor-bim.md §5.6）。新的楼层网格按角色设 `mesh.userData.aoRole`（`'floor'` / `'occluder'`）；不要给接收 AO 的材质另设 `colorNode`（会被跳过）。
- **局部场景**（M4.9）：`viewer.localScene.enter({ region })` 只显示一块区域（园区到城区，直径 ≤ 100 km），区域外不画不加载，边缘土层侧壁、展台背景，相机由 `controller.bounds` 管着。地球场景的子模式，与建筑层级独立。裁剪是共享的 `maskNode`（`regionMaskNode`），区域参数按渲染器存；地球瓦片只在跨边界时换裁剪材质（`GlobeTileClipped`），3D Tiles 用 `RegionMaskPlugin` 屏蔽区域外瓦片。新增需要"按区域裁剪"的东西时复用 `regionMaskNode` / `hasRegionMask`，拾取材质要同步带上。见 [local-scene.md](docs/agents/local-scene.md)。
- **高斯泼溅**（M4.8 第一期）：`viewer.addSplats({ url | data, position, … })` 把一个 `.ply` / `.splat` / `.spz` 场景放到地球上。见 [splats.md](docs/agents/splats.md)。
  - 解码在 Worker 里（`splatFormats.ts`，不 import three；SPZ 4 的 Zstandard 流发回主线程用 three 的 `zstddec` 解压），按档位预算（`viewer.gpu.splats`）舍去不重要的泼溅，同时建好拾取用的 BVH。新增格式照这个路子加，不要把 three 的加载器搬进主线程。
  - 绘制用 three 自带的 `GaussianSplat`，只包一层 `colorNode`（sRGB → 线性、不透明度、亮度）。不要改它的顶点阶段，也不要给它挂空气透视、`mrtNode`。它不写深度：进不了拾取缓冲，不挡顶牌，后画的透明物体叠在它上面。
  - 位置、朝向、尺度、轴向都由宿主给（文件里没有）：`setPlacement`、`upAxis`、`pivot`；贴地走 `viewer.surfaceHeight` 的查询。场景的中心、取景、排序范围用去掉离群点的**核心包围盒**（`computeSplatBounds`），视锥剔除用全量的。
  - 图层上会改变画面的 setter 都发 `change` 事件；`crop` 是 CPU 过滤后重新上传（拾取不重建，带掩码查原来的 BVH）。
  - 释放走 `disposeGaussianSplat`（three 的类没有 `dispose()`）；每次加载一个 Worker，返回后关闭。
  - 属于某栋楼、某一层的场景用 `level` 绑到那个实体（splats.md §7.1）：可以放进实体坐标系（`level.position`，viewer 每帧 `setFrame`），默认懒加载，拾取归到实体（`pickEntity`）。建筑文档的 `splats` 字段就是这样建出来的。图层本身不 import 室内模块的实现（只用类型），实体矩阵、绑定状态都由 viewer 递过去。
- **后期与描边**（M3.1 / M3.2）：每帧都经 `viewer.postProcessing`：场景画进它自己的 HDR 目标（与渲染器自带的格式相同，场景材质不重编），再按阶段跑启用的效果，最后一个全屏 pass 色调映射输出；没有效果时等价于 `renderer.render`。帧外渲染（截图、层级截帧）也走它（`renderOutsideFrame`）。选中 / 悬停 / 告警是描边与发光（`entity.effects`、`indoor.selectOutline`、`viewer.effects`），不改材质，合批设备只描自己的实例。静止超采样（`renderSample`）在场景 pass 和效果自己的 pass 期间平移相机（`setViewOffset`），所以效果的遮罩跟着场景一起抖动；效果里不要缓存跨帧的投影矩阵。调色（`viewer.colorGrading`）是 display 阶段的 `grading` 效果，排在描边之前。新效果实现 `PostEffect`，需要法线等附件用 `attachments` 声明（全局节点），**不要给场景材质设 `material.mrtNode`**。说明见 [api.md](docs/api.md) §1.9、[indoor-bim.md](docs/agents/indoor-bim.md) §5.5。
- **顶牌 Marker**：HTML 元素锚定在世界坐标上，每帧用 float64 投影；做地平线、距离、视口裁剪，并按优先级避让；支持数据驱动的显示模式（always / level / hover / click）。`occlusion: 'hide' | 'fade'` 让锚点被建筑、地形挡住时隐藏或淡出（遮挡查询代理，markers.md §5.2.1）；不参与避让的重要顶牌只淡出。
- **点位 PointLayer**：`viewer.addPoints({ data | url, style, rules, cluster })`。
  - 数据可以是 GeoJSON 点、点记录数组或点位文档；样式由图层默认值、属性规则、点自带 style 依次合并。
  - 无高度的点自动贴地。
  - 聚合用加载时建一次的层级聚合树（借鉴 Supercluster），每帧按节点距离选层；顶牌按需创建 DOM，避让走网格索引并定时放置。见 markers.md §5。
  - 共 8 种样式（card / pin / tag / poi / pulse / beacon / badge / label），见 markers.md。
- **矢量**：GeoJSON 在 Worker 中解析和栅格化，按瓦片贴地；注记做屏幕空间避让。
- **帧率与静止超采样**：画面安静 1 秒后先做静止超采样（默认 16 / 32 个亚像素抖动样本，P3.3），画完就**不再画帧**，只按 `idleFrameRate`（默认 10）更新状态；关掉超采样时按 `idleFrameRate` 重画。有变化立刻恢复实时画面（docs/api.md §1.8，规则在 `viewer/framePacing.ts`）。两种信号：**变化**（`requestRender()`，画面可能不同了，丢掉超采样）和**唤醒**（`GeoViewer.wake()`，输入或 DOM 上的工作，只要求全帧率更新，不丢画面）；新信号先想清楚是哪一种，输入本身只能是唤醒，否则鼠标一动静止画面就先变糙再变细。画面静止后漏接一个变化，改动要等下一次别的变化才出现（不再是"晚 100 ms"），所以新增会随时间自己变化的效果（动画、渐变、轮询）时，要让 viewer 知道它在动：返回"有变化"并在帧循环里 `requestRender()`（如 `labels.update`、`Globe.animating`、`Tiles3DLayer.animating`），或像云层那样给出最低帧率（大于 0 就永远不算静止）；能廉价读到的状态放进 `FrameLoop.pictureChanged()` 每帧比较。公共 API 上会改变画面的 setter 要通知 viewer：实体经 `BimEntity.onChange`（建筑根上，由 `IndoorManager` 转给 viewer，几何变化还会让拾取缓冲和贡献剔除失效），图层发 `change` 事件，云层用 `onChange`，或者在 `FrameLoop.checkPendingWork()` 里轮询（每个动画帧都查，降帧时也查）。分几帧做完的工作（每帧预算，如点位每帧建 200 个顶牌）报告 `busy`，做完前保持全帧率；不要为了降帧把每帧预算改成按时间算。"每 N 帧一次"的逻辑只有在它的输入能在静止时、且没有任何通知的情况下变化时才需要改成按时间（2026-11-14 评估，roadmap P2.1a）。
- **光照跟随大气与空气透视**（M3.5）：开光照时，建筑和 3D Tiles 的平行光颜色、天光探针（`viewer.skyProbe`，内部）由大气的 CPU 版（`atmosphere/atmosphereModel.ts`）在视点处算出，和着色器用同一套常数（改大气常数只改那里）。建筑、设备、3D Tiles 的材质挂共享的 `aerialPerspectiveOutputNode()` 作为 `outputNode`（与地球瓦片相同的空气透视，逐像素，100 m 内跳过）；新增这类材质时照样挂上，不要用 `scene.fog` / `scene.fogNode`（会作用到注记、云、展台等所有材质）。见 docs/api.md §1.10。
- **日照阴影与透明混合**（M3.9）：开光照时一张自管的平行光阴影图（`viewer.shadows`，`lighting/SunShadows`），每帧按"建筑包围盒 ∩ 视锥"适配，只把建筑树（`indoor.root`）画进去，只在范围或建筑内容变化时重画。接收方读共享的 `sunShadowFactor()`：光照材质经太阳光的 `shadow.shadowNode`（只削弱直射），地球瓦片乘在直射项上，无光照的 3D Tiles 和展台背景用 `unlitShadowOutputNode` / 直接乘。新建的建筑网格要 `castShadow` / `receiveShadow`（`Building` 的 `shadowed()`、`BatchMesh` 构造里已设）；透明材质不投影。不要用 three 的 `SunLight` / `CSMShadowNode`（float32 世界坐标乘阴影矩阵，ECEF 下差半米），也不要给太阳光开 three 自己的阴影图。直接改建筑网格后调用 `viewer.shadows.invalidate()`。透明顺序无关混合（`viewer.transparency`，WebGPU，默认只在 `ultra`）只处理建筑实体网格和设备批次（`postProcessing.oitTest`）。见 docs/api.md §1.11。
- **体积云**：近地（300 km 以下）的积云层是 linear 阶段的后期效果（`clouds/VolumetricClouds`，节点图在 `clouds/cloudNodes`），设置在 `viewer.clouds.set({ volumetric })`。天气图（按档位 512² / 1024²，随风滑动、只在锚点 / 风 / 设置变化时重画）跟随云壳的 `densityNode`；追踪每帧只画历史四分之一的像素（2×2 交错），其余按云距离、相机运动和风重投影；合成按场景深度上采样。云影乘进 `sunShadowFactor()`（只削弱直射光），有云影时太阳光 `castShadow` 打开。体纹理没有 mip：噪声通道是单八度，着色器按像素足迹逐八度淡出，新增噪声查找照此处理。云壳的漂移被当作风（不触发重画天气图）。见 [volumetric-clouds.md](docs/agents/volumetric-clouds.md)。
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
| 新增或修改公共 API | 在 `src/index.ts` 导出，写 JSDoc（单位、坐标系、取值范围），同步 [docs/api.md](docs/api.md) 和 CHANGELOG；演示应用里用起来，确认从包入口够用。宿主会用到的功能，在使用手册对应章节（`docs/guide/`）补用法，必要时补或改示例；改名、删除时搜一遍 `docs/guide/` 和 `examples/`（示例有类型检查兜底，手册没有）。 |
| 新增示例 | 建 `examples/<id>/index.html`（照抄现有的）和 `main.ts`，在 `examples/catalog.ts` 登记（标题、简介、所属章节 `guide`、第三方数据的署名）；SDK 调用写在 `main.ts` 里并加中文注释，面板控件用 `examples/shared/ui.ts`；只用免密钥、许可允许的数据，加载失败时不能抛出未捕获的错误（冒烟测试会拦截外部请求）。在对应章节末尾放 `<ExampleFrame id="<id>" />`。跑 `npm run build:examples` 和 `npx playwright test --project examples`（先 `npm run build:examples`）。 |
| 改文档站点 | 手册在 `docs/guide/`，侧栏在 `docs/.vitepress/config.mts`。相对链接写 `.md` 扩展名（GitHub 上也能点）；指向 `docs/agents/`、源码、CHANGELOG 的相对链接构建时改写成 GitHub 地址；指向示例列表、演示应用用完整的 Pages 地址。正文里不要出现代码块以外的 `{{ }}` 和裸的 `<标签>`（VitePress 把 Markdown 当 Vue 模板编译）。`npm run site:build` 会检查死链。推送到 main 后 `pages.yml` 自动发布。对外文档有中英两版（README、CONTRIBUTING、站点首页、快速开始、发布说明、赞助页，清单在 CONTRIBUTING.md「文档同步」）：改一边时另一边同步；英文页放 `docs/en/`，侧栏在 config 的 `locales.en`。 |
| 验证打出的包 | `npm run build && npm run check:package`：检查 tarball 内容和体积预算（`scripts/check-package.mjs` 的 `BUDGETS`，有意增大时调高并在提交里说明），并把它装进 `scripts/host-fixture` 的宿主工程做类型检查和构建（CI 也跑）。改了 Worker、样式、容器或导出时，再在那个宿主工程里实际打开页面看一遍：两个 viewer 都能跑、Worker 能加载、页面上只有一份 three。这几项 `npm run smoke:build && npm run smoke` 会自动检查（另有顶牌留在容器内、逐个销毁后 Worker 归零），看画面仍要手测。 |
| 加载高斯泼溅 | `viewer.addSplats(...)`、面板"高斯泼溅（3DGS）"、`?splats=<url>`，或拖入 `.ply` / `.splat` / `.spz`；方向不对换 `upAxis`，大小不对调 `scale`（文件没有真实尺度）。改了 `src/splats/` 后跑 `tests/splats.test.ts` 和冒烟的"高斯泼溅"用例，并按 splats.md §10 的清单在真实 GPU 上看一遍。 |
| 新增泼溅文件格式 | 在 `splats/splatFormats.ts` 加解码函数（输出 `SplatData`，不 import three）和 `detectSplatFormat` 的判断，`SplatFormat` 加名字；需要第三方解压库时先征得同意，并决定放主线程（经宿主的 three）还是打进 Worker。补 `tests/splats.test.ts`（用代码生成最小文件），同步 splats.md §3.1。 |
| 把图层绑到层级 | 泼溅：`viewer.addSplats({ …, level: { entity, position?, show?, entityOpacity? } })` 或 `layer.setLevel(...)`；3D Tiles：`addTileset({ …, level })`；数据里：建筑文档元素的 `splats`；宿主自己的对象：`viewer.indoor.bindings.bind(obj, options, { onChange })`。改规则改 `indoor/levelBinding.ts` 并补 `tests/levelBinding.test.ts`；改了文档字段按"新增 BIM 字段"那一行同步手册。 |
| 加载点位数据 | `viewer.addPoints(...)`、面板"点位标注"、`?points=<url>`，或拖入 `*.points.json`；规则写法见 markers.md §4。大批量（上万）或高频刷新的数值不要用 DOM 顶牌，走路线图 M3.6 / M4.6。 |
| 调加载性能 | 先看状态栏和 `viewer.globe.stats`，再按 [tile-loading.md](docs/agents/tile-loading.md) 的调参表调整；不要改坏桶的优先顺序。 |

## 6. 提交前验证

1. 运行 `npm run verify`（typecheck、分层检查、test、库构建与类型声明、演示与示例构建），全部通过。改了 `docs/` 时再跑 `npm run site:build`。
2. 涉及数学、调度规则或数据格式的改动，必须在 `tests/` 里补单测（相机不变量、地形分块、BIM 解析与层级都已有测试，可以照着写）。
3. 浏览器手测（可以用 `window.viewer` 编程驱动）。有条件时用真实浏览器（Claude in Chrome 等）；自动化兜底是 `npm run smoke`（Playwright，CI 也跑）：演示应用（离线调试影像、`?demo` 逐级进出并核对事件顺序、销毁）和打包宿主（两个 viewer、逐个销毁、Worker 归零），出现页面错误、控制台错误或请求外部域名就失败。改了渲染、Worker、容器、层级相关的代码时跑一遍。手测清单：
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
- **无地球时手势失灵**：隐藏地球（演示应用加载 Google 3D Tiles 时会隐藏它，SDK 本身不会自动隐藏）后进入建筑，3D Tiles 也被压制，光标下只剩建筑。控制器拾取落空时原来抓的是椭球最小半径上的点（中纬度地下约 13 km），拖动 100 px 相机飞出 4000 多公里，右键也只能原地转。现在落空时用参考地面（建筑地面高度的椭球，`GeoViewer.pickReferenceSurface`），新增依赖拾取的手势必须走控制器的 `host.pick`，不要自己做射线兜底。
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
- **共享 uniform 在帧外渲染时串 viewer**：大气、注记的相机 uniform 是模块级的，所有 viewer 共用，帧内渲染前由各自重写。截图、层级切换截帧这类帧外的 `renderer.render` 原来没有重写，同页有两个 viewer 时会画出另一个 viewer 的相机和大气。帧外渲染一律走 `FrameLoop.renderOutsideFrame()`（`captureFrame`、层级截帧都经它）；新增共享 uniform 时同样要在渲染前重写（docs/api.md §4）。
- **注释里写了 `@internal` 字样，整条导出被裁掉**（2026-11-13，P1.1）：`stripInternal` 按字符串在前导注释里找 `@internal`，写在正文、反引号里都算。`src/index.ts` 文件头的说明提到这个标记，它是第一条导出的前导注释，`GeoViewer` 就从发布的声明里消失了；声明文件本身仍然合法，`tsconfig.dts.json` 看不出来，是打包宿主的类型检查发现的。现在 `build:types` 最后跑 `scripts/check-dts.mjs`，比对入口在源码和声明里的导出名。注释里提到这两个标记时不要带 `@`；分级规则见 docs/api.md §2。
- **冒烟测试里 `window.viewer` 提前"存在"**：带 id 的元素会成为同名的 `window` 属性（演示应用的 `<div id="viewer">`、宿主的 `#left` / `#right`），等 viewer 要等 `window.viewer?.info` 之类的实例字段。
- **软件渲染下"等瓦片加载完"会超时**（2026-11-13，CI 首跑宿主测试 150 s 超时）：无 GPU 时 SwiftShader 占满 CPU，画面约 4 fps，影像的 `createImageBitmap` 每次约 900 ms（有 GPU 时 1 ms），屏幕之外的低优先级加载（留作回退的祖先影像，按设计只用三分之一的并发）排空要再花一倍时间，2 核 runner 上跑不完。冒烟测试用 `probeBackend` 问浏览器是不是软件渲染：是的话只等"屏幕上的瓦片都有自己的影像"，有 GPU 时才要求队列排空。新增等待条件同样要分这两档，不要用软件渲染下的耗时判断 SDK 性能。本机 `SMOKE_NO_GPU=1` 只把 WebGL / WebGPU 放到 SwiftShader 上，页面合成仍走 GPU，比 CI 快好几倍：本机软件模式能过不代表 CI 有余量。
- **释放几何会删掉它的属性缓冲，即使属性是共享的**（2026-11-17，P2.3）：three 的 `Geometries` 在 `geometry.dispose()` 时对它的每个属性调用 `attributes.delete`，不管别的几何还在不在用。给已有网格做叠加（高亮、描边）时不要共享原几何的 `BufferAttribute`，复制一份（`tileFeatures.copyPositions`，保持存储类型和归一化，深度才和原表面一致）。
- **3DTilesRendererJS 的元数据读取会建 WebGL 渲染器**：`MeshFeatures.getFeatures()` 一进来就经 `TextureReadUtility` 创建 `WebGLRenderer`（即使只读属性），`getPropertyTextureData()` 也一样。要素编号属性、属性表自己读（`tileFeatures.ts`），纹理类的元数据目前不读。
- **材质的 `mrtNode` 会顶掉所有渲染目标里的输出**（2026-11-17，P3.1）：r187 的 `NodeMaterial` 在渲染到渲染目标时，渲染器没设 MRT 就直接用 `material.mrtNode` 当输出，拾取缓冲、渲染器自带的 HDR 目标都算渲染目标。three 官方选择性泛光示例那种"给材质挂 `mrtNode`"的写法在本仓库会弄坏拾取和画面。逐对象的后期效果走 `post/EffectMarks` 的遮罩重绘，逐材质的附件用 `PostEffect.attachments` 的全局节点。
- **`setViewOffset` 会改 `camera.aspect`**（2026-11-18，P3.3）：three 的 `PerspectiveCamera.setViewOffset(fullWidth, fullHeight, …)` 把 `aspect` 设成 `fullWidth / fullHeight`，`clearViewOffset()` 不还原。按画布像素传入时它和容器的宽高比差在最后几位，恢复后的投影矩阵就和原来不一样：静止判定每帧比较相机矩阵，会认为画面一直在变，超采样永远开始不了（或无限重来）。抖动时先存下 `aspect`，`fullWidth` 用 `aspect × 高`，恢复时先写回 `aspect` 再 `clearViewOffset()`（`PostPipeline.renderSample`）。
- **渲染目标纹理不要经 `materialReference` 长期挂在材质上**（2026-11-19，M3.4）：楼层 AO 起初把烘焙用的渲染目标纹理作为材质属性采样，实测 WebGPU、WebGL 两个后端都上下颠倒（直接 `texture(rt.texture)` 的后期 pass 没有这个问题），在 WebGPU 上手动翻转后又完全采不到；three 对渲染目标纹理的 y 翻转按纹理节点处理，对 `materialReference` 创建的节点不可靠。烘焙一次就长期使用的结果，用 `readRenderTargetPixelsAsync` 读回成 `DataTexture`，行序自己定（WebGPU 读回从画面顶行开始，WebGL 从底行，见 `FloorOcclusion.occlusionRows`）。
- **没有挂在渲染目标上的深度纹理会被当成多重采样**（2026-11-19，M3.9）：three 的 WebGPU 后端对 `texture.renderTarget` 为空的 `DepthTexture` 按渲染器当前的采样数（开 MSAA 时是 4）判断，于是认为它不可过滤、不生成采样器，着色器里 `textureSampleCompare` 编译失败（`unresolved value '..._sampler'`）。要当纹理采样的深度纹理一律挂在一个渲染目标上（`new RenderTarget(w, h, { depthTexture, count: 0 })` 是仅深度目标），占位的空图也一样。
- **放大已绑定的渲染目标，材质仍读旧纹理**（2026-11-19，M3.9）：阴影图起初以 1×1 创建、开阴影时再 `setSize` 到 2048，结果材质采样到的一直是旧的 1×1 清空值（深度全是 0，影子完全不出现，没有任何报错）。被材质长期绑定的渲染目标纹理不要改尺寸；要换尺寸就新建一个目标，让纹理对象本身变（节点的 `value` 换成新纹理，绑定会跟着更新）。
- **MRT 的输出按纹理名对应**（2026-11-19，M3.9）：`mrt({ accum, revealage })` 的名字要和渲染目标各纹理的 `name` 一致，对不上时生成的 WGSL 输出结构是空的（`structures must have at least one member`），整帧提交失败。
- **粗网格的面片中部在椭球面以下**（2026-11-19，P3.5 空气透视）：远处的 3D Tiles（全球视角下的 Google 3D Tiles）是几百个平面拼成的，面片中部比椭球面低几十公里。逐像素的空气透视原来沿视线积分到片元，不做地面求交，地下的样本密度是 exp(深度 / 标高)（Mie 在 73 km 深处约 e^60），每块瓦片都成了带彩色圆环的暗斑。现在积分到椭球面下 `AERIAL_GROUND_DEPTH_KM`（0.5 km）为止。逐像素按位置积分大气的效果都要做地面求交，不要假设片元在地面以上；地球瓦片是逐顶点、顶点在地面上，所以以前没暴露。
- **TSL `If` 的回调不要写成表达式箭头函数**（2026-11-24，体积云）：`If(c, () => x.assign(y))` 把赋值节点当成返回值，three 生成一条被注释掉的 `return`，并警告 "Return statement used in an inline Fn()"。回调一律写成块 `() => { x.assign(y); }`。
- **统计要取场景 pass 的**：后期管线和描边遮罩也会增加 `renderer.info` 的绘制数。拾取缓冲的签名和 `stats` 用 `scene.onAfterRender` 时记下的数，否则悬停改变描边就会让拾取缓冲失效。
- **MSAA 下按像素 discard 会漏出侧视的竖直面**（2026-11-18，局部场景）：片元丢弃对整个像素生效，像素横跨裁剪边界时，它覆盖的、其实在边界外的采样点也会画出来。朝向相机的面只差半个像素看不出，但被侧视成一条线的竖直面（瓦片裙边穿过边界），一个像素沿面能跨几十米，在侧壁上显出白色竖向点线。把侧壁外移、改 centroid 插值都没用；现在的遮罩只保留"到边界的距离 > 像素在区域坐标里覆盖范围的一半（`fwidth`）"的片元。新增按位置 discard 的遮罩时同样处理。
- **约束相机时沿直线拉回会让相机下沉**（2026-11-18，局部场景）：把相机朝地面上的中心点、或沿某点切平面拉回，每帧都会低一点，持续往外拖时一路滑到地面；绕地心平移到别的纬度，椭球半径不同，高度也会变。约束和受约束的平移都要保持椭球高（`holdInBounds`）。
- **泼溅的排序桶被离群点摊薄**（2026-11-22，M4.8）：three 的 `GaussianSplat` 按包围球的近端到远端均分 4096 个桶做计数排序。训练出来的场景常有几百米外的漂浮物，包围球被撑大后主体只占几十个桶，近处前后顺序错乱。图层把 `mesh.boundingSphere` 设成核心包围球 × 1.25，并关掉 three 的视锥剔除自己做（`SplatLayer.rebuild` / `update`）。给它换包围球时两件事要一起改。
- **`GaussianSplat` 没有 `dispose()`，WebGL 下每个存储缓冲还带一张纹理**（2026-11-22）：只释放 `geometry` / `material` 时，泼溅数据和排序缓冲都留在显存里；WebGL 后端的存储缓冲用纹理模拟（`attribute.pbo`），`attribute.dispose()` 也不带走它。实测移除图层后 `renderer.info.memory.total` 只增不减，直到把私有字段里的存储属性、它们的 `pbo`、计算节点逐个释放（`disposeGaussianSplat`）。升级 three 后复测这一项。
- **泼溅拾取用均匀网格会退化成暴力遍历**（2026-11-22）：同一场景里泼溅尺寸跨几个数量级，按多数小泼溅定格子，大的只能进"每条射线都查"的名单；狮子场景 62% 的泼溅进了名单，每条射线约 2 ms。换成盒子按每个泼溅真实范围算的 BVH 后是 0.01–0.07 ms（`splatIndex.ts`）。
- **泼溅颜色不转线性会整体发白**（2026-11-22）：泼溅颜色是显示空间的值，three 的 `GaussianSplat` 原样输出；本仓库的场景 pass 是线性 HDR，之后还要转回显示空间，等于多做了一次 gamma。`SplatLayer` 在 `colorNode` 里先 `sRGBTransferEOTF`。
- **软件渲染下一帧超过 2 秒，视图永远不静止**（2026-11-22）：帧间隔超过 `RESUME_GAP_MS`（2 s）会被当成"页面恢复"而重画，所以 SwiftShader 上画一个十几万泼溅的场景时 `stats.still` 一直是 false。这不是图层在请求重画（用 `?splatsMax=3000` 这样的小预算验证收敛）；冒烟测试里的泼溅场景要小。
- **本容器（云端开发环境）里无头 Chromium 的 WebGPU 出不了图**（2026-11-22）：交换链纹理建不出来，设备随即丢失，演示应用的基线也一样（控制台刷 `createBuffer failed … mappedAtCreation`）。有界面模式可以：`xvfb-run -a npx playwright test --project demo-webgpu --headed`（配 `SMOKE_NO_GPU=1`）。WebGL 项目无头正常。本机和 CI 不受影响。
- **绑定内容让模型让位，要等内容真的在屏幕上**（2026-11-23，层级绑定）：懒加载的实景在下载期间还没有画面，如果一进层级就把模型隐去，会有几秒什么都看不到。`entityOpacity` 只在绑定的 `showing()`（图层已就绪且可见）为真时生效。同理它是独立于 `levelOpacity` 的系数（`bindingOpacity`）：房间层级的"同级半透明"每次进入都会把兄弟的 `levelOpacity` 重写成绝对值，借用它会被覆盖。
- **换绑坐标系时不能直接沿用本地坐标**（2026-11-23）：图层在实体 A 的坐标系里的位置，原样拿到实体 B 的坐标系里是另一个地方。`setLevel` 换实体并跟随时先退回地理位置（`leaveFrame`）再进入新的坐标系（`enterFrame`），heading 同时加减两个坐标系 +Y 的朝向。
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

- `.github/workflows/ci.yml`：推送到 main 和每个 PR 都跑。`verify`（Node 22、24）：typecheck、分层检查、单测、库构建与类型声明、演示与示例构建；`package`（打包与浏览器冒烟，一个 job 共用同一份构建）：库构建、`check-package --keep-host`（打包检查并保留宿主构建），把 tgz 存为工作流产物，再构建演示应用和示例、用 Playwright 自带的 Chromium 跑 `npm run smoke`（无 GPU：WebGL 经 ANGLE、WebGPU 经 Dawn 的回退适配器，都走 SwiftShader），失败时把 `test-output/` 存为产物；冒烟不重试。CI 跑在 Linux 上，文件名大小写必须和 import 一致。
- `.github/workflows/pages.yml`（2026-11-25）：文档站点。推送到 main 时 `npm run site:build`（手册、API 参考、示例、演示应用）并发布到 GitHub Pages（`https://yoy0o.github.io/TerraView/`），PR 只构建不发布。站点跟随 main，可能写到还没发布的功能。首次使用要在仓库 Settings → Pages 把 Source 设为 "GitHub Actions"。
- `.github/workflows/release.yml`：推送标签 `v<版本>`（必须等于 `package.json` 的 `version`）时触发：验证、打包自检、创建 GitHub Release 并附 tgz（版本号带 `-` 的标为预发布）。发布到 npm 这一步只在 `package.json` 没有 `"private": true` 时执行（2026-11-25 已去掉）；认证优先用仓库密钥 `NPM_TOKEN`，没有时用 trusted publishing（OIDC，npm 上为包配置 GitHub Actions 的 `release.yml` 并允许直接 `npm publish`；新配置要在 2 天内完成首次发布，所以发版前再配）。npm 计划 2027 年 1 月取消令牌直接发布，届时只能走 OIDC。版本号带 `-` 的发到 `next` 标签。发布后从 registry 核对版本：`npm publish` 成功退出、版本却只进了 npm 的暂存区（staged，0.2.0 就是这样，需要在 npmjs.com 用 2FA 批准）时这一步失败；批准后重跑工作流即可，已存在的 Release 和 npm 版本会跳过。手动运行（workflow_dispatch）是演练，不创建 Release、不发布。
- 发版步骤：改 `package.json` 的 `version`（`package-lock.json` 里的两处同步）→ 把 CHANGELOG 的「未发布」整理成该版本（打标签当天填日期）→ 写发布说明 `docs/releases/v<版本>.md`（GitHub Release 的正文，面向使用者：概览、升级须知、兼容性；链接写成指向该标签的绝对地址）→ 合并到 main → 在 Actions 页面手动运行一次 Release（演练）→ 打标签并推送。打标签和推送要先得到明确同意。0.2.0 于 2026-11-25 发布（roadmap §0.2 P1.7）。
- 包名 `terra-viewer`（2026-11-25 由 `terra-view` 改来：npm 上已有 `terraview`，npm 不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，`terra-view` 会撞上；`terra-viewer` 去掉连字符后是 `terraviewer`，没有人注册）。改包名要同时改 `package.json`、`package-lock.json`、`tsconfig.json` 的 `paths`、两份 Vite 配置的别名、`demo/` 和 `scripts/host-fixture/` 里的 import，以及文档。
