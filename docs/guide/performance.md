# 加载、错误与性能

这一章讲运行时的几件事：怎样知道数据加载完了、加载失败时怎样处理、画面静止时 viewer 怎样省电、显存怎样估算和控制，以及出问题时怎样收集诊断信息。

## 加载状态

地球瓦片、3D Tiles、各类图层都在后台加载。`viewer.loadState` 汇总了"还有多少没加载完"（截至上一帧）：

| 字段 | 含义 |
| --- | --- |
| `globe` | 地球瓦片正在请求和排队的数量（地形、影像、叠加层）；地球隐藏时为 0 |
| `tilesets` | 正在绘制的 3D Tiles 图层里排队、下载、解析中的瓦片数 |
| `layers` | 还在加载数据的 GeoJSON、点位、高斯泼溅图层数 |
| `pending` | 以上三项之和 |
| `idle` | 没有待加载的内容，并且屏幕上的地球瓦片都显示着自己的影像（不是放大的上级影像）。影像源已经报告不可达时不再等它 |

两个事件：

| 事件 | 何时触发 |
| --- | --- |
| `load-progress` | `loadState` 变化时，每帧最多一次 |
| `idle` | `idle` 变为 true 时。之后每轮加载（相机移动、新图层）结束都会再触发；启动时即使没有要加载的东西也触发一次 |

`loadState` 只给出"还剩多少"，没有总数。做进度条时，可以用这一轮加载里出现过的最大待加载数做分母：

```ts
let peak = 0;
viewer.events.on('load-progress', (state) => {
  if (state.idle) return;
  peak = Math.max(peak, state.pending, 1);
  progressBar.style.width = `${(1 - state.pending / peak) * 100}%`;
});
viewer.events.on('idle', () => {
  peak = 0;
  progressBar.style.width = '100%';
});
```

需要注意：

