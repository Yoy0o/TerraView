# 显存与硬件档位（GPU 内存盘点、配置建议、3D Tiles 预算）

代码：`src/core/gpuProfile.ts`（档位与预算表、档位识别、帧缓冲估算，纯函数）、`src/tiles3d/lodPolicy.ts`（远处放宽、缓存满时自适应降精度，纯函数）、`src/tiles3d/Tiles3DLayer.ts`（把预算交给 3DTilesRendererJS）、`src/tiles3d/nodeMaterials.ts`（瓦片纹理过滤策略）、`src/globe/Globe.ts`（`gpuBytes`、`releaseHidden`）、`src/indoor/modelBudget.ts`（建筑模型的按需加载与卸载规则、字节估算）、`src/viewer/GeoViewer.ts`（识别适配器、`viewer.gpu`、`viewer.memory`）。测试：`tests/gpuProfile.test.ts`、`tests/models.test.ts`。

先说三件容易想错的事：

1. **浏览器不告诉页面显存有多大、用了多少。** WebGPU 只给厂商、架构名和各项上限（`adapter.info`、`adapter.limits`）。所以档位是猜的，随时可以用 `?gpu=` 或 `gpuTier` 指定；`viewer.memory` 是对自己分配的资源求和，用来比较设置，不是精确值。
2. **3D Tiles 的"缓存字节数"大部分在内存，不在显存。** 库的 `lruCache` 统计的是所有已解码瓦片（几何 + RGBA 纹理），不管有没有上传；真正在显存里的只有"可见 + 隐藏但尚未释放"的那部分，由 `UnloadTilesPlugin` 单独统计。
3. **Windows 上 `powerPreference: 'high-performance'` 目前被 Chrome 忽略**（crbug.com/369219127，控制台有警告）。双显卡笔记本可能跑在集显上：本机同一台机器，Chrome 拿到 `nvidia lovelace`，应用内置浏览器拿到 `intel xe-lpg`。要用独显，在"Windows 设置 → 显示 → 图形"里把浏览器设为"高性能"。

## 1. 显存都花在哪（代码现状）

