# 开场动画、云层与基础导航控制

> 2026-11-09 插单（任务 T261109-mez）。三项功能都按"核心 API + 演示界面"拆开：核心在 `src/viewer/`、`src/atmosphere/`，不依赖 `demo/ui/`；演示界面只调用核心 API，以后按 [roadmap.md](roadmap.md) §10 打包 SDK 时可以整体留在示例里。

## 1. 分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 相机原语 | `viewer/GlobeCameraController.ts` | `playAnimation(step)`（脚本动画）、`zoomBy(amount, ndc?)`（程序缩放）、`orbitBy(dHeading, dTilt, duration?, pivot?)`（程序环绕 / 倾斜）、`isAnimating`、`stopAnimation()` |
| 开场动画 | `viewer/IntroAnimation.ts` | 速度曲线（纯函数 `introSpinProfile` / `introSpinAngle` / `introHeightScale`）和 `playIntroSpin(host, options)` |
| 导航命令 | `viewer/NavigationControls.ts`（`viewer.navigation`） | 放大、缩小、旋转、倾斜、俯视切换、指北、回到初始视角、环绕、全屏、截图、开场动画 |
| 云层 | `atmosphere/CloudLayer.ts`（`viewer.clouds`） | 云壳网格、TSL 材质、漂移、按相机高度淡出 |
| 演示界面 | `demo/ui/NavigationBar.ts`、`demo/ui/ControlPanel.ts`（场景一节）、`demo/ui/urlOptions.ts`、`demo/main.ts` | 按钮条、面板开关与滑块、URL 参数解析、启动时播放 |

## 2. 开场动画

**效果**：页面打开时，相机从初始视角以东出发，沿纬线向西移动（地球看起来向东自转），开始时略高，逐渐降到初始高度，若干秒后减速停在初始视角上。

**做法**：
- 动的是相机，不是地球：世界坐标始终是 ECEF，太阳位置不受影响。每帧按经度、纬度、高度和固定的航向、俯仰重建位姿（`orientationFromHeadingPitch`），所以零 roll、俯视不翻转。
- 速度曲线：先以 `speed` 匀速，最后 `slowdown` 秒按 `speed·(1−s)²` 减速到 0，速度连续；总转角 `speed·(duration−slowdown) + speed·slowdown/3` 是闭式的，起点就是"终点以东总转角处"，所以一定停在初始视角。
- 高度：`1 + (zoomFrom − 1)·r²`，r 为剩余转角占比，随转速一起落定。
- 通过控制器的 `playAnimation` 运行：任何手势（拖动、滚轮、按键、触摸）、`flyTo`、`setView`、`zoomBy`、`orbitBy` 都会立即中断它（Promise 解析为 false）。动画期间 `syncHash` 不写 URL。
- 低于 `minHeight`（默认 2,000 km）的视角跳过：绕地轴转一个近景会扫过整个大陆。`force: true` 可强制播放（"重播"按钮就是这样）。

**选项** `IntroSpinOptions`：

| 字段 | 默认 | 单位 / 含义 |
| --- | --- | --- |
| `duration` | 6 | 秒，从开始到静止 |
| `speed` | 40 | 度经度 / 秒，起始转速；负数反向 |
| `slowdown` | `duration` 的 60 % | 秒，末段减速时长 |
| `zoomFrom` | 1.3 | 起始高度倍数，1 = 不变 |
| `minHeight` | 2,000,000 | 米，低于此高度跳过 |
| `force` | false | 低于 `minHeight` 也播放 |

**API**：`viewer.playIntro(options?)` / `viewer.navigation.playIntro(options?)` → `Promise<boolean>`；`navigation.stopIntro()`；`navigation.isAnimating`。

**演示应用的规则**（`demo/main.ts`）：面板"开场动画"开关（保存在本机设置）决定是否在启动时播放；`?intro=0|1` 本次覆盖设置；`?demo`、`?building`、`?tileset`、`?geojson`、`?points` 启动后会飞走，默认不播放（除非 `?intro=1`）；系统设置了"减少动态效果"时默认不播放。

## 3. 云层

**效果**：影像上方约 10 km 处的一层云，向东漂移，形状缓慢变化；开启太阳光照时夜半球变暗、晨昏线附近偏暖；相机降到约 500 km 以下开始淡出，60 km 以下完全不画（省掉整层的片元开销）。

