# 简介

TerraView 是一个基于 three.js 的三维地球 SDK，npm 包名 `terra-viewer`。宿主应用提供一个容器元素，通过 `GeoViewer` 使用全部能力：

- **地球**：WGS84 椭球、四叉树影像与全球地形、半透明叠加层，物理大气、星空、昼夜与晨昏。
- **数据图层**：OGC 3D Tiles（含 Cesium ion、Google 真实感 3D Tiles）、高斯泼溅（`.ply` / `.splat` / `.spz`）、GeoJSON 矢量与注记、HTML 顶牌与点位标注。
- **室内与 BIM**：用一份 JSON 建筑文档描述建筑、楼层、房间、设备，从地球双击逐级进入，右键返回；按选择器查询实体、批量改样式、描边与发光。
- **场景与画面**：光照跟随大气、建筑的日照阴影、云壳与体积云、局部场景（沙盘）、调色、静止超采样。
- **交互与运行**：统一的单击 / 双击 / 右键 / 悬停事件与拾取，加载状态与错误码，画面静止后停画省电，同页多个 viewer、完整释放。

渲染以 WebGPU 为先（three.js 的 `WebGPURenderer`，着色器全部用 TSL 写），浏览器不支持 WebGPU 时自动回退 WebGL 2。

## 这本手册怎么读

手册面向在自己的应用里接入 TerraView 的前端开发者，按"先能跑起来，再逐项加功能"的顺序编排：

| 你想做的事 | 从这里开始 |
| --- | --- |
| 第一次接入，看到地球 | [快速开始](./getting-started.md) → [基本概念](./concepts.md) |
| 在 React / Vue 组件里使用、多个 viewer、销毁 | [创建、容器与释放](./viewer.md) |
| 控制视角、做飞行动画和导航按钮 | [相机与导航](./camera.md) |
| 换底图、加地形、叠加注记图层 | [影像、叠加层与地形](./imagery-terrain.md) |
| 加载倾斜摄影、城市白模、BIM 导出的 3D Tiles | [3D Tiles](./tiles3d.md) |
| 在地图上画面、线、点和注记 | [GeoJSON 矢量与注记](./vector.md) |
| 在地图上放标签、告警卡片、成千上万的点位 | [顶牌与点位标注](./markers.md) |
| 放一个实景扫描的高斯泼溅场景 | [高斯泼溅](./splats.md) |
| 做园区、楼宇的室内浏览 | [建筑、层级与实体](./indoor.md)，数据格式见[建筑数据制作手册](../building-data-manual.md) |
| 让画面有真实的太阳、阴影、云 | [光照、大气、阴影与云](./environment.md) |
| 只展示一块区域，做成沙盘 | [局部场景](./local-scene.md) |
| 把自己的 three.js 模型放到地球上，加描边、调色 | [描边、调色与自定义对象](./effects.md) |
| 响应点击、悬停，拿到点击处的坐标 | [交互、拾取与事件](./interaction.md) |
| 显示加载进度、处理错误、控制功耗和显存 | [加载、错误与性能](./performance.md) |

每章末尾都有一个可以直接运行的示例，源码在仓库的 [`examples/`](../../examples/) 目录，只用公共 API 编写。全部示例见[示例列表](https://yoy0o.github.io/TerraView/examples/)，完整的产品形态可以看[在线演示](https://yoy0o.github.io/TerraView/demo/)（[演示应用](./demo-app.md)一章介绍它的操作和 URL 参数）。

逐项的 API 说明在 [API 参考](../api.md)。手册讲用法和取舍，参考讲全部选项、取值范围和实现上的代价，两边互相链接。

## 版本与稳定性

当前版本 0.2.0（[发布说明](../releases/v0.2.0.md)）。0.x 阶段次版本号可以有破坏性变更，每次变更都记在 [CHANGELOG](../../CHANGELOG.md) 里。公共 API 分三级（[基本概念](./concepts.md#api-分级)）：**稳定**的部分尽量不破坏，**高级**的部分直接接触 three.js 对象、可能随次版本调整，**内部**的部分不在类型声明里。

这份手册跟随仓库的 `main` 分支更新，可能包含还没有发布的内容；与最新发布版本的差别见 CHANGELOG 的「未发布」一节。

## 许可

Apache-2.0。移植自 CesiumJS、t3d.js 等项目的代码保留了原版权声明，见 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。地图影像、地形、3D Tiles 等数据服务有各自的使用条款，接入时请按服务商要求显示署名；示例中国界一类的数据不是审定地图，在中国境内发布须使用有审图号的数据。