| 部分 | 代码 | 占用规律 | 受什么控制 |
| --- | --- | --- | --- |
| 画布帧缓冲 | `GeoViewer.create`（`antialias`、`reversedDepthBuffer`）、`setPixelRatio` | 每像素：交换链颜色 4 B + 深度（32 位浮点）4 B；4× MSAA 时颜色和深度都乘 4 再加解析目标，共 36 B / 像素，不开 MSAA 是 8 B / 像素 | 画布像素数（CSS 尺寸 × 像素比²）、`maxPixelRatio`、`antialias` |
| 描边、发光（M3.2） | `post/OutlineEffect`、`post/GlowEffect`（`viewer.postProcessing`） | 只在有对象描边 / 发光时分配和运行。描边：遮罩（两个 RGBA8 输出 + 深度）和边缘各一张，共 16 B × 遮罩像素；发光：RGBA16F 遮罩 + 深度 12 B × 遮罩像素，加 bloom 的半分辨率链（约每画布像素 3.4 B）。遮罩在像素比 > 1.5 时是半分辨率。1080p、像素比 1 时描边约 33 MB、再加发光约 32 MB；计入 `framebuffers`。场景 pass 的 HDR 目标取代渲染器自带的那张，不额外占用 | 画布像素数、是否有对象描边 / 发光 |
| 静止超采样历史（M3.3） | `post/PostPipeline`（`viewer.supersampling`） | 一张 RGBA16F、画布大小，8 B / 像素（不带 MSAA）：1080p 约 16 MB，2K 约 28 MB，4K 约 66 MB。第一次超采样时分配，`supersampling.enabled = false` 时释放；计入 `framebuffers` | 画布像素数、是否开超采样 |
| 拾取缓冲 | `PickBuffer`（半分辨率 `RGBA32Uint` + 深度） | 20 B × ¼ 画布像素，即每个画布像素 5 B；第一次拾取时才分配 | 画布像素数、`scale`（默认 0.5） |
| 地球瓦片 | `Globe`：影像 / 叠加层纹理（`SharedTexture`，祖孙共享、引用计数）、每瓦片网格 | 256 px 影像带 mipmap 约 0.35 MB / 张；实测 39 块瓦片 13 MB，约 0.33 MB / 块。512 px 的影像源是 4 倍 | `maxCachedTiles`、`maxAnisotropy`（不占显存，只影响采样开销）、影像源瓦片尺寸 |
| 3D Tiles（显存） | `UnloadTilesPlugin`（每个图层一个） | Google 真实感瓦片：纹理 256×256 / 256×512 / 512×512 的 JPEG，解码成 RGBA8，带 mipmap 时 0.35–1.4 MB / 张；几何约 65 KB / 块。实测平均 0.8 MB / 块 | `TilesQuality.gpuBytesTarget`、`unloadDelayMs`、`mipmaps` |
| 3D Tiles（解码缓存，主要是内存） | 库的 `lruCache`（所有图层共用一个） | 可见瓦片 + 祖先 + 兄弟（库的 `loadAncestors` / `loadSiblings`），约为可见部分的 2.5–3.5 倍 | `cacheMinBytes` / `cacheMaxBytes` |
| 建筑 / 设备 | `InstanceBatch`、`StylePool`、glTF 模型（`Building`、`modelBudget.ts`） | 设备按几何合批，材质共享；楼层和设备的 glTF 在楼层第一次显示时才加载，隐藏楼层的模型超出预算时卸载；示例办公楼在 MB 量级 | `indoor.modelBytesTarget` / `modelUnloadDelayMs`（按档位给，[indoor-bim.md](indoor-bim.md) §5.4）；贡献剔除只省绘制，不省显存 |
| 楼层环境光遮蔽（M3.4） | `indoor/FloorOcclusion`（`viewer.indoor.ambientOcclusion`） | 每个显示过的楼层一张单通道贴图，1 B / 纹素，纹素约 8 cm，长边不超过档位的 `aoMaxResolution`：60 × 30 m 的楼层约 0.27 MB，示例办公楼 5 层共 1.4 MB；最大 2048² 时 4 MB / 层。烘焙时临时用三张同尺寸的 RGBA8 目标，结束即释放。计入 `buildings` | 楼层数与面积、`indoor.ambientOcclusion`（`enabled`、`texelSize`、`maxResolution`） |
| 日照阴影（M3.9） | `lighting/SunShadows`（`viewer.shadows`） | 一张仅深度的阴影图，24 位深度按 4 B / 纹素：2048² 为 16 MB，4096² 为 64 MB；第一次画阴影时分配（开光照、太阳在地平线以上、视野里有建筑），关掉阴影时释放。另有一张 1×1 的空图。计入 `shadows` | `shadows.mapSize`（默认按档位）、`shadows.enabled` |
| 透明顺序无关混合（M3.9） | `post/PostPipeline`（`viewer.transparency`） | 两张与场景目标同样多重采样的缓冲（RGBA16F + R8），每像素每样本 9 B，加解析后的同尺寸纹理：1280×720、4× MSAA 约 41 MB，1080p 约 93 MB，4K 约 373 MB。只在开了 OIT 且有建筑透明表面要画时分配。计入 `framebuffers` | `transparency.orderIndependent`（默认只在 `ultra` 开）、画布像素数 |
| 体积云（近地） | `clouds/VolumetricClouds`（`viewer.clouds.volumetric`） | 噪声体 64³ RGBA8 1 MB、天气图 1024² RGBA8 4 MB（`low` 512²，1 MB）、云影图（按档位 256–1024²，0.25–4 MB）、追踪目标（历史的 1/4，2 张 RGBA16F）、两张历史（各 2 张 RGBA16F，16 B / 像素）。历史至多画布一半、按档位 16 万–100 万像素：1280×720 `high` 合计约 11 MB，1080p 约 21 MB。第一次显示时分配，计入 `framebuffers`（经 `postProcessing.gpuBytes`）。换画布尺寸时重建（被材质长期绑定的目标不改尺寸） | `clouds.volumetric.enabled`（`low` 默认关）、`GpuProfile.clouds` |
| 注记图集 | `LabelManager`（`AtlasPage`，无 mipmap） | 每页最大 `MAX_PAGE²` × 4 B，按需分页 | 注记数量 |
| 云层、星空、展台背景、遮挡代理 | `CloudLayer` 等 | 一张云图 + 少量顶点，固定且小 | — |
| 层级切换过渡（P3.4） | `post/LevelTransition` | 只在过渡期间（默认 0.45 s）：截帧 RGBA8 + 视距 R32F + 重投影结果 RGBA8，共 12 B / 像素，加每 4 CSS 像素一个点的网格（1080p 约 13 万个顶点、26 万个三角形，约 6 MB）；1080p 合计约 31 MB，结束即释放，计入 `framebuffers` | 画布像素数 |

