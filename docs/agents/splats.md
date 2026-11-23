# 高斯泼溅（3DGS）规范

> 状态：第一期已实现（2026-11-22，路线图 M4.8 的"高斯泼溅"一项）：单文件场景的加载、地理锚定、显示与交互。2026-11-23 完成第二期的层级绑定（§7.1）：图层挂到建筑 / 楼层 / 房间 / 设备上，按所在层级显隐、可放进实体坐标系、懒加载、拾取归到实体，建筑文档可声明 `splats`。分块流式（3D Tiles 内嵌泼溅）、深度预通道等在 §11 分期。

代码：`src/indoor/levelBinding.ts`（层级绑定，通用）；`src/splats/`（`splatData.ts` 数据布局、预算、边界、裁剪；`splatFormats.ts` 文件解码；`splatIndex.ts` 拾取用的 BVH 与射线查询；`splatPlacement.ts` 定位数学；`splat.worker.ts` 加载 Worker；`SplatLayer.ts` 图层），以及 `GeoViewer`（`addSplats` / `removeSplats`、拾取、帧循环、显存、加载状态、错误）、`InteractionManager`（`kind: 'splats'`）、`core/gpuProfile.ts`（档位预算）、`core/errors.ts`（三个错误码）。演示应用：`demo/ui/SplatPanel.ts`、`demo/data/demoSplats.ts`、`demo/ui/urlOptions.ts`（`?splats=`）。API 见 [api.md](../api.md) §1.13。

## 1. 是什么

3D 高斯泼溅（3D Gaussian Splatting）把一个实拍场景表示成几十万到几百万个带颜色、不透明度和朝向的椭球（泼溅），按从后到前的顺序混合出照片级的画面。它和倾斜摄影（3D Tiles 网格）是同一类数据——实景底座——但对细碎、反光、半透明的东西（植被、玻璃、管线）还原得好得多，文件来自手机或无人机环拍后的训练。

在 TerraView 里它是**一种图层**：`viewer.addSplats({ url, position, … })` 把一个泼溅文件放到地球上的某个经纬度，与影像、地形、3D Tiles、建筑同屏显示，能被点击、悬停、作为相机缩放和环绕的落点。典型用法：

- 园区里某台设备、某个机房、一段管廊的实景，摆在 BIM 模型旁边或里面；
- 一栋建筑外立面或一个街角的实景，叠在倾斜摄影或地形上；
- 文物、展品这类单体。

第一期是**单文件、整体加载**（上限按显存档位，默认 50 万–600 万个泼溅）；城市级的分块流式是第三期（§11）。

## 2. 取舍（2026-11-22 定）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 渲染器 | three r187 自带的 `GaussianSplat`（addon，`three/addons/objects/GaussianSplat.js`） | 路线图 §0 的原则：three 已有的不自研。它用 `highpModelViewMatrix`（与本仓库的 float64 模型视图一致）、WebGPU 计算着色器做计数排序和球谐预计算，WebGL 后端退到 CPU 排序和顶点着色器球谐；实测在本仓库的管线里两个后端画面一致（§9）。不引入 Spark、GaussianSplats3D 这类第三方渲染器（各带一套自己的渲染循环和 WebGL 假设） |
| 解码 | 自己写，在 Worker 里（`splatFormats.ts`） | three 的加载器在主线程解析并且 import three；AGENTS.md §3.6 要求解码进 Worker、Worker 不 import three。百万泼溅的 PLY 约 250 MB，主线程解析会卡数秒 |
| 格式 | `.ply`（INRIA 训练输出）、`.splat`、`.spz`（1–4 版） | 三种最常见的交换格式。压缩 PLY（SuperSplat）、`.ksplat`、SOG、glTF `KHR_gaussian_splatting` 留到后面（§11），遇到时报 `splat-format-unsupported` |
| Zstandard（SPZ 4） | Worker 把压缩流发回主线程，用宿主 three 自带的 `zstddec` 解压 | 解码器是第三方 WebAssembly：打进 Worker 就成了包里的第三方二进制（许可、体积、要先征得同意）；主线程走 `three/addons/libs/…`，和 Draco、KTX2 一样由宿主的 three 提供。代价是解压在主线程（10 MB 的文件几十毫秒，一次） |
| 拾取 | CPU：BVH + 沿射线累积不透明度（`splatIndex.ts`） | 泼溅不写深度，进不了 GPU 拾取缓冲（那张缓冲靠深度反投影求位置）。射线查询每条 0.01–0.07 ms（§9），悬停也用得起 |
| 空间索引 | BVH，不用均匀网格 | 先做的网格实测不行：同一场景里泼溅尺寸跨几个数量级，按多数小泼溅定格子后，狮子场景 62% 的泼溅"比格子大"只能逐条遍历，约 2 ms / 射线；BVH 的盒子按每个泼溅的真实范围算，快 30–200 倍 |
| 预算 | 加载时按重要度（不透明度 × 尺寸）舍去超出预算的泼溅 | 显存、排序和填充率都与泼溅数成正比；没有分块 LOD 时这是唯一的降级手段。又小又透明的泼溅贡献最小 |
| 裁剪 | CPU 过滤后重新上传 | 自带的渲染器没有逐泼溅的显隐入口；裁剪是偶发操作（去掉背景和漂浮物），重建一次几十毫秒，不值得为它改着色器。拾取不重建，带掩码查原来的 BVH |
| 颜色 | 泼溅颜色按 sRGB 转线性后进场景 pass，再随全帧一起色调映射 | 泼溅颜色是显示值（训练时就在显示空间里混合）；本仓库的场景 pass 是线性 HDR。不转换会整体发白（实测）。与倾斜摄影的照片纹理同样对待。线性空间里混合与训练时略有差别（边缘稍硬），可接受 |
| 深度 | 不写深度，只做深度测试 | 泼溅被地形、建筑正确遮挡；但泼溅自己不挡后画的透明物体、不挡顶牌的遮挡查询（§5.4、§10） |
| 轴向 | `upAxis` 选项，默认 `'-y'` | 文件没有元数据说明哪边朝上；3DGS / COLMAP 的惯例是 Y 朝下。SPZ 规范是 Y 朝上，但实际文件两种都有（three 示例里的两个 SPZ 就一个一种），所以不按格式猜 |
| 与室内 | 不绑定的图层是"室外背景"：进入建筑时随 3D Tiles 一起隐藏（`showIndoors: false`）。属于某栋楼、某一层的实景用 `level` 绑到那个节点（§7.1） | 室外实景与楼层内部重叠时会穿帮。泼溅不自成层级、不另起一棵树：层级树只有一棵，实体管语义，泼溅管外观（indoor-bim.md §6.5） |

