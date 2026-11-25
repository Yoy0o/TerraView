# 相机与导航

这一章讲怎么用代码控制视角：设置和读取视点、几种飞行、不带界面的导航命令（给你自己的按钮用）、开场动画与自动旋转，以及怎样调整或关掉用户的手势。

相机有两条始终成立的规则：**永远零滚转**（地平线保持水平），**任何用户输入都会打断正在进行的相机运动**（飞行、环绕、动画、惯性）。下面的 API 都遵守这两条，所以不要绕过它们直接改 `viewer.camera`，见本章最后一节。

## 视点

视点 `ViewPosition` 用度和米描述相机本身的位置和朝向：

| 字段 | 单位与约定 |
| --- | --- |
| `longitude`、`latitude` | 度 |
| `height` | 相机的 WGS84 椭球高，米 |
| `heading` | 度，自正北顺时针；不给时为 0 |
| `pitch` | 度，水平为 0、向下为负，-90 是垂直俯视；不给时为 -90 |

```ts
const viewer = await GeoViewer.create({
  container,
  imagery,
  initialView: { longitude: 116.391, latitude: 39.885, height: 3500, heading: 0, pitch: -40 },
  homeView: { longitude: 116.391, latitude: 39.885, height: 3500, heading: 0, pitch: -40 }, // navigation.home() 回到这里，默认同 initialView
});

viewer.setView({ longitude: 121.4996, latitude: 31.2397, height: 2600, heading: 300, pitch: -35 }); // 立即跳过去
const v = viewer.getView(); // 五个字段都有值；heading 在 [0, 360)
```

相机每动一帧，`viewer.controller.events` 发一次 `change`；用户开始拖动、滚轮、按键、触摸时发 `interactionstart`。要把视点同步到地址栏或状态栏，监听 `change` 即可（演示应用把它写进 URL 的 `#经度,纬度,高度,航向,俯仰`）。

## 飞行

飞行都返回 Promise：飞到终点时 resolve，被手势或别的相机命令打断时也 resolve（不 reject）。时长单位是秒，不给时按距离自动决定。

| 方法 | 用途 |
| --- | --- |
| `flyTo(视点, 时长?)` | 飞到一个视点。远距离沿大圆弧线飞，高度先升后降 |
| `flyToTarget({ target, heading, pitch, range, duration })` | 从给定航向、俯仰、距离（米）看一个点：`target` 是经纬度（度，`height` 可省略为 0）或 ECEF 点；`heading` 不给时保持当前航向，`pitch` 默认 -45，`range` 默认 500 |
| `flyToBBox([西, 南, 东, 北], 时长?)` | 俯视框住一个经纬度范围（度），常用于 GeoJSON 图层的 `ready` 事件 |
| `flyToSphere(包围球, 航向?, 俯仰?, 时长?, { rangeScale, minRange })` | 让一个包围球（ECEF，three.js `Sphere`）填满画面，航向、俯仰用度（默认 -30、-35） |
| `flyToEntity(实体, { heading, pitch, rangeScale, duration })` | 取景建筑、楼层、房间或设备，见[建筑、层级与实体](./indoor.md) |

```ts
await viewer.flyTo({ longitude: 121.4996, latitude: 31.2397, height: 2600, heading: 300, pitch: -35 });
await viewer.flyToTarget({ target: { longitude: 116.3966, latitude: 39.9929, height: 50 }, heading: 210, pitch: -30, range: 900 });
viewer.flyToBBox([116.08, 39.69, 116.71, 40.18]);
```

`flyToTarget`、`flyToSphere`、`flyToEntity` 给出了注视点：相机移动不到 5 km 时改用"注视飞行"，绕着主体转过去，主体始终在画面里，适合在同一片园区、同一栋楼里切换视角。图层自己也有飞行方法，如 `SplatLayer.flyTo()`。

要中途停下飞行，调用 `viewer.controller.cancelFlight()`。

## 导航命令

`viewer.navigation`（`NavigationControls`）是一组不带界面的导航命令，用来做你自己的按钮条。它们都经过相机控制器，和手势是同一套运动（平滑、保持零滚转、缩放时保持航向和俯仰），任何手势都会打断它们。

| 方法 / 属性 | 作用 |
| --- | --- |
| `zoomIn(factor = 2)`、`zoomOut(factor = 2)` | 向屏幕中心的地面缩放，距离变为 1/factor 或 factor 倍 |
| `rotate(度)` | 绕屏幕中心的地面点转航向，正数顺时针，用时 `turnDuration`（默认 0.6 秒） |
| `tilt(度)`、`setPitch(俯仰)` | 绕屏幕中心点改俯仰（`tilt` 正数抬向地平线），受 `controller.pitchRangeDeg` 限制 |
| `toggleTilt()`、`isTopDown` | 俯视 ↔ 45° 倾斜（2D / 3D 切换） |
| `resetNorth()` | 转回正北朝上（指北针），等同 `viewer.resetNorth()` |
| `home(时长?)`、`homeView` | 飞回初始视角；`homeView` 可以随时改。局部场景中回到区域总览 |
| `startAutoRotate()`、`stopAutoRotate()`、`toggleAutoRotate()`、`isAutoRotating`、`autoRotateMode` | 自动旋转，见下 |
| `playIntro(选项?)`、`stopIntro()`、`isIntroPlaying` | 开场动画，见下 |
| `toggleFullscreen()`、`isFullscreen` | 让 viewer 的容器全屏 |
| `screenshot(type?, quality?)` | 当前三维画面的 `Blob`（默认 PNG）。HTML 顶牌、你的面板在画布之上，不在截图里 |

