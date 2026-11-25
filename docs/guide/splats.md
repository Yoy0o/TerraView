# 高斯泼溅（3DGS）

3D 高斯泼溅（3D Gaussian Splatting）用几十万到几百万个半透明的"椭球斑点"表示一个实拍场景，画面接近照片，适合雕塑、文物、门店、室内这类小范围的实景。`viewer.addSplats()` 把一个泼溅文件放到地球上：文件在 Worker 里下载和解码，按显存档位的预算取舍，用 three.js 自带的 `GaussianSplat` 绘制（WebGPU 下用计算着色器排序，WebGL 后端在 CPU 上排序）。

支持的格式：

| 格式 | 来源 | 说明 |
| --- | --- | --- |
| `.ply` | INRIA / GraphDECO 训练输出（binary little endian） | 普通点云或网格的 PLY 不行；压缩 PLY、ASCII PLY 不支持 |
| `.splat` | 每个泼溅 32 字节的紧凑格式 | 没有球谐 |
| `.spz` | Niantic 的压缩格式，1–4 版 | 体积最小，推荐用于发布 |

## 加载与摆放

```ts
const layer = viewer.addSplats({
  url: 'https://example.com/statue.spz',
  name: '雕塑',
  position: { longitude: 116.3913, latitude: 39.9962 }, // 不给 height：站在地面上
  heading: 30,   // 度，自北顺时针
  scale: 1,      // 每个文件单位多少米
});

layer.events.on('progress', ({ loaded, total }) => console.log(loaded, total)); // 字节
layer.events.on('ready', ({ stats }) => console.log(stats.count, '个泼溅'));
layer.events.on('error', ({ error }) => console.warn(error.message));
```

**泼溅文件里没有坐标参考**：在哪、朝哪、多大、哪边朝上，都由你给。

| 选项 | 说明 |
| --- | --- |
| `url` / `data` | 文件地址，或文件的字节（`ArrayBuffer`，如拖入的文件；交给 Worker 后在主线程失效）。二选一，都没有时同步抛 `option-invalid` |
| `format` | `'ply'` / `'splat'` / `'spz'`。只在内容和文件名都判断不出时需要（`.splat` 没有文件头，靠扩展名） |
| `position` | 必填（放进建筑坐标系的除外，见下文）。经纬度（度），可选高度（米） |
| `heightReference` | `'ground'`：高度从地面起算，地面随地形 / 3D Tiles 加载自动跟随；`'ellipsoid'`：椭球高。默认：不给 `position.height` 时贴地，给了按椭球高 |
| `heading` / `pitch` / `roll` | 度。heading 自北顺时针；pitch 绕东轴（正值抬起北侧），roll 绕北轴（正值抬起西侧），用来摆正没对齐的数据 |
| `scale` | 每个文件单位多少米，默认 1。训练结果通常没有真实尺度，要自己量一个已知长度来定 |
| `upAxis` | 文件里哪边朝上：`'-y'`（默认，3DGS / COLMAP 的约定）、`'+y'`（glTF、多数 SPZ 4）、`'+z'`。场景倒着、躺着时换一个 |
| `pivot` | 放在 `position` 上的是场景的哪一点：`'bottom'`（默认，底面中点，场景"站"在地上）、`'center'`、`'origin'`（文件原点，数据事先对齐过时用），或文件坐标 `[x, y, z]` |
| `opacity` / `brightness` | 0–1 的不透明度；亮度倍数（线性光，默认 1） |

加载后随时可以改：

```ts
layer.setPlacement({ heading: 90, scale: 1.2 });          // 只改给出的字段
layer.setPlacement({ longitude: 116.40, latitude: 39.99 }); // 挪位置
layer.upAxis = '+y';
layer.opacity = 0.8;
layer.visible = false;
console.log(layer.placement); // 读回完整的摆放，可以存档
```

摆放时有两点要知道：

- "场景"的范围不含离群的泼溅：训练出来的场景常有几百米外的漂浮物，每个轴两头各去掉 1%（`boundsTrim`）的中心再算底面、中心和取景范围，漂浮物不会把场景带偏。
- 贴地的图层在地面高度可信之前先放在椭球高 0 m，确定后移到地面上并发 `moved` 事件。刚加载就要飞过去时，等第一个 `moved` 再调用 `layer.flyTo()`，否则可能飞向地下（本章示例就是这样做的）。

`layer.flyTo({ heading, pitch, duration })` 飞到能看全场景的位置（默认当前航向、俯仰 -25°）。图层列表是 `viewer.splatLayers`，`viewer.removeSplats(layer)` 移除并释放显存，增删和加载完成、失败时 `viewer.events` 发 `splats-changed`。

### 本地文件

拖进页面的文件可以直接交给它，用 `name` 帮助判断格式：

```ts
const file = event.dataTransfer!.files[0];
viewer.addSplats({ data: await file.arrayBuffer(), name: file.name, position: { longitude, latitude } });
```