`viewer.memory` 汇总前五项（`framebuffers`、`globe`、`tilesGpu`、`buildings`、`shadows`，合计 `gpuTotal`；`buildings` 是已加载的 glTF 模型加上楼层 AO 贴图，不含程序生成的楼板、墙和合批实例数据）和 3D Tiles 解码缓存（`tilesCache` / `tilesCacheMax`），状态栏显示为"显存≈N MB · 建筑模型 m MB（3D 缓存 a / b MB）"（建筑模型不足 1 MB 时不显示）。浏览器自身的合成器、解码中的位图、驱动开销不在其中，实际进程显存通常再多 150–300 MB。

### 帧缓冲随分辨率的变化

| 画布（设备像素） | 典型场景 | 不开 MSAA | 4× MSAA | 拾取缓冲 |
| --- | --- | --- | --- | --- |
| 1920×1080 | 1080p，像素比 1 | 16 MB | 71 MB | 10 MB |
| 2560×1440 | 2K，像素比 1 | 28 MB | 127 MB | 18 MB |
| 2880×1620 | 4K 屏 200% 缩放，像素比封顶 1.5 | 36 MB | 160 MB | 22 MB |
| 3840×2160 | 4K 屏，像素比封顶 2（或 100% 缩放） | 63 MB | 285 MB | 40 MB |

4K 满分辨率加 MSAA，光帧缓冲就超过 300 MB，而且填充率同样是 1080p 的 4 倍。集显机器上这是最该先砍的一项，所以 `low` 档关 MSAA、像素比封顶 1。

## 2. 硬件信息与参数表

页面能读到的硬件信息，以及它们在哪里用：

| 信息 | 来源 | 用途 |
| --- | --- | --- |
| 厂商、架构 | `GPUAdapterInfo.vendor` / `architecture`（如 `nvidia` / `lovelace`、`intel` / `xe-lpg`、`amd` / `rdna-3`、`apple`） | `classifyGpu` 分档 |
| 软件渲染 | `isFallbackAdapter` | 直接 `low` |
| 最大纹理尺寸 | `adapter.limits.maxTextureDimension2D`（桌面 8192 / 16384） | 小于 8192 视为受限设备，`low` |
| 系统内存 | `navigator.deviceMemory`（仅 Chromium，取整且有上限） | ≤ 4 GB 直接 `low`；Apple 芯片 < 8 GB 为 `medium` |
| 逻辑核心数 | `navigator.hardwareConcurrency` | 没有 WebGPU 时的兜底：≥ 8 核 `medium`，否则 `low` |
| 移动设备 | UA | 直接 `low` |
| 显存大小、已用显存 | **读不到** | — |

分档规则（`classifyGpu`）：NVIDIA → `high`；Intel 独显（`xe-hpg` / `xe2-hpg`）→ `high`，Intel 集显 → `medium`；Apple → `high`；AMD 和未知厂商 → `medium`（AMD 的架构名分不出集显和独显，用独显的请加 `?gpu=high`）；高通 / ARM / Imagination → `low`。`ultra` 永远不自动选。

各档位的参数（`gpuProfile(tier)`，可在 `viewer.gpu` 上查看；显式传入的 `antialias`、`maxPixelRatio`、`maxCachedTiles`、`maxAnisotropy`、图层的 `errorTarget` / `errorFalloff` 优先）：

