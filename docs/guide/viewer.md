# 创建、容器与释放

这一章讲 viewer 的生命周期：创建时能传哪些选项、SDK 对你的容器做了什么、怎样调样式和键盘、显存档位怎么定，以及同页多个 viewer 和释放。

## 创建

```ts
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
});
```

`GeoViewer.create(options)` 先检查必填项，再按显卡确定显存档位、申请 GPU 设备（WebGPU，不支持时 WebGL 2），最后建好场景、开始渲染循环。它是异步的，失败时 Promise 被拒绝：

| 失败 | 表现 |
| --- | --- |
| `container` 不是元素、`imagery` 不是影像源 | 在申请 GPU 之前同步检查，抛 `TerraViewError`，`code: 'option-invalid'`，`details.option` 是出错的选项名 |
| 浏览器既没有 WebGPU 也没有 WebGL 2 | three.js 初始化渲染器失败的原始错误 |

### 全部选项

`GeoViewerOptions` 按用途分组如下。除了 `container` 和 `imagery`，其余都可以省略；大多数画质相关的默认值由显存档位决定（见下文"[显存档位](#显存档位)"）。完整说明见 [API 参考](../api.md)。

**必填**

| 选项 | 说明 |
| --- | --- |
| `container` | 放 viewer 的元素，任意有尺寸的元素（见下文"[容器](#容器)"） |
| `imagery` | 底图影像源（`ImageryProvider`），如 `findImageryPreset('esri-imagery')!.create()`。之后可以用 `viewer.globe.setImagery()` 换（高级） |

**视点**

| 选项 | 说明 |
| --- | --- |
| `initialView` | 初始视点 `{ longitude, latitude, height, heading?, pitch? }`（度、米）。默认是经度 110°、纬度 28°、高度 18,000 km 的整球视角 |
| `homeView` | `viewer.navigation.home()` 回到的视点，默认同 `initialView` |

**地球**

| 选项 | 说明 |
| --- | --- |
| `terrain` | 地形源，如 `AWS_TERRARIUM`；省略或 `null` 时没有地形（椭球面） |
| `terrainExaggeration` | 地形夸张倍数，默认 1 |
| `maxScreenSpaceError`、`maxCachedTiles`、`maxConcurrentLoads`、`fadeDuration`、`morphDuration` 等 | 瓦片调度的调参项（默认值已调好，缓存上限按档位给）。含义见 [tile-loading.md](../agents/tile-loading.md) |

**渲染后端与显存档位**

| 选项 | 说明 |
| --- | --- |
| `forceWebGL` | `true` 时跳过 WebGPU，直接用 WebGL 2 |
| `gpuTier` | 显存档位 `'low' \| 'medium' \| 'high' \| 'ultra'`。默认按显卡猜测（不会猜成 `ultra`） |
| `antialias` | 4x MSAA，默认按档位（`low` 关） |
| `maxPixelRatio` | 画布像素比的上限，默认按档位 1 / 1.5 / 2 / 2。高分屏上画布的显存和填充开销按它的平方增长 |

**解码器**

| 选项 | 说明 |
| --- | --- |
| `decoderPath` | Draco 解码器文件所在的文件夹 URL（以 `/` 结尾）。默认用你安装的 three.js 自带的那份 |
| `transcoderPath` | KTX2（Basis）转码器文件所在的文件夹 URL。默认同上 |

**语言**

| 选项 | 说明 |
| --- | --- |
| `locale` | `'zh-CN'`（默认）或 `'en'`：BIM 实体的自动属性名、房间顶牌副标题、点位图层默认名用哪种语言 |
| `messages` | 逐项改写上面的文字，如 `{ pointLayerName: '站点' }` |