**做法**：
- 网格：经纬网格单位球（+Z 北极，面朝外），`mesh.scale` 设为椭球半径加云层高度。顶点是单位长度的 float32，放大由 float64 的模型矩阵完成（`highPrecision`），误差约 0.4 m。
- 程序云（默认）：在单位球方向上采样 MaterialX 分形噪声（`mx_fractal_noise_float`），没有接缝和极点收缩，不需要贴图素材。两层噪声以不同速度绕地轴旋转，叠加后形状会变；再按纬度加一点气候带（副热带少云、赤道和高纬多云）。`coverage` 控制阈值。
- 云图（可选）：`textureUrl` 指向等距圆柱投影的云图（左边缘为经度 -180°，上为北）。密度取 RGB 最大值乘 alpha，灰度 JPEG 和带透明度的白色 PNG 都能用；`coverage` 0.5 时按原图显示。漂移通过 u 偏移 + `RepeatWrapping` 实现。加载失败时退回程序云。
- 噪声按像素限带（`bandLimitedFbm`）：用 `fwidth` 求每像素在单位球上的跨度，每个八度按"每像素周期数"加权，≤ 1/4（每周期 4 px 以上）全保留，≥ 1/2（2 px，奈奎斯特极限）去掉（`OCTAVE_FADE`）。Perlin 噪声均值为 0，去掉八度不改变云量。不这样做时，默认全球视角下最细的八度只有约 2 px 一个周期，阈值化后的云边在缩放（画面整体缩放）和漂移时闪烁、爬动，看起来就是"画面抖动"（见 §7）。
- 只用 TSL；透明、不写深度、做深度测试，`renderOrder = 10`。只画外表面：相机在云层以下时什么都不画（此时也已淡出）。
- 漂移角在 CPU 上累加并对 2π 取模，长时间运行也不会丢精度。

**选项** `CloudOptions`（`viewer.clouds.set(...)`，或创建时 `GeoViewer.create({ clouds })`）：

| 字段 | 默认 | 单位 / 含义 |
| --- | --- | --- |
| `visible` | false | 核心默认不显示；演示应用默认显示 |
| `coverage` | 0.5 | 0–1，云量 |
| `opacity` | 0.9 | 0–1，最厚处不透明度 |
| `speed` | 0.5 | 度经度 / 秒，向东漂移；负数向西，0 静止 |
| `height` | 10,000 | 米，云层椭球高（0–100 km） |
| `fadeHeights` | [60 km, 500 km] | 米，相机高度低于前者隐藏、高于后者完全显示 |
| `textureUrl` | null | 等距圆柱云图 URL；null = 程序云 |

非法值（NaN、越界、空字符串）被丢弃或夹紧（`normalizeCloudOptions`）。`clouds.visible` 是 `set({ visible })` 的简写，`clouds.getOptions()` 返回当前设置的副本。

**成本**：程序云每个片元最多 10 个噪声八度（远处被限带的八度权重为 0，但仍会计算）。实测（WebGPU、RTX 40 系、1918×945）开关云层的 GPU 时间差在 1 ms 左右，与帧间波动同一量级；高 DPI 屏像素数翻 4 倍，集成显卡吃紧时可改用云图（每片元一次采样）或关闭。

## 4. 基础导航控制

`viewer.navigation`（`NavigationControls`）的命令都经过控制器，相机不变量保持不变（零 roll、缩放保持航向与俯仰、环绕不越过枢轴头顶），任何手势都会打断正在进行的命令：