| 参数 | low | medium | high | ultra | 说明 |
| --- | --- | --- | --- | --- | --- |
| `maxPixelRatio` | 1 | 1.5 | 2 | 2 | 画布像素比上限 |
| `antialias`（4× MSAA） | 关 | 开 | 开 | 开 | 创建渲染器时定死，运行中不能改 |
| `globe.maxCachedTiles` | 300 | 500 | 700 | 1000 | 地球瓦片缓存块数 |
| `globe.maxAnisotropy` | 2 | 4 | 8 | 16 | 影像各向异性 |
| `globe.hiddenReleaseSeconds` / `hiddenKeepTiles` | 5 s / 16 | 10 s / 32 | 20 s / 64 | 60 s / 128 | 地球隐藏多久后释放缓存、保留多少块（§4） |
| `tiles.errorTargetScale` | 1.5 | 1.2 | 1 | 0.8 | 乘在图层 `errorTarget` 上 |
| `tiles.errorFalloffScale` | 1.5 | 1 | 1 | 0.5 | 远处额外允许的误差，以 `errorTarget` 的倍数计（§5.1） |
| `tiles.adaptiveErrorMaxScale` | 2.5 | 2 | 2 | 1.5 | 缓存满时 `errorTarget` 最多放大到几倍（§5.2） |
| `tiles.cacheMinBytes` / `cacheMaxBytes` | 192 / 256 MB | 320 / 448 MB | 512 / 768 MB | 1024 / 1536 MB | 解码缓存：淘汰到下限、到上限停止加载 |
| `tiles.gpuBytesTarget` | 128 MB | 256 MB | 384 MB | 768 MB | 显存目标：超过它才释放隐藏瓦片 |
| `tiles.unloadDelayMs` | 1500 | 3000 | 3000 | 5000 | 瓦片隐藏多久后才可以从显存释放 |
| `tiles.mipmaps` | 关 | 开 | 开 | 开 | 关掉省四分之一纹理显存，斜视地面移动时会闪 |
| `tiles.anisotropy` | 1 | 2 | 4 | 8 | 瓦片纹理各向异性（需要 mipmap） |
| `tiles.maxTilesProcessed` | 60 | 100 | 150 | 250 | 每帧最多初始化多少个瓦片节点 |
| `tiles.parseJobs` / `downloadJobs` | 3 / 12 | 4 / 20 | 5 / 25 | 6 / 30 | 并发解析 / 下载 |
| `indoor.modelBytesTarget` | 64 MB | 128 MB | 256 MB | 512 MB | 建筑模型预算：超过时卸载隐藏楼层的模型（[indoor-bim.md](indoor-bim.md) §5.4） |
| `indoor.unloadDelayMs` | 5000 | 10000 | 10000 | 20000 | 楼层隐藏多久后才可以卸载它的模型 |
| `indoor.aoMaxResolution` | 512 | 1024 | 1024 | 2048 | 楼层 AO 贴图长边的纹素上限（[indoor-bim.md](indoor-bim.md) §5.6） |
| `shadows.enabled` / `shadows.mapSize` | 关 / 1024 | 开 / 2048 | 开 / 2048 | 开 / 4096 | 日照阴影的默认开关和阴影图边长（[api.md](../api.md) §1.11）；`low` 档关掉是因为每次重画阴影图要多画一遍建筑，而且接收方每个像素多 16 次比较采样 |
| `clouds`（体积云：默认开关 / 历史像素上限 / 步数 / 朝太阳步数 / 云影图边长） | 关 / 16 万 / 48 / 4 / 256 | 开 / 30 万 / 64 / 5 / 512 | 开 / 52 万 / 96 / 6 / 512 | 开 / 100 万 / 128 / 6 / 1024 | 体积云的画质与开销（[volumetric-clouds.md](volumetric-clouds.md) §8）；`low` 默认关：每像素几十步光线步进对集成显卡太重，用 `clouds.set({ volumetric: true })` 仍可打开 |
| `orderIndependentTransparency` | 关 | 关 | 关 | 开 | 建筑透明表面的顺序无关混合；多重采样的两张缓冲随画布像素数增长，`high` 档 4K 下也要多三百多 MB，所以只在 `ultra` 默认开 |