## 拾取与交互

泼溅参与 `viewer.interaction` 的事件和相机手势（滚轮缩放到光标处、右键环绕都能落在泼溅表面上）：

```ts
viewer.interaction.on('click', (e) => {
  if (e.kind !== 'splats') return;
  console.log(e.splats!.name, e.cartographic); // cartographic：弧度、米
});
```

- 泼溅不在 GPU 拾取缓冲里，每次拾取对图层发一条 CPU 射线（BVH，约 0.01–0.1 ms）。"表面"是沿射线累积不透明度达到 0.5 的位置，稀薄的漂浮物会被穿过。
- `viewer.pick()` 的结果里 `source: 'splats'`，另有 `splatIndex`（第几个泼溅）。
- `pickable: false` 让图层不参与拾取。

## 裁剪

只看场景的一部分（去掉地面、天空背景、只留主体）：

```ts
const b = layer.localBounds!; // 场景自己的盒子（不含漂浮物），作裁剪的起点
layer.crop = { type: 'box', min: b.min, max: [b.max[0], b.max[1], (b.min[2] + b.max[2]) / 2] }; // 只留下半部分
layer.crop = { type: 'sphere', center: [0, 0, 0.3], radius: 0.5 };
layer.crop = null; // 取消
```

裁剪坐标是图层本地坐标：X 东、Y 北、Z 上（未转航向），单位是文件单位，原点在枢轴。每次设 `crop` 都在 CPU 上过滤后重新上传（每百万泼溅几十毫秒），所以在开关、滑块松开时设，不要在拖动过程中连续设。预算的取舍在裁剪之前：大文件只想看一小块时，事先用工具裁好更省。

## 显存预算

泼溅数量按显存档位（`viewer.gpu.splats`）限制，超出的按"不透明度 × 尺寸"从小到大舍去；球谐阶数（随视角变化的颜色）直接截断：

| 档位 | 最多泼溅数 | 球谐阶数 | 满预算显存 |
| --- | --- | --- | --- |
| `low` | 50 万 | 0 | 约 29 MB |
| `medium` | 150 万 | 1 | 约 126 MB |
| `high` | 300 万 | 2 | 约 298 MB |
| `ultra` | 600 万 | 3 | 约 732 MB |

WebGL 后端另外不超过 60 万（在主线程排序）。单个图层可以用 `maxSplats` / `maxShDegree` 指定；`layer.stats` 里有文件里的泼溅数和球谐阶数、实际加载和绘制的数量、文件大小、解码耗时，`layer.gpuBytes` / `viewer.memory.splats` 是显存估算。系统内存约为显存的 1.5–2 倍（拾取和裁剪要用到解码后的数据）。

## 与场景其他部分的关系

- **遮挡**：泼溅被地形、3D Tiles、建筑正确遮挡，但它自己不写深度：不挡顶牌，后画的透明物体叠在它上面。
- **颜色**：按照片对待，参与色调映射和调色，不受光照和阴影影响。
- **进入建筑**：默认随 3D Tiles 一起隐藏（`showIndoors: true` 保留）。属于某栋楼、某一层的实景，用 `level` 选项绑定到那个实体：进入对应层级时才加载、显示，可以放进楼层坐标系跟随移动，实体自己的模型可以让位但仍能点选。写法见[建筑、层级与实体](./indoor.md)的"层级绑定"，建筑文档里也可以直接声明（[建筑数据制作手册](../building-data-manual.md)）。
- **局部场景**：区域外的图层整层隐藏（按场景中心判断），不裁切。
- 屏幕上太小（半径小于 `minScreenSize`，默认 3 像素）时不画，加载后用 `fadeDuration`（默认 400 毫秒）淡入。

## 错误

| `code` | 何时 |
| --- | --- |
| `splat-load-failed` | 下载失败（网络错误、HTTP 状态） |
| `splat-invalid` | 文件损坏，或不是高斯泼溅（普通点云的 PLY、被截断的文件） |
| `splat-format-unsupported` | 认不出的格式，或不支持的变体（压缩 PLY、ASCII PLY、SPZ 5 以上） |

图层的 `error` 事件和 `viewer.events` 的 `error`（`source: 'splats'`）都会收到。

## 数据与合规

- 公开的泼溅样例多以 CC BY 发布，用在产品里要保留作者署名。本章示例用的是 three.js 示例库里的 lion.v3.spz（作者 Renaud，CC BY 4.0）。
- 实拍数据可能拍到人脸、车牌、内部设施，和倾斜摄影一样属于测绘成果的范畴，对外发布前按所在地的要求处理。SDK 不上传、不缓存数据。
- 需要厘米级对齐时，在训练前用控制点做好配准，再用 `pivot: 'origin'` 和准确的 `position` 放置。

<ExampleFrame id="splats" />

示例源码：[examples/splats/main.ts](../../examples/splats/main.ts)。规范和实现细节见 [splats.md](../agents/splats.md)。