| 方法 | 作用 |
| --- | --- |
| `zoomIn(factor = 2)` / `zoomOut(factor = 2)` | 向屏幕中心的地表缩放，距离变为 1/factor 或 factor 倍；与滚轮同一套 `zoomTowards`（平滑、保持航向俯仰、中心点不漂移） |
| `rotate(degrees)` | 绕屏幕中心的地表点改航向（正数顺时针），时长 `turnDuration`（0.6 s） |
| `tilt(degrees)` / `setPitch(pitch)` | 绕屏幕中心点改俯仰，受 `controller.pitchRangeDeg` 限制 |
| `toggleTilt()`、`isTopDown` | 俯视 ↔ 45° 倾斜 |
| `resetNorth()` | 指北（同指北针） |
| `home(duration?)`、`homeView` | 飞到初始视角（`GeoViewer.create({ homeView })`，默认 `initialView`） |
| `startAutoRotate()` / `stopAutoRotate()` / `toggleAutoRotate()`、`isAutoRotating`、`autoRotateMode` | 自动旋转：按当前视角选行为（见下），任何操作即停止 |
| `autoRotate`（`AutoRotateSettings`） | `orbitMaxDistance`（200 km）、`topDownPitch`（-75°）、`tiltBeforeOrbit`（-45°，null = 不倾斜）、`orbitDegreesPerSecond`（12）、`globeDegreesPerSecond`（6）、`globeMinHeight`（100 km）、可选 `filter(ctx)` |
| `orbitPivot(pivot?)` | 自动环绕可用的枢轴（距相机不超过 `orbitMaxDistance`），否则 null |
| `playIntro(options?)`、`stopIntro()`、`isAnimating`、`introOptions` | 开场动画 |
| `toggleFullscreen()`、`isFullscreen` | 容器全屏 |
| `screenshot(type?, quality?)` | 当前三维画面的 `Blob`（默认 PNG）；HTML 顶牌、面板不在其中 |

**自动旋转按视角选行为**（`classifyAutoRotate`，纯函数）：

| 模式 | 条件 | 行为 |
| --- | --- | --- |
| `globe` | 屏幕中心没有 `orbitMaxDistance` 以内的地表，且相机高于 `max(orbitMaxDistance, globeMinHeight)` | 绕地轴匀速自转（相机向西，纬度、航向、俯仰不变）。转速 `globeDegreesPerSecond` 在 10,000 km 以上全速，以下按高度等比降低，画面移动速度相近 |
| `orbit` | 屏幕中心地表距相机不超过 `orbitMaxDistance`，且不是俯视 | 绕该点匀速环绕（原有行为） |
| `tilt-orbit` | 同上，但俯仰陡于 `topDownPitch`（俯视 / 2D） | 先平滑倾斜到 `tiltBeforeOrbit`（受 `pitchRangeDeg` 限制），再环绕；俯视时直接环绕只是整张画面原地转 |
| `none` | 低空且屏幕中心没有近处地表（看天空、看远处地平线） | 不可用 |

为什么按"相机到枢轴的距离"而不是离地高度：低空倾斜看地平线时，中心点可能在几百公里外，绕它转相机会扫过一大片区域；距离才反映环绕的尺度。为什么不只看 2D / 3D：全球视角也能倾斜，那时绕中心点转同样会把地球甩起来，所以尺度判断在前、俯仰判断在后。

规则写在核心里：`GeoViewer.startAutoOrbit` 只在 `navigation.orbitPivot()` 有结果时启动（否则 Promise 立即解析）；`autoRotate.filter` 可以按业务否决（例如只允许在建筑里环绕）。按钮条和面板的按钮按模式显示"地球自转 / 环绕浏览"和对应提示，`none` 时置灰，运行中（含环绕前的倾斜）始终可以停止。任何手势都会结束自动旋转的每个阶段：倾斜途中被打断就不再接着环绕。`isAutoOrbiting` / `toggleAutoOrbit()` 保留为 `isAutoRotating` / `toggleAutoRotate()` 的别名（已弃用）。

屏幕中心没有地表（看向天空）时，`rotate` / `tilt` 退化为原地转动相机（`flyTo` 同一位置、新航向俯仰）。

`GeoViewer.captureFrame()` 同步渲染一帧并拷到新的 2D canvas：WebGL 的绘图缓冲只能在绘制它的同一任务里读取。层级切换过渡（`viewer.levelTransition`）不读画布，截帧留在 GPU 上（indoor-bim.md §7.1）。

**演示界面**：右下角指北针左侧的按钮条（`demo/ui/NavigationBar.ts`）：放大、缩小 │ 左转、右转、2D/3D │ 初始视角、环绕、重播开场 │ 全屏、截图。按钮状态每 10 帧刷新一次。面板的最大高度相应减为 `100% − 150px`，不与按钮条重叠。

## 5. URL 参数（演示应用，`demo/ui/urlOptions.ts`）