## 3. 数据

### 3.1 格式

| 格式 | 内容 | 球谐 | 说明 |
| --- | --- | --- | --- |
| `.ply` | INRIA / GraphDECO 训练输出：`x y z`、`f_dc_*`、`f_rest_*`、`opacity`、`scale_*`、`rot_*`，binary little endian | 0–3 阶（由 `f_rest` 个数 0 / 9 / 24 / 45 判断） | 属性顺序、类型按文件头读，不假定全是 float32；顶点必须是第一个 element。普通点云或网格 PLY 报 `splat-invalid`，压缩 PLY、ASCII 报 `splat-format-unsupported` |
| `.splat` | 每个泼溅 32 字节：位置、尺度（各 3 个 float32）、RGBA、四元数（各 4 字节） | 无 | 没有文件头也没有魔数：靠扩展名，或长度是 32 的倍数 |
| `.spz` | Niantic 的压缩格式。1–3 版整体 gzip（`DecompressionStream`）；4 版每个属性一个 Zstandard 流 | 0–3 阶（文件里的第 4 阶丢弃） | 位置 24 位定点（1 版半精度浮点），尺度对数量化，旋转 3 字节（≤ 2 版）或"最小三分量"（≥ 3 版） |

格式判断（`detectSplatFormat`）：先看内容（`ply\n`、SPZ 魔数、gzip 魔数），再看名字的扩展名，最后才按"32 的倍数"当 `.splat`。宿主也可以用 `format` 直接指定。

解码后的内存布局（`SplatData`）就是 `GaussianSplat` 要的布局，交给它时不再复制：

| 数组 | 每个泼溅 | 内容 |
| --- | --- | --- |
| `centers` | 3 × float32 | 中心，文件坐标 |
| `covariances` | 6 × float32 | 协方差上三角 `xx xy xz yy yz zz`（由尺度和旋转算出：Σ = R S Sᵀ Rᵀ） |
| `colors` | 4 × uint8 | 显示空间的 RGB（0.5 + C0 × f_dc）和不透明度 |
| `sh1` / `sh2` / `sh3` | 3 / 4 / 6 × uint32 | 球谐各阶系数，每个系数一个字节 `(v × 128 + 128)`，按系数排（RGB、RGB…），四个一组打包 |

### 3.2 预算

`viewer.gpu.splats`（`SplatQuality`），图层的 `maxSplats` / `maxShDegree` 优先：

| 档位 | `maxSplats` | `maxShDegree` | 每个泼溅的显存 | 满预算显存 |
| --- | --- | --- | --- | --- |
| low | 500 000 | 0 | 60 B | 29 MB |
| medium | 1 500 000 | 1 | 88 B | 126 MB |
| high | 3 000 000 | 2 | 104 B | 298 MB |
| ultra | 6 000 000 | 3 | 128 B | 732 MB |