- `idle` 只看网络和解码。建筑的楼层、设备模型在楼层第一次显示时才加载，不计入其中；要等它们，用 `await building.modelsLoaded(entity)`（[建筑、层级与实体](./indoor.md)）。
- 容器不可见（滚出视口、`display: none`）时 viewer 不画也不加载，`idle` 不会到来。
- 单个图层自己的加载完成用图层的 `ready` 事件（[基本概念](./concepts.md#异步与加载)）。

## 错误

### 统一监听

所有异步加载失败都汇总到 `viewer.events` 的 `error` 事件：

```ts
import { isTerraViewError } from 'terra-viewer';

viewer.events.on('error', ({ source, error, layer }) => {
  const code = isTerraViewError(error) ? error.code : 'unknown';
  showToast(`${source} 加载失败（${code}）`);
});
```

| `source` | 何时 | 常见 `code` |
| --- | --- | --- |
| `imagery` | 底图影像累计 3 次请求失败（每个影像源报一次） | `imagery-unreachable` |
| `terrain` | 地形瓦片累计 3 次构建失败（每个地形源报一次）；失败的瓦片保留原来的网格，之后退避重试 | `terrain-unreachable` |
| `tileset` | 3D Tiles 的根 tileset 加载失败（`layer` 是那个图层） | `tileset-load-failed` |
| `geojson` | GeoJSON 无法下载或解析 | `geojson-invalid`，或网络错误 |
| `points` | 点位数据无法下载或没有可用的点 | `points-empty`，或网络错误 |
| `splats` | 高斯泼溅文件下载失败、损坏或格式不支持 | `splat-load-failed`、`splat-invalid`、`splat-format-unsupported` |

图层自己的 `error` 事件照常触发（`{ message, error }`），两处选一处处理即可。失败的图层留在列表里，不需要时用 `viewer.removeGeoJson(layer)` 等方法移除。

### 错误对象与错误码

SDK 主动抛出或报告的错误都是 `TerraViewError`：`message` 是英文（给日志看），`code` 稳定、可以据此显示你自己的提示文字，`details` 带相关的值。网络错误（如 `HTTP 404`）和第三方库的错误照原样传出，不包装（高斯泼溅例外：它在 Worker 里下载，失败统一包成 `splat-load-failed`）。

有几类错误是**同步抛出**的，要用 `try / catch`：

| 调用 | `code` | `details` |
| --- | --- | --- |
| `GeoViewer.create()` 缺 `container` / `imagery` | `option-invalid` | `option`、`expected` |
| `viewer.indoor.add(doc)` 文档校验失败 | `building-invalid` | `path`，如 `$.floors[0].height` |
| `viewer.indoor.add(doc)` 同一 id 的建筑已加载 | `building-already-loaded` | `id` |
| `viewer.localScene.enter()` 区域不合法、`viewer.addSplats()` 缺 `position` 或数据 | `option-invalid` | `option` |

```ts
try {
  viewer.indoor.add(doc);
} catch (err) {
  if (isTerraViewError(err, 'building-invalid')) alert(`建筑文档第 ${err.details.path} 处有误`);
  else throw err;
}
```

全部错误码和各自的 `details` 见 [API 参考 §1.6](../api.md#_1-6-语言与错误)。

## 截图

`viewer.captureFrame()` 返回一张与画布同尺寸的 canvas；`viewer.navigation.screenshot(type?, quality?)` 直接给出 `Blob`。想要完整、清晰的画面，等加载完再截：

```ts
function whenIdle(): Promise<void> {
  if (viewer.loadState.idle) return Promise.resolve();
  return new Promise((resolve) => {
    const off = viewer.events.on('idle', () => {
      off();
      resolve();
    });
  });
}

await whenIdle();
const png = viewer.captureFrame().toDataURL('image/png');
```

画面已静止并超采样完时，截图直接输出超采样后的画面（边缘最平滑），不重画场景；否则画一帧实时画面。

## 帧率与功耗

画面一动不动时如果仍按显示器刷新率每帧重画，CPU 和 GPU 都白白在忙（实测高端台式机上也要占 0.4–1.3 个 CPU 核）。所以 viewer 默认：

1. 画面**安静 1 秒后**做**静止超采样**：接下来十几帧把相机错开不到一个像素再画、逐帧平均（有 MSAA 时 16 帧，没有时 32 帧，约 0.3–0.5 秒），得到比 MSAA 更平滑的边缘；
2. 然后**停止重画**，画面保持在超采样后的结果。这期间 viewer 仍按 `idleFrameRate`（默认每秒 10 次）更新状态、检查变化，但不画帧；
3. 有变化立刻恢复全帧率的实时画面，再安静 1 秒后重新超采样。

| 设置 | 说明 |
| --- | --- |
| `idleFrameRate`（创建选项，也可以直接改 `viewer.idleFrameRate`） | 安静时每秒更新几次，默认 10。0 表示每帧都画，也不做超采样；其他值限在 10–60 |
| `supersampling`（创建选项）、`viewer.supersampling` | `enabled` 开关（关掉时安静的画面按 `idleFrameRate` 重画）、`samples` 平均几帧（4–64）；只读的 `sampleCount`、`converged` |
| `viewer.requestRender()` | 立刻按实时画面重画，并保持全帧率至少 1 秒 |

**什么算变化**：相机运动（包括从代码发起的飞行和动画）、加载未完成、瓦片和 3D Tiles 的淡入、层级切换、选中和悬停、图层增删、尺寸变化、场景开关和时间、调色；以及经 SDK API 做的各种改动（实体的样式、显隐、移动，图层的显隐和样式，云层设置，描边与发光……）。鼠标在画面上移动本身不算变化，不会让静止画面先变糙再变细。

**要你自己通知的情况**：绕过 SDK 直接改 three.js 对象（往 `viewer.scene` 加对象、改它的位置或材质、直接改渲染器设置）之后，调用 `viewer.requestRender()`。场景里有逐帧变化的自定义对象时，在你的动画循环里每帧调用它，或设 `idleFrameRate: 0`。

**一直在动的东西**：`timeMultiplier` 不为 0（太阳在动）、漂移的云层、闪烁的描边会让画面永远不静止，帧率按它们的需要决定（云层按在屏幕上的移动速度，整球视角仍是每秒 10 帧）。

`viewer.stats` 里能看到当前状态：

| 字段 | 含义 |
| --- | --- |
| `fps` | 每秒实际画的帧数（静止时为 0） |
| `frameMs` / `gpuMs` | 每帧的 CPU / GPU 耗时，毫秒（`gpuMs` 只在 WebGPU 下有） |
| `drawCalls` / `triangles` | 场景 pass 的绘制数和三角形数 |
| `throttled` | 当前按安静帧率更新 |
| `still` | 画面已超采样完、不再重画 |
| `samples` | 屏幕上的画面平均了几帧（实时画面为 0） |

`frame` 事件在每次更新后触发，静止时也按安静帧率触发（`stats.still` 为 true），可以用来刷新你自己的状态栏。详见 [API 参考 §1.8](../api.md#_1-8-帧率、功耗与静止超采样)。

## 显存与档位

浏览器不提供显存容量和用量，viewer 按显卡猜一个**显存档位**（`low` / `medium` / `high` / `ultra`），由它决定像素比、MSAA 和各类预算（[创建、容器与释放](./viewer.md#显存档位)）。按档位变化的主要预算：

| 预算 | `low` | `medium` | `high` | `ultra` |
| --- | --- | --- | --- | --- |
| 3D Tiles 显存目标 | 128 MB | 256 MB | 384 MB | 768 MB |
| 建筑模型预算（隐藏楼层超出时卸载） | 64 MB | 128 MB | 256 MB | 512 MB |
| 高斯泼溅最多保留的泼溅数 | 50 万 | 150 万 | 300 万 | 600 万 |
| 日照阴影图 | 关 | 2048² | 2048² | 4096² |

`viewer.gpu` 是当前档位的全部预算，`viewer.memory` 是 viewer 自己分配的显存**估算**（字节），适合比较不同设置，不是精确值：

| 字段 | 内容 |
| --- | --- |
| `framebuffers` | 画布的颜色、深度目标（含 MSAA）、拾取缓冲、后期效果的缓冲 |
| `globe` | 地球瓦片的影像、叠加层纹理和网格 |
| `tilesGpu` | 上传到 GPU 的 3D Tiles 内容 |
| `buildings` | 建筑的 glTF 模型和楼层环境光遮蔽贴图 |
| `shadows` | 日照阴影图 |
| `splats` | 高斯泼溅图层 |
| `gpuTotal` | 以上之和 |
| `tilesCache` / `tilesCacheMax` | 3D Tiles 解码缓存（大部分在内存里）及其上限 |

显存紧张时最有效的几项：降低档位（`gpuTier: 'low'`）、`maxPixelRatio: 1`、`antialias: false`，以及下面针对各类数据的设置。

## 大量数据的建议

| 数据 | 建议 |
| --- | --- |
| 点位 | 点位是 HTML 顶牌，几千个以内没问题（避让走网格索引，数量一多自动进入精简模式）。点多时开聚合（`cluster: true`）。上万个、或数值高频刷新的场景不适合 DOM 顶牌。自定义顶牌样式不要给大量元素加 `backdrop-filter`、`filter` 或常驻动画（[顶牌与点位标注](./markers.md)） |
| 地球影像与地形 | 只支持 HTTP/1.1 的服务声明 `maxRequestsPerHost: 6`；按流量计费或移动网络时关掉空闲预取 `prefetchImagery: false`；用户常回到同一片区域时开启本机缓存 `persistentCache`（[影像、叠加层与地形](./imagery-terrain.md#本机缓存与离线)） |
| 3D Tiles | 预算按档位给，缓存满时整体降精度而不是局部停止加载；要更清晰或更省，调图层的 `layer.errorTarget`（不要直接改内部的 `tiles.errorTarget`）（[3D Tiles](./tiles3d.md)） |
| GeoJSON | 解析和栅格化都在 Worker 里，大文件不卡主线程；按瓦片贴地，只重绘受影响的瓦片 |
| 建筑 | 楼层和设备模型在楼层第一次显示时才加载，隐藏楼层超出预算时卸载；设备自动合批（1 万个设备约 40 次绘制）。设备很多时可以开贡献剔除 `viewer.indoor.culling.enabled = true`，屏幕上太小的设备不画 |
| 高斯泼溅 | `maxSplats`、`maxShDegree` 控制保留的泼溅数和球谐阶数，默认按档位（[高斯泼溅](./splats.md)） |

## 诊断

出问题时，先收集这些信息：

- `viewer.info`：后端（`'WebGPU'` / `'WebGL2'`）、适配器名、档位及来源、MSAA 样本数、像素比。
- `viewer.stats`、`viewer.memory`、`viewer.loadState`。
- `viewer.snapshot()`（高级）：把以上全部，加上视点、地球、3D Tiles、高斯泼溅、室内、后期效果、灯光、阴影的状态整理成一份纯 JSON（约 2 KB），可以直接附到问题报告里：

```ts
const blob = new Blob([JSON.stringify(viewer.snapshot(), null, 2)], { type: 'application/json' });
```

比较性能时注意：浏览器窗口被遮挡或最小化时动画帧会大幅降频；Windows 双显卡笔记本上 Chrome 可能跑在集显上，先看 `viewer.info.adapter`。

## 示例

<ExampleFrame id="load-state" />

示例源码：[examples/load-state/main.ts](../../examples/load-state/main.ts)。顶部的细线是用 `load-progress` / `idle` 做的加载条；"错误"一组按钮故意制造三种错误（不联网）：无效的 GeoJSON、空的点位数据走 `error` 事件，有误的建筑文档同步抛出；还可以等加载完截图、导出诊断快照，并切换静止超采样和安静帧率，观察每秒帧数在实时、安静、静止之间的变化。