| 参数 | 取值 | 作用 |
| --- | --- | --- |
| `?intro` | `0` / `1`（也接受 `false` `off` / `true` `on`，裸参数为开） | 本次关闭 / 开启开场动画 |
| `?introDuration` | 0.5–120 秒 | 时长 |
| `?introSpeed` | -720–720 度/秒 | 起始转速，负数反向 |
| `?introZoom` | 1–10 | 起始高度倍数 |
| `?clouds` | `0` / `1` | 本次隐藏 / 显示云层 |
| `?cloudCoverage` / `?cloudOpacity` | 0–1 | 云量 / 不透明度 |
| `?cloudSpeed` | -90–90 度/秒 | 漂移速度 |
| `?cloudHeight` | 0–100000 米 | 云层高度 |
| `?cloudTexture` | http(s)、相对路径或 `data:image/` URL | 等距圆柱云图 |

越界或无法解析的值被忽略，不影响启动。例：`?intro=1&introDuration=8&introSpeed=60&clouds=1&cloudCoverage=0.65`。

局部场景（[local-scene.md](local-scene.md) §5.1）：`?region=circle:经度,纬度,半径km` / `rect:西,南,东,北` / `poly:经度,纬度;经度,纬度;…` 启动即进入（同时跳过开场动画），`?regionLook=sandbox|float|dim` 选外观。局部场景中 `navigation.home()` 回到区域总览。

## 6. 测试

- `tests/intro.test.ts`：速度曲线（闭式总转角、起始速度、单调、末端静止、越界夹紧、非法值回退）、高度倍数；`playIntroSpin` 每帧向西、纬度 / 航向 / 俯仰不变、零 roll、终点与初始视角误差小于 1 mm、近景跳过与强制；控制器 `playAnimation` 完成与被打断、`zoomBy` 距离与姿态、`orbitBy` 航向与枢轴不漂移、抬到俯视不越顶、压低受俯仰范围限制；URL 参数解析。
- `tests/clouds.test.ts`：选项夹紧与丢弃、高度淡出、云壳网格面朝外与 uv 约定、显隐与高度、长时间漂移、噪声八度限带权重。
- `tests/navigation.test.ts`：`classifyAutoRotate` 各模式与阈值（含按距离而非高度、`globeMinHeight` 下限）、`globeSpinRate`；用真实控制器验证全球自转保持纬度 / 俯仰并向西、俯视先倾斜到 -45° 再环绕、倾斜途中手势取消后续环绕、远处枢轴被拒绝、`filter` 否决。

浏览器手测：`?intro=1` 观察自转到停（终点等于 hash 视角）；滚轮或拖动立即打断；放大到 500 km 以下云层淡出；开"太阳光照"后夜半球云变暗；按钮条逐个点击。

## 7. 链路排查记录：缩放时"画面抖动"（2026-11-09，T261109-wj4）

现象：加入开场动画和云层后，放大缩小时画面像在抖。逐段排查：

1. **相机逻辑**：停掉渲染循环，手动按 60 fps 推进帧，滚轮缩放 60 帧，分别在云层开 / 关下记录每帧高度、航向、俯仰。两次轨迹完全相同，高度单调变化（反向次数 0），航向、俯仰不变。开场动画只在播放期间接管相机，滚轮先 `stopAnimation()`，缩放路径上没有它。结论：缩放本身没有抖。
2. **帧开销**：云层开 / 关 GPU 时间差约 1 ms，CPU 每帧 4–5 ms，无尖峰；按钮条每 10 帧刷新一次，只读相机状态。结论：不是掉帧导致的顿挫。
3. **精度**：云壳顶点为单位长度 float32，放大和平移在 float64 模型视图矩阵里完成，误差约 1 m；云层只在 60 km 以上可见，1 m 远小于一个像素。结论：不是精度抖动。
4. **着色器走样（根因）**：默认全球视角（1,750 万 m、945 px 高）地球半径约 290 px，原来 6 个八度、间隙 2.2 的噪声最高频约 134 周期 / 单位半径，即每周期约 2 px，已到奈奎斯特极限；阈值化（smoothstep + pow）又放大了高频。画面缩放时采样点相对像素网格移动，云边闪烁、爬动，看起来像整个画面在抖；云层漂移时同理。修复：按像素限带（§3），最细的八度在远处自动淡出，靠近时再出现。

## 8. 已知限制

- 云层没有投影到地面、没有体积感，也不参与空气透视；从侧面贴近地平线看时只是一层贴图。
- 截图不含 HTML 顶牌和注记 DOM。
- 自动化浏览器窗口被遮挡时帧率很低，控制器把每帧 dt 限制在 0.1 s，开场动画会按真实时间变慢；判断效果请在前台窗口看。