`high` 档的画布和地球参数与引入档位之前完全一致；3D Tiles 的缓存和显存目标比以前大（以前是库默认的 307 / 410 MB 和 192 MB）。

## 3. 配置建议：最低、推荐主流、最优

显存估算 = 帧缓冲 + 拾取缓冲 + 地球缓存（0.33 MB / 块）+ 3D Tiles 显存目标，再留出浏览器自身的 150–300 MB。实测只覆盖一台机器（RTX 40 系独显 + Intel Xe-LPG 集显，Chrome，1920×900）；其余是按预算表推算的，换硬件后以状态栏读数为准。

| | 最低可用 | 推荐主流 | 最优 |
| --- | --- | --- | --- |
| 对应档位 | `low` | `medium`（集显）/ `high`（独显） | `ultra`（手动指定 `?gpu=ultra`） |
| 显卡 | Intel UHD 620 / Iris Xe、同级 AMD 集显；或无 WebGPU 时的 WebGL 2 | 集显：Intel Arc / Xe-LPG、Radeon 780M 及以上；独显：GTX 1650 / 1660、RTX 3050–4060（4–8 GB）；Apple M1 及以上 | RTX 4070 / RX 7800 XT 及以上（12 GB 起） |
| 内存 | 8 GB（集显共享内存，实际可用显存约 2–4 GB） | 16 GB（集显机器建议双通道） | 32 GB |
| 屏幕 | 1080p，像素比按 1 渲染 | 1080p–2K；4K 屏按像素比 1.5（集显）或 2（独显）渲染 | 4K 满分辨率 |
| 浏览器 | Chrome / Edge 113+（WebGPU）；更旧或被禁用时自动退回 WebGL 2 | Chrome / Edge 当前版本；Safari 26+ | 同左 |
| 本应用显存估算 | 约 0.25 GB：帧缓冲 16 + 拾取 10 + 地球 100 + 3D Tiles 128 | 集显 1080p 约 0.5 GB（71 + 10 + 165 + 256）；独显 2K 约 0.8 GB（127 + 18 + 231 + 384） | 4K 约 1.4 GB（285 + 40 + 330 + 768） |
| 本应用内存里的瓦片缓存上限 | 256 MB | 448 MB / 768 MB | 1536 MB |
| Google 3D Tiles 的表现 | 有效误差 30 px（`errorTarget` 20 × 1.5），远处再放宽；无 mipmap、无抗锯齿，移动时远处有闪烁；缓存不够时自动再降，状态栏提示"降精度" | 全精度（独显）或略粗（集显 ×1.2）；回头看不需要重新上传 | 误差 16 px，远处只放宽一半；长距离飞行很少重新加载 |

不满足"最低"的机器（4 GB 内存的老笔记本、手机）也能打开，同样落在 `low` 档，只是 Google 3D Tiles 会长期处于降精度状态。

## 4. 地球隐藏时释放缓存

加载 Google 3D Tiles 时地球被隐藏（`showGlobe = false`），`Globe.update()` 不再运行，原来的淘汰逻辑也就不运行：最多 700 块瓦片的纹理和网格一直占着显存（约 230 MB），而这正是 3D Tiles 最需要显存的时候。

现在地球连续隐藏超过 `hiddenReleaseSeconds` 后，`GeoViewer` 调用 `globe.releaseHidden(hiddenKeepTiles)`：从叶子开始卸载到只剩几十块，根瓦片永远保留。重新显示时地球立刻有东西可画，其余从浏览器 HTTP 缓存重新加载。短暂切换（小于该时间）不受影响。`releaseHidden` 会把帧号前跳两帧，让下一次 `update()` 像第一帧那样重新选择，不走"上一帧在屏幕上"的捷径。

## 5. 3D Tiles 的加载与显存策略

引入档位之前的问题（Google 真实感 3D Tiles，洛杉矶市区，画布 1920×945，`errorTarget` 20，RTX 40 系独显）：