- 每个泼溅：中心 16 + 协方差 32 + 颜色 4 + 排序的顺序和键 8 = 60 字节；球谐各阶再加 12 / 16 / 24 字节，有球谐时 WebGPU 还有一份预计算结果 16 字节（`splatGpuBytes`）。实测千足虫场景（11.6 万、无球谐）估算 6.98 MB，`renderer.info` 实际增加 WebGL 6.55 MB、WebGPU 7.03 MB。
- WebGL 后端在 CPU 上排序（每次视线方向转过约 1.8° 排一次，主线程），上限另外压到 60 万。
- 取舍规则（`budgetSplats`）：先去掉画不出来的（不透明度为 0、坐标或形状不是有限数），再按重要度 = 不透明度 × 协方差的迹（尺寸的平方）从小到大舍，保留的按文件原顺序排（训练顺序里相邻的泼溅在空间上也相邻，对排序和缓存友好）。
- 球谐阶数直接截断（丢高阶），不重新拟合。
- 系统内存：解码后的数组（40 字节 + 球谐）留在主线程给拾取和裁剪用，`GaussianSplat` 自己还有一份上传用的副本（52 字节）；BVH 约 12 字节。合计约为显存的 1.5–2 倍。裁剪时再多一份被保留泼溅的副本。

### 3.3 边界（`computeSplatBounds`）

训练出来的场景总有离群的泼溅（几百米外的"漂浮物"）。全量包围盒会让场景的中心、取景距离、排序范围都被它们带偏，所以另算一个**核心包围盒**：每个轴去掉两头各 1% 的中心（`boundsTrim`，分位数从最多 10 万个均匀抽样里取）。用途：

- 枢轴（场景底面中点）、`boundingSphere`（取景、最小屏幕尺寸）、`localBounds`（裁剪的起点）用核心包围盒；
- 视锥剔除用全量包围盒（漂浮物还在画面里就不能整层不画）；
- 排序的深度范围用核心包围球 × 1.25（§5.2）。

## 4. 定位（`splatPlacement.ts`）

```
世界（ECEF）= ENU(锚点) · Rz(−heading) · Rx(pitch) · Ry(roll) · scale · 轴向转换 · (p − pivot)
```

- **锚点**：`position` 的经纬度和高度。`heightReference: 'ground'` 时高度是离地高度，地面取 `viewer.surfaceHeight`（地形；隐藏地球时是 3D Tiles），只在结果可靠时采用，之后每帧核对、变了就跟着动（`moved` 事件）；不可靠时保持原高度，不回落到 0（AGENTS.md §7 ISSUE-1）。不给 `position.height` 默认贴地，给了默认按椭球高。
- **轴向转换**（`upAxis`）：文件坐标 → 本地坐标（X 东、Y 北、Z 上）。`'-y'`：x → 东，z（前）→ 北，−y → 上；`'+y'`：x → 东，−z → 北，y → 上；`'+z'`：不变。三个都是正交旋转（行列式 1）。
- **枢轴**（`pivot`）：放在锚点上的那个点。`'bottom'`（默认）是核心包围盒底面的中点，场景"站"在地面上；`'center'`、`'origin'`（文件原点，数据事先对齐过时用）、或文件坐标里的一个点。枢轴在加载时定下，之后裁剪不会让场景跳动；改 `upAxis` 时重新取。
- **heading / pitch / roll**：度。heading 自北顺时针（与建筑的 `heading` 一致）；pitch 绕东轴（正值抬起北侧），roll 绕北轴（正值抬起西侧），用来摆正没对齐的数据。
- **scale**：每个文件单位多少米。训练结果没有真实尺度，除非事先用控制点对齐过。
- 矩阵在 CPU 上用 float64 合成，写在图层 `group.matrix` 上，平移部分就是锚点的 ECEF 坐标（RTC）；泼溅中心留在 float32 的文件坐标里（AGENTS.md §3.2）。
- **图层本地坐标系**（`crop`、`localBounds`、`localToWorld` 用）：轴向转换之后、heading 和 scale 之前，原点在枢轴，单位是文件单位。这样裁剪范围不随摆放改变。

`setPlacement(部分字段)` 随时改位置、朝向、尺寸；`placement` 读回（可存档）。

## 5. 渲染

### 5.1 网格与材质

每个图层一个 `GaussianSplat`（实例化的四边形，每个泼溅一个实例），挂在图层的 `group` 下。它的材质只包了一层（`SplatLayer.rebuild`）：

```ts
material.colorNode = Fn(() => {
  const color = vec4(base).toVar();              // three 的片元节点：泼溅颜色 × 高斯衰减
  return vec4(sRGBTransferEOTF(color.rgb).mul(brightness), color.a.mul(opacity));
})();
```