**帧率与功耗**（见[加载、错误与性能](./performance.md#帧率与功耗)）

| 选项 | 说明 |
| --- | --- |
| `idleFrameRate` | 画面安静后每秒更新几次，默认 10；0 表示每帧都画（也不做静止超采样），其他值限在 10–60 |
| `supersampling` | 静止超采样，默认开；`false` 关闭，或 `{ enabled, samples }` |

**画面效果**（都可以创建后再改，见[光照、大气、阴影与云](./environment.md)、[描边、调色与自定义对象](./effects.md)）

| 选项 | 说明 | 之后改用 |
| --- | --- | --- |
| `colorGrading` | 曝光、对比度、饱和度，默认中性 | `viewer.colorGrading` |
| `shadows` | 建筑的日照阴影（开光照时），默认按档位（`low` 关） | `viewer.shadows` |
| `transparency` | 建筑透明表面的顺序无关混合（WebGPU），默认只在 `ultra` 开 | `viewer.transparency` |
| `ambientOcclusion` | 楼层环境光遮蔽，默认开 | `viewer.indoor.ambientOcclusion` |
| `clouds` | 云层设置；不写 `visible: true` 时云层隐藏 | `viewer.clouds` |
| `contributionCulling` | 室内小设备的贡献剔除，默认关 | `viewer.indoor.culling` |

## 容器

`container` 可以是任意有尺寸的元素，不必铺满窗口。viewer 在里面放一个 canvas（类名 `tv-canvas`，宽高 100%）和一层顶牌，尺寸变化由内部的 `ResizeObserver` 跟随，不需要你调用 resize。

::: warning 容器必须有高度
一个空的 `div` 默认高度是 0，画面什么都看不到。给容器设固定高度，或者让它在 flex / grid 布局里被撑开。
:::

创建时 viewer 对容器做三件事，`dispose()` 时一一还原（只改原来没有的）：

| 改动 | 原因 |
| --- | --- |
| 加类名 `tv-viewer` | 样式作用域，并让顶牌的 `z-index` 留在 viewer 内部（`isolation: isolate`） |
| `position` 是 `static` 时改成 `relative` | 顶牌层相对容器定位 |
| 没有 `tabindex` 时设为 `-1`（并去掉焦点轮廓） | 让容器能接收键盘事件 |

容器滚出视口或被 `display: none` 隐藏时，viewer 完全不画（`IntersectionObserver`），回到视口立刻恢复；这期间加载也不推进。

## 样式与主题

`terra-viewer/style.css` 只管 SDK 自己创建的元素，类名都以 `tv-` 开头，不依赖、也不影响页面的全局样式：

| 类 | 元素 |
| --- | --- |
| `.tv-viewer` | 容器 |
| `.tv-canvas` | 渲染用的 canvas |
| `.tv-marker-layer`（顶牌很多时加 `.tv-dense`） | 顶牌层，铺满容器，`position: absolute` |
| `.tv-marker`（`.tv-interactive`、`.tv-occluded`） | 单个顶牌的定位外壳 |
| `.tv-card` + `.tv-<样式名>`（`.tv-selected`） | 内置样式的顶牌内容 |

主题用 CSS 变量调，设在容器或任意祖先元素上：

```css
#map {
  --tv-font: 'HarmonyOS Sans SC', sans-serif; /* 顶牌字体 */
  --tv-text: #f1f5f9;                         /* 顶牌主文字颜色 */
  --tv-muted: #94a3b8;                        /* 顶牌次要文字颜色 */
  --tv-card-bg: rgba(15, 23, 42, 0.9);        /* 顶牌文字框背景 */
}
```

单个顶牌的强调色是 `--tv-accent`，由顶牌或点位样式的 `color` 选项设置。完全不想用内置样式时，给 `viewer.markers.add({ element })` 传你自己的 DOM 元素（[顶牌与点位标注](./markers.md)）。

面板、按钮、状态栏这些界面由你的应用自己做，SDK 不带。

## 键盘与焦点

相机快捷键（W A S D / 方向键平移，Q E 转向，R F 俯仰）**只在焦点位于 viewer 内时生效**，监听的是容器而不是 `window`：同页多个 viewer 互不干扰，页面上的输入框和你自己的快捷键也不受影响。带 Ctrl / Meta / Alt 的组合键不处理。

- 点击画面或顶牌会让 viewer 获得焦点。
- 要一打开就能用键盘：`viewer.canvas.focus()`。
- 关闭键盘控制：`viewer.controller.enableKeyboard = false`。
- Esc 返回上一级这类全局快捷键属于应用，SDK 不注册。需要时自己监听，再调用 `viewer.indoor.back()`。

## 显存档位

浏览器不告诉网页显卡有多少显存，所以 viewer 按适配器的厂商和架构**猜**一个档位，用它决定像素比、MSAA、各类缓存和预算、默认开启的效果：

| 档位 | 典型硬件 | 像素比上限 | MSAA | 日照阴影 | 体积云 | 透明顺序无关混合 |
| --- | --- | --- | --- | --- | --- | --- |
| `low` | 手机、内存 4 GB 以下的设备、软件渲染；没有 WebGPU 且少于 8 核 | 1 | 关 | 关 | 关 | 关 |
| `medium` | 其余显卡（Intel 核显、AMD 等）；没有 WebGPU 但 8 核以上 | 1.5 | 开 | 开 | 开 | 关 |
| `high` | NVIDIA 显卡、Intel 独显、内存 8 GB 以上的 Apple 芯片 | 2 | 开 | 开 | 开 | 关 |
| `ultra` | 只能手动指定 | 2 | 开 | 开（4096 阴影图） | 开 | 开 |

此外 3D Tiles 的显存目标与缓存、建筑模型的预算、高斯泼溅的数量上限也随档位变化，详见[加载、错误与性能](./performance.md#显存与档位)和 [gpu-memory.md](../agents/gpu-memory.md)。

- 读当前档位：`viewer.gpu.tier`（或 `viewer.info.tier`，`viewer.info.tierSource` 是 `'auto'` 或 `'option'`）；`viewer.gpu` 是该档位的全部预算。
- 指定档位：`GeoViewer.create({ ..., gpuTier: 'high' })`。大屏、展厅这种硬件固定的场合建议直接指定；面向公众的网页保持自动。
- 单独调几项：`antialias: false`、`maxPixelRatio: 1` 是高分屏或弱显卡上最省的两项。

::: tip Windows 双显卡笔记本
Chrome 在 Windows 上忽略网页的"高性能显卡"请求，双显卡笔记本可能跑在集显上（档位会被判为 `medium`）。比较性能前先看 `viewer.info.adapter`。
:::

## 多个 viewer

同一页面可以创建多个 viewer，各有自己的容器、相机、图层和事件，可以混用 WebGPU 和 WebGL 2（`forceWebGL`）：

```ts
const left = await GeoViewer.create({ container: leftEl, imagery: findImageryPreset('esri-imagery')!.create() });
const right = await GeoViewer.create({ container: rightEl, imagery: findImageryPreset('osm')!.create(), forceWebGL: true });

// 相机互不影响；要联动就由你同步
left.controller.events.on('change', () => right.setView(left.getView()));
```

要知道的几点：

- **有意共享的东西**：按域名的请求队列（浏览器的连接数本来就按页面算）、只读的着色器节点图、样式池里按键共享的几何和材质（引用计数，最后一个使用者释放才销毁）。每个 viewer 渲染前会重写共享的相机、大气、阴影 uniform，所以画面不会串。完整清单见 [API 参考 §4](../api.md#_4-多个-viewer)。
- **每个 viewer 都有自己的 GPU 设备或 WebGL 上下文**，各自占一份帧缓冲和瓦片缓存。浏览器对同时存在的 WebGL 上下文有数量上限（Chrome 约 16 个），超出时最早的会丢失；需要很多小地图时，考虑复用少数几个 viewer。
- 键盘只作用于获得焦点的那个 viewer。

## 释放

```ts
viewer.dispose();
```

`dispose()` 停止渲染循环，移除所有图层（3D Tiles、GeoJSON、点位、高斯泼溅）和建筑，释放 GPU 资源、Worker 和事件监听，移除 canvas 和顶牌层，再把容器还原成创建前的样子。之后不要再使用这个 viewer 对象；同一个容器可以立刻用来创建新的 viewer。

在单页应用里，组件卸载时一定要调用 `dispose()`，否则 GPU 内存和 Worker 会一直留着。React、Vue 里的写法见[快速开始](./getting-started.md#在框架里使用)。

## 示例

<ExampleFrame id="multi-viewer" />

示例源码：[examples/multi-viewer/main.ts](../../examples/multi-viewer/main.ts)。左右两个 viewer 分别用 WebGPU 和 WebGL 2，可以逐个销毁、重建，观察 canvas 数量和容器的还原；勾选"右侧跟随左侧视角"演示由宿主同步两个相机。