- 高度 700 m、俯仰 -30° 的静止视角需要 554 块瓦片在缓存里（313 MB），其中只有 172 块可见、在显存里（192 MB）。视角一动，旧的 192 MB 显存目标就已经顶满，"隐藏瓦片保留在显存"实际没有余量。
- 压低到 450 m、俯仰 -12°，缓存到达库默认上限 410 MB，之后每帧有 104 块瓦片被拒绝加载（`stats.refused`）：画面局部永远停在粗糙层级，同时遍历每帧重新尝试上千次排队。
- 每帧开销主要在 `tiles.update()` 的遍历和节点初始化，纹理上传和管线创建是次要的（单帧几毫秒）。

改动前后的同条件对比（同一窗口、前台、同一段脚本；"旧"是 main 上的代码）：

| 场景 | 指标 | 旧 | `high` | `low` |
| --- | --- | --- | --- | --- |
| 700 m / -30° 静止 | 首屏稳定时间 | 21.0 s | 18.0 s | 11.6 s |
| | 在用瓦片 / 可见瓦片 | 550 / 172 | 422 / 128 | 307 / 81 |
| | 解码缓存 | 313 MB | 267 MB | 128 MB |
| | 3D Tiles 显存 | 192 MB | 160 MB | 61 MB |
| | 帧缓冲 | 62 MB | 62 MB | 14 MB |
| | 每帧 CPU（中位数） | 5.4 ms | 4.6 ms | 2.8 ms |
| 平移 2.8 km / 12 s | 帧数 / 超过 33 ms 的帧 | 767 / 1 | 763 / 0 | — |
| | 每帧 CPU（中位数 / P95） | 8.8 / 11.9 ms | 7.2 / 10.2 ms | — |
| 原地转一圈 / 12 s | 帧数 / 超过 33 ms 的帧 | 762 / 0 | 762 / 1 | — |
| 450 m / -12° 静止 | 在用瓦片 / 可见瓦片 | 941 / 290 | 583 / 227 | 317 / 105 |
| | 被拒绝的瓦片（稳定后） | 104 | 0 | 0 |
| | 每帧 CPU（中位数） | 11.2 ms | 9.1 ms | 5.0 ms |
| | 应用显存合计（`viewer.memory.gpuTotal`） | 约 255 MB | 见下 | 100 MB |

怎么读这张表：

- 这台机器在前台窗口里本来就不卡，改动前后都几乎没有超过 33 ms 的帧。收益在"需要的瓦片少了约四分之一"（缓存、显存、每帧 CPU 随之下降）和"缓存不再顶满"上；流畅度的改善要在集显或 4K 上才显现，目前没有实测。
- `high` 档移动之后显存反而比旧设置高：显存目标从 192 MB 提到了档位值，隐藏瓦片会留到目标为止（上表测量时目标是 512 MB，平移后 319 MB、转一圈后 474 MB；之后已把 `high` 下调到 384 MB）。这是用显存换"回头看不重新上传"，可见部分本身是变少的。显存紧张就用更低的档位。
- 自动化浏览器窗口被遮挡或最小化时 Worker 和定时器被节流，解析队列会堆到 200 以上、卡顿帧成倍增加，那不是真实表现（AGENTS.md §6 第 4 条）。

### 5.1 远处放宽（`errorFalloff`）

斜视时视野伸到几十公里外，远处瓦片和近处按同样的像素误差加载，数量占了大头。库提供 `errorFalloff` / `errorFalloffDensity`（`error -= errorFalloff × (1 − exp(−(距离 × 密度)²))`，与地球的地平线雾放宽是同一个公式，都借鉴 CesiumJS），原来没有启用。

`Tiles3DLayer.update(dt, view)` 每帧设置：

- `errorFalloff = 图层.errorFalloff（默认取档位的 errorFalloffScale） × 当前 errorTarget`；
- `errorFalloffDensity = tilesFalloffDensity(离地高度, 视线·天顶)` = `2e-4 × (1 − cos²) × 高度淡出`。垂直俯视时为 0（没有"远处"）；离地 2 km 以上逐渐减弱，12 km 以上为 0（从高空看一切都远，不能整体变糊）。

俯仰 -30°、700 m 时密度是 1.5e-4：5 km 外放宽约 43%，10 km 外约 89%。效果见上表（700 m 视角在用瓦片 550 → 422，450 m 视角 941 → 583）。画面上远处略粗，近处和画面中心不变。