`opacity`（图层不透明度 × 加载淡入 × 远处淡出）和 `brightness` 是每个图层自己的 uniform。除此之外不碰 three 的着色器：以后 three 修了排序或球谐，这里跟着受益。

- 透明、不写深度、做深度测试；`renderOrder = -1`，排在云层（10）、半透明房间之前画，它们叠在泼溅上面。
- 不挂空气透视的 `outputNode`：泼溅是近景数据。
- 不投影也不接收日照阴影，不受场景光照影响（颜色是烘在数据里的）。

### 5.2 排序

three 的实现：视线方向转过约 1.8°（点积 < 0.9995）才重排；WebGPU 用计算着色器做 4096 桶的计数排序，WebGL 在主线程排。桶按"包围球的近端到远端"均分，所以**包围球不能被漂浮物撑大**：否则主体只占很少几个桶，近处的泼溅顺序错乱。图层把 `mesh.boundingSphere` 设成核心包围球 × 1.25，球外的泼溅落进首尾的桶里（它们之间的顺序不重要）。相应地关掉 three 的视锥剔除（`frustumCulled = false`），由图层自己按全量包围球判断（§5.3）。

静止超采样期间相机只抖投影矩阵，视线方向不变，不触发重排和球谐重算。

### 5.3 可见性（`SplatLayer.update`，每帧）

图层画不画由这几项决定：`ready`、`visible`、没有被 viewer 压制（§7）、不透明度大于 0、在视锥内、屏幕上够大。

- **视锥**：全量包围球对视锥四个侧面和相机平面的保守测试（`sphereInView`）。
- **最小屏幕尺寸**（`minScreenSize`，默认 3 px）：核心包围球在屏幕上的半径小于它时不画，到两倍时淡入到满。从全球视角飞向一个几米大的场景时，它在几个像素大时才开始出现，之前不占排序和绘制。设 0 关闭。
- **加载淡入**（`fadeDuration`，默认 400 ms）。

### 5.4 与其他绘制的关系

| 对象 | 关系 |
| --- | --- |
| 地形、3D Tiles、建筑（不透明） | 正确：泼溅做深度测试，被它们挡住 |
| 半透明建筑、云层 | 后画，叠在泼溅上面；它们在泼溅后面时会画错（透明物体之间的老问题，泼溅不写深度所以没法靠深度解决） |
| GPU 拾取缓冲 | 泼溅不在里面（`classifyPick` 不认它），拾取另走射线（§6.1） |
| 日照阴影图、楼层 AO、描边遮罩、OIT | 不参与：这些 pass 只画建筑树或登记过的对象 |
| 顶牌遮挡（`occlusion: 'hide' / 'fade'`） | 泼溅不挡顶牌（遮挡查询看的是深度） |
| 层级切换的截帧重投影 | 泼溅在截下的画面里，但深度是它后面的东西，重投影时会当成背景移动 |
| 后期（色调映射、调色、静止超采样） | 一起经过；MSAA 下泼溅也按 4 个采样点光栅化 |

### 5.5 帧率信号

- 图层上会改变画面的 setter（`visible`、`opacity`、`brightness`、`crop`、`upAxis`、`setPlacement`）都发 `change` 事件，viewer 据此 `requestRender()`；加载完成同样。
- 自己会动的只有加载淡入和贴地跟随：`update()` 返回 true 时 viewer 请求下一帧，`animating` 表示淡入未完。
- 排序和球谐重算只在相机变化时发生，相机变化本来就是"变化"。

## 6. 交互

### 6.1 拾取（`splatIndex.ts`）

`viewer.pick` / `pickAt` 先照旧求"表面"（拾取缓冲或射线：建筑、3D Tiles、地球），再对每个泼溅图层做一次射线查询（上限是已知最近的表面距离），更近的赢。结果 `source: 'splats'`，带图层和泼溅下标。相机手势（`host.pick`）走同一个 `pick`，所以滚轮缩放到光标、右键环绕的枢轴都能落在泼溅表面上。

**命中在哪**：泼溅是模糊的，没有"第一个交点"。射线上每个泼溅取它响应最强的那一点（到椭球中心的马氏距离最小处）：位置 t、强度 α = 不透明度 × exp(−m² / 2)，超出 2σ 的不算。按 t 从前到后累积，透过率乘 (1 − α)，**累积不透明度达到 0.5 的那个泼溅就是命中**。这样稀薄的漂浮物会被穿过去，命中落在看得见的表面上；阈值可以用 `raycast(ray, { minOpacity })` 改。