```ts
zoomInButton.onclick = () => viewer.navigation.zoomIn();
compassButton.onclick = () => viewer.navigation.resetNorth();
modeButton.onclick = () => viewer.navigation.toggleTilt();
shotButton.onclick = async () => download(await viewer.navigation.screenshot());
```

按钮的状态（指北针角度、2D / 3D 图标）从 `viewer.getView()` 读，在 `controller.events` 的 `change` 里刷新。

### 自动旋转

`startAutoRotate()` 按当前视角选择行为，`autoRotateMode` 可以提前读到它会做什么（用来决定按钮是否可用）：

| 模式 | 什么时候 | 行为 |
| --- | --- | --- |
| `globe` | 全球视角：屏幕中心 200 km 以内没有地面，相机也高于 200 km | 绕地轴匀速自转，纬度、航向、俯仰不变 |
| `orbit` | 屏幕中心的地面离相机不超过 200 km，且不是俯视 | 绕该点匀速环绕 |
| `tilt-orbit` | 同上，但正在俯视（俯仰比 -75° 更陡） | 先倾斜到 -45° 再环绕（俯视时原地转圈没有立体感） |
| `none` | 低空看天空或远处地平线 | 不可用 |

距离、转速、倾斜角都在 `navigation.autoRotate` 里（`orbitMaxDistance`、`orbitDegreesPerSecond`、`globeDegreesPerSecond`、`tiltBeforeOrbit` 等，默认值见导出的 `AUTO_ROTATE_DEFAULTS`），`autoRotate.filter` 可以按业务否决（例如只允许在建筑里环绕）。任何手势都会停止自动旋转。

只想绕某个点转，用 `viewer.startAutoOrbit({ pivot, degreesPerSecond, totalDegrees })`（`pivot` 是 ECEF 点，不给时用屏幕中心的地面；枢轴离相机超过 `orbitMaxDistance` 时什么都不做）和 `viewer.stopAutoOrbit()`。

### 开场动画

`viewer.playIntro(选项?)`（同 `navigation.playIntro`）让地球向东自转、逐渐减速，**停在当前视角上**。所以先设好视点再播放：

```ts
const viewer = await GeoViewer.create({ container, imagery, initialView: { longitude: 108, latitude: 33, height: 1.75e7 } });
const finished = await viewer.playIntro({ duration: 6, speed: 40 }); // 播完为 true，被打断为 false
```

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `duration` | 6 | 秒，从开始到静止 |
| `speed` | 40 | 起始转速，度经度 / 秒；负数反向 |
| `slowdown` | `duration` 的 60% | 秒，末段减速的时长 |
| `zoomFrom` | 1.3 | 起始高度是终点的几倍，1 = 不变 |
| `minHeight` | 2,000,000 | 米，相机低于它时跳过（绕地轴转一个近景会扫过整个大陆） |
| `force` | false | 低于 `minHeight` 也播放 |

动画期间用户一拖动、一滚轮就会停下。系统开了"减少动态效果"时，应用最好不要自动播放（`matchMedia('(prefers-reduced-motion: reduce)')`），演示应用就是这样做的。

## 手势与键盘

用户的操作由相机控制器 `viewer.controller`（`GlobeCameraController`）处理：

| 输入 | 行为 |
| --- | --- |
| 左键拖动 | 抓住地面平移，光标下的点始终跟手，松手有惯性 |
| 滚轮 / 双指捏合 | 向光标处缩放，保持航向和俯仰 |
| 右键、中键或 Ctrl / Shift + 左键拖动 | 横向调航向，纵向调俯仰，默认绕屏幕中心的地面点 |
| 双击 | 飞近该点；室内会先尝试进入建筑 / 楼层 / 房间 |
| W A S D / 方向键、Q E、R F | 沿地面移动、转航向、调俯仰（只在 viewer 有焦点时） |

控制器上的开关和限制可以随时改：

| 属性 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | true | 总开关，关掉后所有手势和键盘都不响应（代码驱动的相机运动不受影响） |
| `enablePan`、`enableRotate`、`enableTilt`、`enableZoom`、`enableKeyboard` | true | 分别开关平移、航向、俯仰、缩放、键盘 |
| `pitchRangeDeg` | `[-90, -2]` | 右键倾斜、`tilt` 允许的俯仰范围（度）：[最俯视, 最接近水平]。例如 `[-90, -30]` 不让用户压到接近地平线 |
| `minimumAltitude` | 1.5 | 离地高度下限，米 |
| `maximumDistance` | 6e7 | 到地心的距离上限，米 |
| `orbitPivot` | `'center'` | 右键环绕绕屏幕中心点，或 `'cursor'` 绕光标处 |
| `inertia`、`zoomSpeed`、`rotateSpeed` | true、1、1 | 惯性与手感 |