离地高度取自相机防入地用的地面查询（`viewGround`），地球显示时取地形高度；`view` 不传则不放宽。

### 5.2 缓存满时自适应降精度

缓存到上限后库只会拒绝加载。`stepAdaptiveError`（`lodPolicy.ts`）把它变成"整体略粗"而不是"局部永远糊"：

- 连续 0.4 s 以上有瓦片被拒绝：`errorTarget` 的倍数每秒涨 35%，上限 `adaptiveErrorMaxScale`；
- 没有拒绝，并且**在用瓦片**的字节数低于 `cacheMinBytes` 的 85% 持续 3 s：每秒降 6%，回到 1 为止。

在真实数据上验证过：把缓存上限临时压到 90 MB，倍数 4 s 内升到 1.46 后稳定（不再有拒绝，也不振荡）；恢复上限后约 20 s 回到 1。

判断"有余量"必须看在用瓦片（`tiles.usedSet`），不能看缓存总量：缓存总量会被没用到的瓦片一直填到 `cacheMinBytes`，永远看不出余量。涨快降慢、两个门槛之间留出间隔，是为了不让升降互相追逐。当前倍数在 `layer.errorScale`，大于 1 时状态栏显示"降精度 ×n"。

### 5.3 预算按档位给

- 解码缓存 `cacheMinBytes` / `cacheMaxBytes`：库里所有图层共用一个 `lruCache`，所以是整页一份预算，最后添加的图层设置它。
- 显存目标 `gpuBytesTarget`：是"该图层在显存里的总量"目标，不是"隐藏瓦片可以另外占多少"。可见瓦片不会被释放，所以可见部分超过目标时，隐藏的瓦片过了 `unloadDelayMs` 就全部释放。`high` 档给 384 MB，是为了在 1080p–2K 下可见部分（约 160–230 MB）之外还留得下转身回看的那一圈；实测上传本身只占每帧几毫秒，再多留收益很小。
- `maxTilesProcessed`：限制每帧初始化的瓦片节点数，削掉打开新子树时的遍历尖峰。

### 5.4 纹理过滤

瓦片纹理由 glTF 加载器按三线性过滤、各向异性 1 创建，斜视地面发糊。`applyTexturePolicy` 在 `processTileModel` 里（纹理上传之前）设置各向异性，不增加显存。`low` 档关掉 mipmap：每张纹理省四分之一显存，上传时也不用逐级生成，代价是移动时斜视地面闪烁。压缩纹理（KTX2）自带 mip 链，不改。

必须在上传前设置：GPU 纹理创建时就决定了有没有 mip 链，之后改 `generateMipmaps` 不生效。

## 6. 调参与排查

| 现象 | 看什么 | 怎么调 |
| --- | --- | --- |
| 画面局部一直糊、状态栏"降精度"长期不消失 | `viewer.memory.tilesCache` 贴着 `tilesCacheMax`；`layer.memory.refused > 0` | 换更高档位（`?gpu=high`）；或调大图层 `errorTarget`；或缩小窗口 / 降低像素比 |
| 转身回看时卡顿、瓦片重新淡入 | `layer.memory.gpuBytes` 贴着 `viewer.gpu.tiles.gpuBytesTarget` | 提高档位；可见部分本身超过目标时只能降精度 |
| 集显机器整体帧率低 | 状态栏 GPU 毫秒数、徽标提示里的像素比和 MSAA | `?gpu=low`（关 MSAA、像素比 1）通常比降瓦片精度更有效 |
| 双显卡笔记本拿到集显 | 徽标提示里的适配器名 | Windows 图形设置里把浏览器设为"高性能"；`powerPreference` 在 Windows 上无效 |
| 远处太粗 | — | 图层选项 `errorFalloff: 0` 关闭远处放宽，或设成 0.5 |
| 想看实际预算 | `viewer.gpu`、`viewer.info.tier` / `tierSource` | — |

新增占显存的东西时：给它一个能估算字节数的读数并加进 `viewer.memory`；预算放进 `GpuProfile` 按档位给，不要写死常量；不可见时要有释放路径（别依赖"每帧 update 里顺便淘汰"，隐藏的东西不会被 update）。