**BVH**：在 Worker 里建，约每百万泼溅 0.5 s。按中心包围盒最长轴的中点二分，叶子最多 8 个泼溅；每个节点的盒子包含泼溅的真实范围（沿某轴的半宽 = 2 × √协方差对角元，对椭球是精确的）。遍历时近的子节点先走；一旦有了命中，入口距离在命中之后的节点整个跳过（泼溅的最强点一定在它自己的盒子里，所以这样跳是精确的，不是近似）。与暴力遍历的一致性有单测。

裁剪后的拾取不重建 BVH：带一个按已加载泼溅编号的掩码查原来的树，所以 `SplatHit.index` 在裁剪前后是同一套编号。

图层先做一次廉价测试（射线到全量包围球的距离），光标不在图层上时几乎没有开销。`pickable: false` 的图层不参与。

### 6.2 事件

走 `viewer.interaction`（AGENTS.md §3.7），不另设一套：

```ts
viewer.interaction.on('click', (e) => {
  if (e.kind !== 'splats') return;
  console.log(e.splats.name, e.cartographic);   // 命中的图层、经纬度（弧度）和椭球高
});
```

`PickInfo.kind` 多了 `'splats'`，`PickInfo.splats` / `InteractionEvent.splats` 是命中的图层。单击、双击、右键、悬停都适用；选择器只匹配 BIM 实体，泼溅用 `e.kind` 判断。默认行为不变：双击泼溅是相机的"双击飞近"，飞向命中点。

### 6.3 取景、摆放、裁剪

- `layer.flyTo({ heading, pitch, duration })`：按核心包围球取景（默认保持当前航向、俯仰 −25°）。
- 摆放：`setPlacement`。演示面板的"点选位置"是用公共 API 拼出来的（下一次 `click` 的 `e.cartographic` 交给 `setPlacement`），SDK 不内置放置工具，等测量、标绘一起设计。
- 裁剪：`layer.crop = { type: 'box', min, max } | { type: 'sphere', center, radius } | null`，图层本地坐标（§4），`localBounds` 给出场景自己的盒子作起点。在 CPU 上过滤后重新上传（每百万泼溅几十毫秒，外加上传和一次着色器编译），所以在控件松开时设，不要在拖动中设。预算在裁剪之前：大文件只想看一小块时，调高 `maxSplats` 或事先用工具裁好。

## 7. 与 viewer 其他部分的集成

| 方面 | 做法 |
| --- | --- |
| 层级 | 绑定了层级的图层按绑定规则显隐（§7.1）；没绑定的：3D Tiles 被压制时，`showIndoors: false`（默认）的图层一起隐藏（`suppressed`），返回地球时恢复。两种情况都由 `GeoViewer.hiddenByLevel` 每帧决定 |
| 局部场景 | `outside: 'hide'` 时，核心包围球中心在区域外的图层隐藏；拾取到区域外的点不算。不按区域裁切泼溅本身 |
| 贴地 | 走 `viewer.surfaceHeight` 的查询（§4），不直接问地形 |
| 显存 | `viewer.memory.splats`（各图层 `gpuBytes` 之和，计入 `gpuTotal`）；`viewer.snapshot().splats` |
| 加载状态 | 没加载完的图层计入 `loadState.layers`，全部完成才 `idle` |
| 错误 | 图层 `error` 事件和 `viewer.events` 的 `error`（`source: 'splats'`）。错误码：`splat-load-failed`（下载失败）、`splat-invalid`（文件损坏或不是泼溅文件）、`splat-format-unsupported`（不支持的格式或变体） |
| Worker | 每次加载一个 Worker，结果返回后立即关闭（没有模块级的共享 Worker）；`removeSplats` 时还在加载的也一并关闭 |
| 释放 | `GaussianSplat` 没有 `dispose()`：它的存储缓冲和计算管线在私有字段里，`disposeGaussianSplat` 遍历出来逐个释放（WebGL 后端每个存储缓冲还带一张纹理）。实测两个后端移除后 `renderer.info.memory` 回到基线，反复加载不增长 |
| 多个 viewer | 图层属于创建它的 viewer。模块级状态只有 Zstandard 解码器（无状态，共享）和射线查询的暂存数组（同步使用） |

### 7.1 层级绑定

泼溅是"某个层级真实的样子"，所以它挂在层级树的节点上，而不是自己成为层级（设计理由和通用机制见 [indoor-bim.md](indoor-bim.md) §6.5）。图层的 `level` 选项（`SplatLevelOptions`）管三件事：