```ts
// 只允许看，不允许倾斜到地平线附近，也不允许用键盘
viewer.controller.pitchRangeDeg = [-90, -30];
viewer.controller.enableKeyboard = false;
```

**键盘焦点**：键盘只在焦点位于 viewer 内时生效，SDK 不监听 `window`，所以页面上的输入框和别的快捷键不受影响，同页多个 viewer 也互不干扰。点击画布或顶牌会让 viewer 获得焦点；要页面一打开就能用键盘，调用 `viewer.canvas.focus()`。带 Ctrl / Meta / Alt 的组合键不处理。Esc 返回上一级之类的全局快捷键属于应用，自己在 `window` 上注册。

**双击**：不要改 `controller.doubleClickHandler`，viewer 用它把双击交给 `viewer.interaction`（室内进入层级就是这样做的）。要取消"双击飞近"，在交互事件里阻止默认行为：

```ts
viewer.interaction.on('dblclick', (e) => e.preventDefault(), { tag: 'app' });
```

详见[交互、拾取与事件](./interaction.md)。

## 脚本化的相机运动

需要一段自定义的镜头（巡航、环绕展示）时，用控制器的三个原语，而不是自己在 `requestAnimationFrame` 里改相机：

| 方法 | 作用 |
| --- | --- |
| `zoomBy(amount, ndc?)` | 程序缩放，和滚轮同一套运动。`amount` 是对数距离系数：相机最终距离为原来的 e^(-amount) 倍（`Math.log(2)` 减半，`-Math.log(2)` 加倍）；`ndc` 是缩放中心的屏幕坐标（-1..1，默认屏幕中心） |
| `orbitBy(dHeading, dTilt, duration = 0.6, pivot?)` | 程序环绕：航向转 `dHeading`、仰角抬高 `dTilt`（**弧度**），倾斜受 `pitchRangeDeg` 限制；`pivot` 默认屏幕中心的地面 |
| `playAnimation(step)` | 脚本动画：每帧调用 `step(dt, camera)`（`dt` 秒），由它直接写相机的位置和朝向，返回 false 时结束。Promise 在播完时 resolve 为 true，被任何手势或相机命令打断时为 false |

`playAnimation` 的回调里用 ECEF 和弧度写位姿，朝向用 `orientationFromHeadingPitch` 生成（保证零滚转）：

```ts
import { DEG2RAD, orientationFromHeadingPitch } from 'terra-viewer';

let t = 0;
const finished = await viewer.controller.playAnimation((dt, camera) => {
  t = Math.min(t + dt, 20);
  const lat = (39.8563 + (0.0743 * t) / 20) * DEG2RAD; // 20 秒内向北移动约 8 km
  viewer.ellipsoid.cartographicToCartesian(116.3975 * DEG2RAD, lat, 650, camera.position);
  orientationFromHeadingPitch(viewer.ellipsoid, camera.position, 0, -25 * DEG2RAD, camera.quaternion);
  return t < 20;
});
```

回调里不要调用控制器的其他方法（`flyTo`、`orbitBy` 等），它们会先取消这段动画本身。`orientationFromHeadingPitch` 和 `getHeadingPitch` 一组相机数学函数是高级 API，参数和返回值都是弧度。

## 活动范围

`viewer.controller.bounds`（`CameraBounds`，高级）把相机限制在一块区域周围：视线不离开区域、不超过最远距离、平移时保持高度。[局部场景](./local-scene.md)进入时会自动设置它，一般不需要自己构造；需要时实现接口的 `center`（ECEF）、`referenceHeight`（米）、`maxRange`（米）和 `clampFocus(point, out)`，置 `null` 取消。飞行和脚本动画期间不受限制，结束后才生效。

## 不要直接改相机

`viewer.camera` 是 three.js 的 `PerspectiveCamera`（高级 API），可以读它做投影计算（例如把 ECEF 点换算成屏幕坐标来摆放你自己的 DOM），但**不要写它的 `position` / `quaternion`**：

- 正在进行的飞行、惯性、自动旋转会在下一帧覆盖你的改动；反过来，控制器不知道你在动相机，用户的手势打断不了你的运动；
- 自己写出的朝向很容易带上滚转，或者在俯视时航向跳 180°（航向必须用 `getHeadingPitch` 求，不能用视线的水平分量）。

要定位就用 `setView` / `flyTo*`，要连续运动就用 `playAnimation`，要交互式的镜头就用 `navigation` 的命令。

<ExampleFrame id="camera" />

示例源码：[examples/camera/main.ts](../../examples/camera/main.ts)。相机控制器的手势数学和不变量见 [camera-controller.md](../agents/camera-controller.md)，开场动画与导航命令的设计见 [intro-and-navigation.md](../agents/intro-and-navigation.md)。