| | 选项 | 说明 |
| --- | --- | --- |
| 何时显示 | `entity`、`show` | 属于哪个实体（实体或 id；不写 = 地球），相对所在层级何时显示（`'inside'` / `'outside'` / `'current'` / `'entity'` / `'always'` 或函数）。绑定后不再看 `showIndoors` |
| 模型怎么办 | `entityOpacity` | 场景显示且已加载时，实体及其下级的模型不透明度：1 保留、约 0.15 淡影叠加、0 隐去但仍可拾取 / 描边 / 带顶牌 |
| 放在哪 | `position` 或 `follow` | 可选。给了 `position`（米）就放进实体的坐标系，跟着实体移动；`follow: true` 把当前的地理位置原样转进实体坐标系。都不给时只绑显隐，位置仍是经纬度 |

```ts
// 三层的室内实景：进入三层（或其中的房间）时才加载、显示；模型隐去，房间照常可点选
const scan = viewer.addSplats({ url: 'F3.spz', level: { entity: 'F3', position: [0, 0, 0], entityOpacity: 0 } });

// 先在地球上摆好，再绑到楼层并跟随；读回实体坐标系里的位置，写进建筑文档
const layer = viewer.addSplats({ url, position: { longitude, latitude } });
layer.setLevel({ entity: floor, follow: true });
layer.level.position; // [x, y, z]，楼层内坐标

layer.setLevel(null); // 解除绑定：留在原地（改为椭球高）
```

- **坐标系**：建筑用建筑本地坐标（锚点处 X 东、Y 北、Z 上，按建筑 `heading` 旋转）；楼层、房间、构件用楼层内坐标（z = 0 是楼面，楼层展开时一起移动）；设备相对设备自身（随它平移、旋转）。放进坐标系后 `heading` / `pitch` / `roll` 相对该坐标系的轴，`placement` 里的经纬度和高度不再使用，`heightReference` 的贴地也不再起作用（高度由实体决定）。
- **实现**：图层不认识实体。viewer 每帧把绑定实体的世界矩阵交给图层（`setFrame`），矩阵变了图层才重算自己的矩阵：`世界 = 实体矩阵 · T(position) · Rz·Rx·Ry · scale · 轴向 · (p − pivot)`，仍是 float64。进出坐标系时经由地理位置换算（位置不动，heading 加减坐标系 +Y 的朝向，`frameHeading`），所以换绑到另一个实体时场景也不会跳。
- **懒加载**：绑定的图层默认 `load: 'lazy'`，第一次该显示时才启动 Worker（`preload()` 可以提前）。没开始加载的图层不计入 `loadState.layers`，`layer.loading` 为 false。一栋楼每层挂一个实景也不会在打开时全部下载。隐藏后不卸载（以后按预算卸载，§11）。
- **拾取**：`pickEntity`（默认开）让点到场景等于点到它的实体：`e.kind === 'splats'`，同时 `e.entity` 是绑定的实体。如果泼溅后面的表面是这个实体**内部**的实体（扫描的楼层里的某个房间，画着或隐去都算），就报那个更细的实体：几何给语义，泼溅给位置。于是悬停描边、单击选中、双击进入下一级、选择器都照常工作，不需要为泼溅另写一套。
- **文档里声明**：建筑文档的任何元素都可以带 `splats`（[indoor-bim.md](indoor-bim.md) §4、[建筑数据制作手册](../building-data-manual.md) §4.10），加载建筑时由 viewer 建成绑定的图层（出现在 `viewer.splatLayers` 里，可以照常调），移除建筑时一并移除。按 id 用 API 绑定的图层在建筑移除后保留（隐藏，等同 id 的建筑再加载）。
- 3D Tiles 图层有同样的 `level` 选项（只绑显隐和模型不透明度，瓦片自带位置）。

## 8. API 速览

```ts
const layer = viewer.addSplats({
  url: 'https://…/scene.spz',                 // 或 data: ArrayBuffer（拖入的文件）
  position: { longitude: 116.39, latitude: 39.91 },   // 不给 height：贴地
  heading: 30, scale: 1, upAxis: '-y', pivot: 'bottom',
});
layer.events.on('ready', ({ stats }) => layer.flyTo());
layer.events.on('error', ({ error }) => console.warn(error));

layer.setPlacement({ heading: 45, height: 0.5 });
layer.opacity = 0.8;
layer.crop = { type: 'sphere', center: [0, 0, 2], radius: 5 };
viewer.removeSplats(layer);
```

`SplatLayer`：`ready`、`error`、`progress`、`loading`、`preload()`、`stats`、`boundingSphere`、`placement` / `setPlacement`、`level` / `setLevel`、`pickEntity`、`ellipsoidHeight`、`upAxis`、`visible`、`opacity`、`brightness`、`crop`、`localBounds`、`localToWorld`、`minScreenSize`、`pickable`、`active`、`gpuBytes`、`raycast(ray, options)`、`flyTo(options)`、`events`（`ready` / `error` / `progress` / `change` / `moved`）。选项和各字段的单位见 `SplatLayerOptions` 的注释和 [api.md](../api.md) §1.13。

演示应用：面板"高斯泼溅（3DGS）"（示例场景、URL、文件、每个图层的显隐、轴向、点选位置、朝向、缩放、离地、不透明度、裁剪、层级绑定（绑到哪个实体、显示时机、是否跟随、模型不透明度）、取景、移除）；示例办公楼的大堂里有一个在文档里声明的实景（程序生成的示意数据，离线可用）；拖入 `.ply` / `.splat` / `.spz`，URL 参数 `?splats=<url>` `?splatsAt=经度,纬度[,椭球高]` `?splatsScale` `?splatsHeading` `?splatsUp=-y|+y|+z` `?splatsMax`。

## 9. 实测（2026-11-22）

环境：云端容器，Chromium 153，**软件渲染**（SwiftShader：WebGL 经 ANGLE，WebGPU 经 Dawn 的回退适配器；WebGPU 要在有界面模式下才能出图，用 Xvfb）。所以下面没有帧率：软件渲染下一帧要几秒，量的是光栅器不是 SDK（AGENTS.md §7）。**真实 GPU 上的帧率、排序耗时、大场景（百万级以上）还没有测**，合并前请在本机 Chrome 上按 §10 的清单看一遍。

开放数据（three.js r187 示例库 `examples/models/`，各自 CC BY 4.0；Niantic `spz` 仓库的样例）：

| 场景 | 格式 | 泼溅 | 球谐 | 文件 | Worker 解码 + 预算 + BVH | BVH 构建 | 射线查询 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 千足虫（Fabian Plum） | `.splat` | 116 374 | 无 | 3.7 MB | 约 0.25 s | 103 ms | 0.030 ms |
| 狮子（Renaud） | SPZ 3 | 195 099 | 2 阶 | 4.3 MB | 约 0.45 s | 93 ms | 0.073 ms |
| 番茄（Grail） | SPZ 4 | 445 409 | 3 阶 | 9.4 MB | 约 0.5 s（另加主线程解压） | — | — |
| 角蜥（Niantic 样例） | SPZ | 786 233 | 3 阶 | 18.1 MB | — | 482 ms | 0.011 ms |

（解码时间是开发服务器未压缩代码、且渲染占着 CPU 时的数；BVH 和射线是 Node 22 里对 2000 条射向场景的射线取的平均。）

- 画面：WebGPU 与 WebGL 两个后端对同一视角的截图一致；sRGB → 线性之后颜色与原始数据相符（不转时整体发白）。
- 轴向：狮子（SPZ 3）在默认 `'-y'` 下是正的；番茄（SPZ 4）要 `'+y'`。
- 拾取：场景中心命中图层，距离在包围球近侧；场景旁边命中地球；`pickAt` 给出 `kind: 'splats'` 和正确的经纬度。
- 显存：加载 → 裁剪 → 取消裁剪 → 移除，`renderer.info.memory.total` 回到基线，再循环 3 次不增长（两个后端）。
- 静止：小场景下视图进入静止并完成超采样；改 `opacity` 后被唤醒。
- `npm run smoke`：新增"高斯泼溅"用例（WebGL / WebGPU 各一）。
- 层级绑定（2026-11-23，同一环境）：示例办公楼文档里声明的场景绑在大堂上，进入建筑后才加载；绑在二层的场景在地球和建筑层级不加载、不显示，进入二层后加载，模型不透明度 0 时房间仍能拾取（WebGL 的 CPU 射线和 WebGPU 的拾取缓冲都认），悬停 / 选中的描边和顶牌照常显示在实景上；楼层展开时场景随楼层上移 7 m；地球上的图层 `follow` 进建筑坐标系再解除，位置变化不到 1 cm、heading 复原；移除建筑带走文档声明的图层，按 id 绑定的保留并等待。

## 10. 测试

- `tests/splats.test.ts`：协方差；`.splat` / `.ply`（含球谐的通道重排、普通点云、压缩和 ASCII 的报错、截断）/ `.spz` 2、3、4 版（定点位置、两种四元数编码、球谐分阶、Zstandard 回调及其失败）；格式判断；核心包围盒不含离群点；预算（先去不可见、再按重要度、保持文件顺序、同分时仍满足预算）；裁剪与压缩各属性；显存估算；档位预算递增；轴向矩阵、枢轴、模型矩阵（枢轴落在锚点、heading 顺时针、pitch / roll 方向、长度与手性）；屏幕半径与视锥测试；拾取（表面距离、穿过稀薄漂浮物、掩码、距离上限、与暴力遍历逐条一致、空集）；演示应用的 URL 参数。
- `tests/levelBinding.test.ts`：层级关系与各显示方式的真值表、默认方式；绑定随层级切换（含事件触发前已切换）、`'entity'` 方式与自定义函数、按 id 先绑定后加载和建筑重载、模型不透明度（未就绪不让位、与层级半透明互不覆盖、重叠取最小、解除后恢复）；文档 `splats` 的解析与报错路径、交给宿主并随建筑移除；坐标系朝向。
- `tests/e2e/demo.e2e.ts`："绑定到层级"用例：文档声明的场景、懒加载、进入楼层后显示、模型隐去后的拾取（场景上归到楼层内的实体、场景旁仍拾取到房间）、3D Tiles 的三种绑定、楼层展开跟随、`follow` 往返、移除建筑。
- `tests/e2e/demo.e2e.ts`："高斯泼溅"用例：`?splats=` 从 URL 加载生成的 `.splat`（`tests/e2e/server.mjs`）、贴地、拾取（场景上 / 场景旁）、真实鼠标单击到达 `interaction`、裁剪后数量和显存、移动后原处拾取落空、从字节加载第二个图层、坏文件的错误码、移除后显存归零、加载用的 Worker 都已关闭。

**手测清单**（真实 GPU，改了 `src/splats/` 后看）：

- 三个示例场景各加载一次：方向正、颜色不发白、边缘没有硬边或黑边。
- 绕场景转一圈：没有成片的前后顺序错乱（排序范围）；从全球视角飞近，场景在几个像素大时淡入。
- 滚轮对着场景缩放：光标下的点不漂；右键环绕以场景上的点为枢轴。
- `?demo` 进入建筑：室外的泼溅隐藏，返回后恢复；大堂里的示意实景在进入建筑后出现，点它选中的是"入口大堂"。
- 面板里把一个场景绑到当前楼层并勾"跟随"，把"模型"拖到 0：模型消失，悬停房间仍有描边和顶牌；打开"楼层展开"，场景跟着那一层走。
- 状态栏的显存在移除图层后回落。

## 11. 分期

| 期 | 内容 | 依赖 / 备注 |
| --- | --- | --- |
| **一（本次）** | 单文件图层：三种格式、Worker 解码、预算、锚定、显示选项、CPU 拾取与事件、裁剪、演示面板 | — |
| 二：与孪生场景结合 | ① ✅ 2026-11-23 层级绑定（§7.1）：`level` 选项、实体坐标系、懒加载、拾取归实体、模型不透明度、建筑文档的 `splats`；3D Tiles 同样可绑。② 对齐工具：在泼溅和地面 / 模型上各点几对点，解出 `scale` / `heading` / 位置（相似变换）。③ 按区域裁切（局部场景的 `regionMaskNode`，需要逐泼溅的顶点阶段入口）。④ 隐藏已久的绑定图层按总预算卸载（多层实景轮流看时显存只增不减）。⑤ 绑定内容计入实体的包围范围（纯实景的层级取景）、点位 / GeoJSON 图层的 `level` 选项、通用层级节点（园区） | ③ 要么等 three 给 `GaussianSplat` 开放顶点阶段，要么自己维护一份着色器；④ 参照楼层模型的 `modelBudget` |
| 三：大场景 | ① 3D Tiles 内嵌泼溅（glTF `KHR_gaussian_splatting`，SPZ 压缩扩展）：分块、LOD、流式，走 `Tiles3DLayer` 的预算和调度；② 压缩 PLY、`.ksplat`、SOG；③ 多图层合并排序（现在图层之间只按图层中心排） | ① 评估 3DTilesRendererJS 的 3DGS 插件（README 里列的社区插件）和 three 的 `GLTFGaussianSplatLoaderExtension`；注意 `processTileModel` 里换材质的约束（AGENTS.md §3.5） |
| 四：画质与分析 | ① 深度预通道（不透明度过阈值的泼溅写深度）：让顶牌遮挡、层级过渡重投影、后画的透明物体认得泼溅，并可进拾取缓冲；② 测量（两次拾取）、选中高亮（按包围盒或涂选的泼溅集合改色）；③ 空气透视；④ 远处用 `maxSplats` 的动态子集（按距离降采样） | ① 是一次额外的全量泼溅绘制，先在真实 GPU 上量开销 |

## 12. 数据来源与合规

- 演示应用的示例场景从 GitHub 加载 three.js 示例库的文件，不随包发布、不入库；各自 CC BY 4.0，作者见 `demo/data/demoSplats.ts` 和按钮提示。用在产品演示里要保留署名。
- 实拍数据可能含人脸、车牌、内部设施；它和倾斜摄影一样属于测绘成果的范畴，对外发布前按所在地的要求处理（脱敏、审批）。SDK 不上传、不缓存数据。
- 泼溅文件没有坐标参考信息：经纬度、朝向、尺度都由宿主给。需要厘米级对齐时在训练前用控制点做好配准，或等第二期的对齐工具。
