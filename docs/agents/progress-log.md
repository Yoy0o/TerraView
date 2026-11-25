# 改造记录与计划（时间线）

> 建立于 2026-11-11。本文只记录"什么时候改了什么、接下来改什么"，不展开设计细节：设计和验收写在各专题文档和 [roadmap.md](roadmap.md)，发布说明写在 [CHANGELOG.md](../../CHANGELOG.md)。

> **2026-11-11 迁移**：代码从 three-geo-global（`main`，`be3bbbd`）迁到 TerraView 仓库并改造成 SDK（[roadmap.md](roadmap.md) §10.0，路径对应见 [AGENTS.md](../../AGENTS.md) §8）。本文 §1–§3 记录的是迁移前在源仓库里的改造，提交号和 Hub 任务编号都指源仓库；TerraView 没有接入 agent-hub，迁移之后的改造直接记在 §2.3 和 §7。

三份文档的分工：

| 文档 | 回答的问题 | 粒度 |
| --- | --- | --- |
| 本文 | 哪天改了什么、对应哪个 Hub 任务和提交、还剩什么可做 | 时间线 + 待办清单 |
| [roadmap.md](roadmap.md) | 每一项为什么做、怎么做、怎么验收 | 单项方案 |
| [CHANGELOG.md](../../CHANGELOG.md) | 使用者能看到的变化（API、行为、修复） | 版本说明 |

## 0. 约定

- **时间**：北京时间（UTC+8）。"提交"取 Git 提交时间；"合并"取合并到 main 的时间。2026-11-04 至 11-06 是分批提交，提交时间晚于实际开发时间，只能当作"不晚于"。
- **Hub 任务**：agent-hub 的 `three-geo-global` 项目从 2026-11-09 起使用，之前的改造没有 Hub 任务（标 `—`）。
- **状态**：✅ 已合并到 main；🟡 已记录但被阻塞；⬜ 未开始。
- **维护**：每个任务合并后，在 §2 追加一行、在 §3 更新状态、在 §4 划掉对应的待办。回执提交到 Hub 之后再改本文，避免两边对不上。

## 1. 现状一览（2026-11-12；2026-11-19 更新后两行）

| 项 | 数量 |
| --- | --- |
| Hub 上 `three-geo-global` 任务（源仓库，留作历史） | 11 个：10 个已合并，1 个待验收（`T261109-ppn`，SDK 迁移收口，结论在源仓库未合并的分支上，见 roadmap §10.5） |
| 有 Hub 任务的已完成项 | 9（见 §3） |
| Hub 之前完成的大块改造 | 约 10 块（§2 的 11-04 至 11-06） |
| SDK（roadmap §10） | S1–S4 完成；S5、S6、S8 大部分完成；S7 部分完成 |
| roadmap 里未开始的里程碑项 | M3.7、M4.1–M4.7、M4.8 除高斯泼溅以外的项（全景、粒子、假室内、天气）、M5.2、M5.3（M5.1 只做了 JSON 快照）；其余 M0–M3 项都已完成（2026-11-19，含 M3.9）；M4.8 的高斯泼溅第一期完成（2026-11-22） |
| 当前执行顺序 | roadmap §0.2：P0、P1、P2、P3.1–P3.6 已完成（0.2.0 于 2026-11-25 发布，npm 包 `terra-viewer`）；首发后插入的使用手册、示例与文档站点 2026-11-25 完成（D5）；P3 余项（M3.7）、P4、P5 按需求 |

## 2. 已改造时间线

按合并（或提交）时间排列。"文档"一列是该项的详细说明所在。

### 2.1 Hub 接入之前（2026-11-04 至 11-06）

| 日期 | 改造 | 路线图项 | 提交 | 文档 |
| --- | --- | --- | --- | --- |
| 11-04 12:26 | WebGPU 优先三维地球：WGS84 椭球、四叉树影像与地形、大气、星空 | — | `a4429ec` | README |
| 11-04 12:26 | GeoJSON 矢量（Worker 解析 + 贴地栅格化）与注记 | — | `31bbaed` | README |
| 11-04 12:26 | 栅格叠加层、更多地形源 | — | `6476709` | README |
| 11-04 16:58 | 瓦片加载初版：影像交叉淡入、地形分块、Worker 协议 | — | `d5d5c23` | [tile-loading.md](tile-loading.md) |
| 11-04 16:58 | 相机控制器重做：真实大地垂线、俯仰 / 航向环绕、飞行偏移 | — | `64cbb93` | [camera-controller.md](camera-controller.md) |
| 11-04 16:58 | 统一拾取与交互事件、顶牌、3D Tiles 节点材质 | — | `c6b2bb6` | AGENTS.md §3.7 |
| 11-04 16:58 | 室内 / BIM：建筑 → 楼层 → 房间层级、示例楼（`?demo`） | — | `23fe145` `97b86e7` | [indoor-bim.md](indoor-bim.md) |
| 11-04 17:58 | 路线图文档建立（对照 t3d 生态、参考平台） | — | `4cda58b` | [roadmap.md](roadmap.md) |
| 11-05 16:29–16:31 | 地球瓦片调度借鉴 CesiumJS：选择记忆、不丢细节守卫、象限填充、兄弟预建、地形渐变、影像合并揭示、取消即释放、空闲预取 | roadmap §8.3 | `e3a9527` `adee55c` `ead214f` `5c87455` `87ffe1c` | [tile-loading.md](tile-loading.md) |
| 11-05 | 修复 TSL 纹理槽被合并（交叉淡入重影的根因）；HTTP/1.1 影像源按域名限流 | — | `e3a9527` `adee55c` | AGENTS.md §7 |
| 11-05 | roadmap 按 three r187 复核（§8） | M0 前置 | — | roadmap §8 |
| 11-06 09:10 | 点位标注：8 种顶牌样式、属性规则、层级聚合树、网格避让、`dense` 模式 | — | `42b6b4b`…`3c03139` | [markers.md](markers.md) |
| 11-06 09:24 | 相机在零尺寸视口下忽略手势并恢复位姿 | — | `962b2c6` | AGENTS.md §7 |
| 11-06 13:58 | **M0** 升级 three r187、3d-tiles-renderer 0.5.4，瓦片材质改 `NodeMaterialInstance` | M0 | `795d5fb` | roadmap M0 |
| 11-06 13:58 | **M1.5** 选择器表达式编译 + 标签 | M1.5 | `7924025` | roadmap M1.5 |
| 11-06 13:58 | **M1.4** 注视飞行（层级间短途） | M1.4 | `a142d1c` | roadmap M1.4 |
| 11-06 13:58 | **M1.1 / M1.2 / M1.3 / M1.6** 层级控制策略、路径切换与视点缓存、最近对角取景、事件选项与顶牌代理 | M1.1–M1.3、M1.6 | `b23e5a2` | [indoor-bim.md](indoor-bim.md) §5–§7 |
| 11-06 13:58 | 无地表时手势兜底（参考地面）、层级切换淡出、展台背景 | 插入项 | `89cf006` | [camera-controller.md](camera-controller.md) §3.4 |
| 11-06 13:58 | 建筑数据制作手册（中文）+ 有单测校验的样例 | 插入项 | `841716a` | [building-data-manual.md](../building-data-manual.md) |
| 11-06 14:00–14:08 | CHANGELOG（0.1.0 与未发布）、roadmap 进度总览、SDK 打包计划（§10） | — | `26a26ca` `373d0b2` | CHANGELOG |

### 2.2 Hub 接入之后（2026-11-09 起）

| 合并时间 | 改造 | Hub 任务 | 路线图项 | 提交 | 用时（Hub） |
| --- | --- | --- | --- | --- | --- |
| 11-09 11:05 | 开场自转动画、程序云层、基础导航控制（`viewer.navigation` + 按钮条，核心 API 与 UI 分离） | `T261109-mez` | 插入项 | `52f8a5b` | 80 分钟 |
| 11-09 11:38 / 11:54 | 缩放抖动排查（云层噪声按像素限带）；自动旋转按视角选择自转 / 环绕 / 先倾斜再环绕 | `T261109-wj4` | 插入项 | `84b2114` `5384ec5` | 95 分钟 |
| 11-09 14:24 | 交互暂停 / 恢复（按类型、tag、选择器范围，可选挡住默认行为） | `T261109-kcz` | M1.6 收尾 | `0b32e32` | 30 分钟 |
| 11-09 14:27 | 统一高程查询 `viewer.surfaceHeight`（地形 / 3D Tiles 竖直射线 / 压制期间沿用缓存）；建筑、点位、防入地、参考地面改用；Google 3D Tiles 实测 | `T261109-b75` | ISSUE-1 | `07939fc` `09b0287` | Hub 未记录 |
| 11-09 16:35 | 设备合批 `InstancedMesh` + 引用计数样式池；`BatchedMesh` 评估写入 roadmap；1 万设备 10,000 → 40 次绘制 | `T261109-0xx` | M3.6 | `6c2efd8` `f89b9d7` | 120 分钟 |
| 11-10 09:40 | GPU 拾取缓冲（`RGBA32Uint`：对象 id、实例 id、深度、八面体法线）；悬停查询 0.005 ms，与设备数无关；CPU 射线兜底 | `T261109-80a` | M2.1 | `a912bb3` `ca188c7` | 150 分钟 |
| 11-10 09:45 | 顶牌遮挡（`occlusion: none / hide / fade`，查询代理池）；合入后在 Google 3D Tiles 下复验 | `T261109-o0a` | M2.2 | `4862501` `66d4fdc` `91c33de` | 90 分钟 |
| 11-10 11:25 | 贡献剔除（默认关闭，阈值 / 回差 / 间隔 / 选择器 / 按类别可配；移植 t3d 算法，已收录 `THIRD_PARTY_NOTICES.md`） | `T261109-beo` | M2.3 | `858c889` `78a1db3` | 75 分钟 |
| 11-10 16:41 | GPU 档位与显存预算；3D Tiles 距离衰减、缓存满时自适应降精度、纹理过滤策略；隐藏地球时释放缓存 | `T261110-npf` | **roadmap 里没有对应项**（插单） | `23f6b63` | Hub 未记录 |
| 11-11 | 补记 GPU 显存插单，新增本文（时间线、Hub 对应、待办），同步 roadmap / CHANGELOG / README | `T261111-lql` | 文档 | `f73ca50`（合并 `97a149c`） | Hub 未记录 |

Hub 有记录的 7 个任务合计 640 分钟（约 10.7 小时），均 0–1 轮 CI，无返工记录。

### 2.3 迁移到 TerraView 之后（2026-11-11 起，提交号指 TerraView 仓库）

| 日期 | 改造 | 路线图项 | 提交 | 文档 |
| --- | --- | --- | --- | --- |
| 11-11 | 工程脚手架：包配置（peer 依赖、exports）、库构建、演示构建、类型声明 | §10 S1、S2 | `fe6b870` | [api.md](../api.md) §1 |
| 11-11 | 导入 SDK 源码与测试（源仓库 `be3bbbd`），新增包入口 `src/index.ts` | §10 S1 | `ff1f3a3` | [api.md](../api.md) §3 |
| 11-11 | 演示应用移到 `demo/`，改为通过 `terra-view` 入口引用 | §10 S1 | `f1de83f` | AGENTS.md §3.10 |
| 11-11 | 样式拆分与 `tv-` 前缀、顶牌层相对容器定位、键盘监听改容器、解码器路径、聚合 Worker 关闭 | §10 S3–S6 | `f04798a` | [api.md](../api.md) §1、CHANGELOG |
| 11-11 | 包名定为 `terra-view`（`terraview` 在 npm 上是占位包，不可用）；CI / 发布工作流、打包自检脚本 `scripts/check-package.mjs` | §10 S1、S8 | 见 Git 记录 | README「持续集成与发布」 |
| 11-11 | 文档迁移与改写（README、AGENTS、api.md、专题文档的路径与类名）、演示应用改名与设置键迁移 | §10 S7 | 见 Git 记录 | 本文 §7 |
| 11-22 | 高斯泼溅图层（第一期）：Worker 解码、预算、锚定、绘制、拾取与事件、裁剪、演示面板 | M4.8 | 见 Git 记录 | [splats.md](splats.md)、[api.md](../api.md) §1.14 |
| 11-23 | 层级绑定：图层挂到层级节点（泼溅、3D Tiles），实体坐标系、懒加载、拾取归实体、建筑文档 `splats` | M4.8 二期 ① | 见 Git 记录 | [indoor-bim.md](indoor-bim.md) §6.5、[splats.md](splats.md) §7.1 |
| 11-24 | 体积云（近地）：天气跟随云壳的积云层，低分辨率交错追踪 + 时域重投影，按场景深度合成；云影乘进日照阴影的接收节点；Worker 生成可平铺噪声 | 插入项 | 见 Git 记录 | [volumetric-clouds.md](volumetric-clouds.md) |
| 11-24 | 单包内重构（G 组）：拆 `GeoViewer`、`Globe`、`VolumetricClouds`，`clouds/`、`region/` 两个目录，消除反向依赖与文件循环，分层检查 `check:layers` | §4 G | `1ae5455`…（见 Git 记录） | AGENTS.md §2、§2.1 |
| 11-25 | 0.2.0 发布：包名由 `terra-view` 改为 `terra-viewer`（`terra-view` 去掉连字符后与 npm 上的 `terraview` 相同，会被拒），去掉 `private`，仓库公开，打标签 `v0.2.0` | P1.7 | 见 Git 记录 | CHANGELOG `[0.2.0]`、[releases/v0.2.0.md](../releases/v0.2.0.md) |
| 11-25 | 使用手册（`docs/guide/`）、16 个可运行示例（`examples/`）、VitePress 文档站点与 GitHub Pages 工作流（手册 + 示例 + 演示应用），示例的浏览器冒烟 | 首发后插入项（D5） | 见 Git 记录 | [roadmap.md](roadmap.md) §0.2"首发后插入项"、AGENTS.md §5 |

## 3. Hub 任务与 roadmap 的对应

| Hub 任务 | 状态 | roadmap 项 | roadmap 是否已记 | 备注 |
| --- | --- | --- | --- | --- |
| `T261109-mez` | 已合并 | 插入项（开场 / 云层 / 导航） | 是（§0.1） | |
| `T261109-wj4` | 已合并 | 插入项（接 mez） | 是（并入 §0.1 的 mez 行） | |
| `T261109-kcz` | 已合并 | M1.6 收尾 | 是 | |
| `T261109-b75` | 已合并 | ISSUE-1（§9） | 是 | 回执 2026-11-11 补交，绑定版本 `98a0286` |
| `T261109-0xx` | 已合并 | M3.6 | 是 | |
| `T261109-80a` | 已合并 | M2.1 | 是 | |
| `T261109-o0a` | 已合并 | M2.2 | 是 | |
| `T261109-beo` | 已合并 | M2.3 | 是 | |
| `T261110-npf` | 已合并 | 无（插单），与 M3.8 的"显存预算"相邻 | 是（2026-11-11 补入 §0.1、CHANGELOG、README） | 只写在 AGENTS.md 和 [gpu-memory.md](gpu-memory.md) |
| `T261111-lql` | 已合并 | 无（文档与记录） | 不适用 | 建立本文、补记 `T261110-npf`、同步 roadmap / CHANGELOG / README；回执已绑定版本 `f73ca50` |
| `T261109-ppn` | **待规格** | SDK S1–S4（§10） | 是（§10，未开始） | 被 §10.4 的四项决定阻塞，见 §5 |

对照结论：

- **没有"Hub 有、roadmap 无"以外的错位**：9 个已合并任务里 8 个在 roadmap §0.1 有对应行，唯一缺口是 `T261110-npf`。
- **反方向**：roadmap 里已完成的 M0、M1.1–M1.5、点位标注、瓦片调度、建筑手册都在 Hub 接入之前完成，没有 Hub 任务，这是正常的，不需要补。
- **roadmap 未开始的项目，Hub 上除 SDK S1–S4 外都没有任务**：下一步每做一项都要先在 Hub 建任务。

Hub 与仓库里需要处理的小问题：

| 问题 | 说明 |
| --- | --- |
| ✅ roadmap / CHANGELOG / README 没有记 `T261110-npf` | 2026-11-11 已补，见 §4 A1 |
| ✅ `T261109-b75` 回执为空 | 2026-11-11 补交：在分支最终提交 `98a0286` 上重新跑了 typecheck / test / build（18 个测试文件、197 个用例通过），用时取 Hub 状态变迁（执行中 → 待评审）53 分钟。`T261110-npf` 没有任务目标和用时：Hub 没有公开的改字段接口，保留为已知缺口，不影响交付 |
| ✅ 已合并任务的 worktree | 2026-11-11 已清理（`T261109-0xx`、`T261110-npf`，分支已一并删除；两个未跟踪的任务单是 Hub 自动生成的，可用 `task.sh brief` 重新拉取） |
| ✅ Hub 上报暂存 | 2026-11-11 已全部补发（暂存 0 条）。根因：Hub 处理一条 PostToolUse 上报要约 4 秒才响应（握手只要 0.5 秒），钩子等不到就进暂存，本机网络本身是通的。补发用并行（每次 6 路）、逐条重试，比 `hub.sh flush` 遇到一次失败就中断快得多；之后钩子仍可能偶尔暂存，`hub.sh ping` 可查 |
| 主工作区有未跟踪的 `pnpm-lock.yaml` | 在 AGENTS.md §8.2 禁区里，不要提交 |

## 4. 计划改造（待办清单）

规模沿用 roadmap 的"工作量"；"建议 Hub 标题"是开任务时可直接用的名字（TerraView 没有接入 Hub，留作任务名参考）。**执行顺序以 [roadmap.md](roadmap.md) §0.2 为准**，本节编号与它的对应关系写在各行里。

### A. 收尾与同步（先做，都很小）

| 编号 | 内容 | 做法 |
| --- | --- | --- |
| A1 ✅ | 文档同步（2026-11-11 完成，`T261111-lql` 合并） | roadmap 版本行和 §0.1 补 GPU 显存插单；CHANGELOG"未发布"补 GPU 档位、3D Tiles 距离衰减 / 自适应误差 / 纹理策略、隐藏地球释放；README"已知限制"里已过期的三条（设备一网格一份材质、顶牌没有深度遮挡、防入地不看 3D Tiles、地形没有几何过渡）和"近期（v0.2）"里已完成的项（统一高程、遮挡、实例化、地形形变）改写 |
| A2 ✅ | 清理已合并任务的 worktree（2026-11-11 完成） | `bash scripts/agent/task.sh clean T261109-0xx` 和 `T261110-npf`；先确认 0xx 里未跟踪的任务单不需要 |
| A3 ✅ | 补齐 Hub 记录（2026-11-11 完成）：暂存已清空，`T261109-b75` 回执已补交，`T261111-lql` 回执已绑定版本；`T261110-npf` 的目标 / 用时因 Hub 无改字段接口保留缺口 | 见 §3 |
| A4 ✅ | 人工验收遗留（2026-11-11 已由人工验证）：真实鼠标缩放下 M2.2 淡出、M2.3 剔除的观感；GPU 档位在其他机器上的识别与状态栏读数；M0 的逐像素截图对比 | 人工 |
| A5 ✅ | 迁移核对与文档残留（roadmap §0.2 P0.1，2026-11-12）：markers.md 旧类名、两处注释旧路径、许可证"未定"、S5 / S6 实测记录从源仓库分支抄入、AGENTS.md 测试清单 | 核对过程见 roadmap §10.5 |
| A6 ✅ | 第三方声明补 CesiumJS 改写部分与 EGM96 数据来源（P0.2，2026-11-12） | `THIRD_PARTY_NOTICES.md` |
| A7 ✅ | `package-lock.json` 根包 `license` 同步为 Apache-2.0（P0.3，2026-11-12，经同意） | 只改该字段 |
| A8 ✅ | 远端 CI 首跑确认（P0.4，2026-11-12）：`441a82c` 触发的第 1 次运行三个 job 全绿 | — |
| A9 ✅ | 源仓库收口（P0.5）：2026-11-12 标为完成，由维护者自行在源仓库处理（清单在本地 `temp/source-repo-wrapup.md`，不入库） | — |
| A10 ✅ | `cad-to-building` 技能与 CAD 数据去留（P0.6）：2026-11-12 决定不迁移，留在源仓库 | — |

### B. 画质与性能

| 编号 | roadmap 项 | 内容 | 前置 | 规模 | 建议 Hub 标题 |
| --- | --- | --- | --- | --- | --- |
| B1 ✅ | M3.3 前半 | **按需渲染**（P2.1）：2026-11-13 评估后先做空闲降帧（P2.1a ✅：安静 1 s 后降到每秒 10 帧、`requestRender()`、容器离屏停帧）；2026-11-18 随 B4 完成停画（超采样画完后不再画帧，变化与唤醒分开，补齐注记、地球、3D Tiles 淡入淡出和相机等信号，roadmap §0.2"P3.3 落地"）。原始说明：相机、瓦片、动画、顶牌都没变化时不渲染新帧，状态栏显示"已静止"。建议从 M3.3 里单独拆出，不依赖后期骨架；要处理云层、开场、拾取缓冲、遮挡代理等各自的"有变化"信号 | 无 | 中 | 按需渲染（静止时不画帧） |
| B2 ✅ | M3.1 | 2026-11-17 完成（P3.1，`src/post/PostPipeline.ts`，[api.md](../api.md) §1.9）。**后期管线骨架**：`RenderPipeline` + `pass` + `mrt`，效果按权重排序、按需声明附件；叠加层放在后期之后 | 无 | 中 | 后期管线骨架 |
| B3 ✅ | M3.2 | 2026-11-17 完成（P3.2，描边用遮罩重绘、发光用遮罩 + BloomNode，[indoor-bim.md](indoor-bim.md) §5.5）。逐物体特效：描边（选中 / 告警，被挡部分 x-ray）、选择性发光；替换现在的 emissive 高亮 | B2 | 中 | 逐物体描边与发光 |
| B4 ✅ | M3.3 后半 | 2026-11-18 完成（P3.3，`viewer.supersampling`、`viewer.colorGrading`，[api.md](../api.md) §1.8、§1.9）。静止超采样（评估 `TRAANode` 后自研：其速度缓冲在 ECEF 尺度不准）、调色预设 | B1、B2 | 中 | 静止超采样与调色 |
| B5 ✅ | M1.4 遗留 | 2026-11-18 完成（P3.4，`viewer.levelTransition`，[indoor-bim.md](indoor-bim.md) §7.1）。DOM 版截帧淡出换成 GPU 版：截帧连同深度留在 GPU，按深度重投影到飞行中的相机后溶解 | B2 | 小 | GPU 版层级过渡 |
| B6 ✅ | M3.8 | 楼层模型按需加载，离开后按显存预算 LRU 卸载；预算统计与 3D Tiles 共用 `gpuProfile`（接 `T261110-npf`）。2026-11-17 完成（P2.2，[indoor-bim.md](indoor-bim.md) §5.4） | 无 | 中 | 楼层按需加载与显存预算 |
| B7 ✅ | M3.4 | 2026-11-19 完成（P3.5，`viewer.indoor.ambientOcclusion`，[indoor-bim.md](indoor-bim.md) §5.6）。楼层 AO 烘焙：俯视遮挡图（楼层上立着的一切，被切开的封闭体露出背面）+ 接触项加权最大值、柔和项平均，读回成单通道贴图，楼板、地面、墙、楼层模型共享 `colorNode` | 无 | 中 | 楼层 AO 烘焙 |
| B8 ✅ | M3.5 | 2026-11-19 完成（P3.5，[api.md](../api.md) §1.10）。光照跟随大气：太阳光色（CPU 版透射率）、天光球谐（`LightProbe`）、建筑 / 设备 / 3D Tiles 的空气透视（共享 `outputNode`）；IBL 未做（没有环境贴图） | 无 | 中 | 光照跟随大气 |
| B9 ✅ | M3.9 | 2026-11-19 完成（P3.6，`viewer.shadows`、`viewer.transparency`，[api.md](../api.md) §1.11）。日照阴影：自管的一张平行光阴影图（`SunLight` 用 float32 世界坐标，ECEF 下不够精确），按包围盒足迹 ∩ 视锥足迹适配，地球、3D Tiles、展台接收；OIT：`OITPassNode` 的算法接进 `PostPipeline`，只处理建筑和设备，默认只在 `ultra` 开 | B2 | 中到大 | 透明与阴影 |
| B10 | M3.7 | 八面体冒名顶替（树、设备等重复模型远处用面片） | 无 | 中 | 八面体冒名顶替 |
| B11 | M2.2 可选 | 顶牌遮挡改查拾取缓冲深度，省掉代理绘制；缓冲半分辨率、最多 0.25 s 刷新，相机运动时不新鲜，**收益存疑，先不做** | — | 小 | （暂缓） |
| B12 ✅ | 体积云后续 | 2026-11-24 完成。① 100–220 km（实测 40 km 起）云格成方块：512² 天气图在相机约 35 km 以上铺满 440 km，纹素 860 m，一个云格约 4 个纹素，双线性插值画成和坐标轴对齐的圆角方块、相邻的云连成片。以 2048² 为参照，512² 有 12–22 % 的像素不同，1024² 只有 0.1–1 %；先试的距离场做法（存到阈值的距离、查图后再 smoothstep）只改变 0.6 % 的像素，没有采用。改为档位设置 `GpuProfile.clouds.weatherSize`：`medium` 及以上 1024²（+3 MB），`low` 仍 512²；每帧追踪开销不变。② 集成显卡实测（Intel Arc / Xe-LPG，`medium` 档，Chrome 用 `--use-adapter-luid` 改到集显；数字按 B13 的测法更正过）：1080p 下 `low` 档的云每帧 +1.4–2.3 ms；`medium`（4× MSAA）+2.4–4.3 ms，云上和 120 km 时到 60 FPS 的边上或以下。`low` 默认维持关（它面向比这块集显更弱的设备，按 3–5 倍估算要 4–10 ms），[volumetric-clouds.md](volumetric-clouds.md) §8、§10 | 无 | 小 | 体积云过渡带与真机性能 |
| B13 ✅ | 体积云在集显上的额外开销 | 2026-11-24 查明：不存在"云影多出约 4 ms"。B12 用 `stats.gpuMs` 比较开关，集显上同一状态的读数几秒内能差 3–8 ms（功耗状态切换），那 4 ms 是波动。改用停掉帧循环、连续提交 24 帧等队列排空、三种状态轮换顺序测 5 轮：云影（云影图 + 接收端）只占 0.1–0.6 ms；`medium` 的云整帧 +2.4–4.3 ms，约为各 pass 重画测出的两倍（每帧第一次执行时缓存是冷的，最终合成没有单独计）。不需要改代码；[volumetric-clouds.md](volumetric-clouds.md) §10 的集显表、B12 的数字和测法说明已更正。若要 `medium` 档在集显 1080p 云上保持 60 FPS，只能降画质（历史像素或步数），这是取舍，留待需要时再定 | B12 | 小 | — |

### C. 地球、3D Tiles 与矢量

来源：[roadmap.md](roadmap.md) §8.3、§9、README"路线图"。

| 编号 | 内容 | 说明 | 规模 |
| --- | --- | --- | --- |
| C1 | 放大时也用象限填充 | 部分子瓦片就绪就能细化，影像请求更早发出 | 小 |
| C2 | 上传预算改按字节和 GPU 时间 | 现在按个数和 CPU 时间 | 小 |
| C3 | 淡入期间由糊到清 | 新影像淡入时 mip 偏置逐步降到 0，减少两层画面叠加的重影感 | 小 |
| C4 | 缩小时父瓦片替换子瓦片的淡出 | 要处理深度与透明排序 | 中 |
| C5 | 持久缓存 | Cache API / IndexedDB，跨天和离线 | 中 |
| C6 | 地形 Worker 下载接入按域名限流 | 与影像共用 `RequestScheduler` | 小 |
| C7 | 带注记底图的处理 | 暂缓；根本办法是底图用无注记版本，注记走 `LabelManager` | — |
| C8 ✅ | 3D Tiles 要素拾取与属性查询 | `EXT_mesh_features` / batch table，高亮，接入统一事件（README 近期项）。2026-11-17 完成（P2.3，[tile-loading.md](tile-loading.md) §7.1）；要素编号纹理不读 | 中 |
| C9 | 矢量进阶 | MVT 矢量瓦片、面拉伸（建筑白模）、沿线注记 | 大 |
| C10 | 瓦片边界法线拼接；Worker 间共享高程缓存 | README 近期项 | 小 |
| C11 | ISSUE-1 的两处局限 | 锚点落在倾斜摄影屋顶 / 树冠时贴到它上面；~~3D Tiles 图层改 `heightOffset` 后高程缓存不会自动清空~~（✅ 2026-11-19：图层 `moved` 事件，viewer 清空缓存） | 小 |
| C12 | 大气透射率的近似偏差 | Schüler Chapman 近似低估光学厚度（瑞利天顶 3.4%、离天顶 85° 约 20%），低太阳时透射偏亮；CPU 版照搬以保持一致。根本办法是透射率 LUT（F5）（2026-11-19 记录，roadmap §0.2"P3.5 落地"） | 中 |

### D. SDK 打包（roadmap §10）

| 编号 | 内容 | 前置 | 规模 | Hub |
| --- | --- | --- | --- | --- |
| ~~D1~~ | ~~S1–S4：包入口与库构建、three 外置、样式拆分并加前缀、键盘监听改容器~~ ✅ 2026-11-11 随迁移到 TerraView 完成 | — | 大 | 源仓库的 `T261109-ppn` |
| ~~D2~~ | S5–S6 余项 ✅ 2026-11-12：P1.4 多实例核对（修复帧外渲染串 viewer）、P1.3 EGM96 评估、Webpack 宿主实际解码 Draco / KTX2 / meshopt | — | 中 | 无 |
| D3 | S7 余项（P1.1、P1.2）：API 分级与内部对象标 `@internal`（P1.1，✅ 2026-11-13）；核心中文文案改为错误码 + `locale` 选项（P1.2，✅ 2026-11-12）。S8 已定 Apache-2.0，声明补全已完成（A6） | — | 中 | 无 |
| ~~D4~~ | 首发配套（P1.5–P1.7）：npm 包名确认、宿主接入示例、发布准备。✅ 2026-11-25 发布 0.2.0（包名 `terra-viewer`）；之前完成包体积预算、`package.json` 发布元数据、浏览器冒烟测试进 CI（P1.5，2026-11-12） | D2、D3 | 中 | 无 |
| ~~D5~~ | 首发后插入：使用手册与示例，GitHub Pages 发布。✅ 2026-11-25（VitePress 1.6.4 经同意新增为开发依赖）。余项：在仓库设置里启用 Pages（Source：GitHub Actions）后推送；英文版、截图更新按需 | D4 | 中 | 无 |

P1 期间新增的公共 API 直接按 S7 的规则写，避免返工。

### E. 孪生数据与空间分析（M4，按需求排期）

| 编号 | roadmap 项 | 内容 | 前置 | 规模 |
| --- | --- | --- | --- | --- |
| E1 | M4.2 | 路线与管线几何（移植 `RouteBuilder`、Tube，Worker 版） | 无 | 小 |
| E2 | M4.3 | 带洞多边形、挤出、边线；`Building` 的几何生成移到 Worker；房间支持洞 | 无 | 中 |
| E3 | M4.4 | 室内导航：BIM 派生拓扑图 + A*，路线用 E1 显示；导航网格可选 | E1 | 中 |
| E4 | M4.5 | IoT 数据管线：`entity.data` 订阅、适配器、顶牌和样式规则自动刷新 | 无 | 大 |
| E5 | M4.1 | 场强图（IDW / 热力） | E4 | 中 |
| E6 | M4.6 | 高频数值标签（字形图集） | E4 | 中 |
| E7 | M4.7 | 空间分析：天际线、投影贴花、剖切盒 | B2 | 中 |
| E8 | M4.8 | 全景、~~高斯泼溅~~（第一期 ✅ 2026-11-22，后续分期见 [splats.md](splats.md) §11）、粒子、夜景假室内、天气 | 视项 | 每项小到中 |

### F. 工程与更远的方向

| 编号 | 内容 | 来源 |
| --- | --- | --- |
| F1 | 帧快照（基于 three `Inspector` 扩展，导出 Globe / 3D Tiles / 顶牌统计 JSON）。JSON 部分 ✅ 2026-11-19：`viewer.snapshot()`；Inspector 面板、逐 pass 耗时未做 | M5.1 |
| F2 | FrameGraph 评估（出现自定义 WebGPU 计算时再议） | M5.2 |
| F3 | 代理技能格式（`docs/agents/` 按 `SKILL.md` + `references/` 组织） | M5.3 |
| F4 | IFC 直读（web-ifc）、剖切面 / 剖切盒 | README 近期 |
| F5 | 计算着色器预计算大气 LUT；GPU 驱动瓦片剔除与间接绘制；计算着色器大规模动态图层 | README 中期 |
| F6 | 测量工具、漫游录制回放、GCJ-02 纠偏等国内数据适配 | README 产品化 |

### G. 代码结构：单包内重构（方案 A，2026-11-24 登记，同日完成）

来源：2026-11-24 的 monorepo 评估（结论记在 [roadmap.md](roadmap.md) §10.4："暂不改 monorepo，先在单包内重构"）。评估时的现状：`src` 105 个文件、3.1 万行；超过 1,000 行的只有 4 个文件；整体分层清楚，但有三处目录级反向依赖和三对文件级循环。typecheck 7.3 s、单测 25.6 s、库构建 21.6 s，规模和耗时都没有拆包的压力。宿主实际打进去的 SDK 压缩后约 378 KiB（gzip 124 KiB），但 `GeoViewer` 会创建所有子系统，拆包并不能让宿主少带代码。

**原则**：只搬代码、不改行为；公共 API 不变（`check-dts` 比对导出名、`docs/api.md` 不动）；`GeoViewer` 上的公开成员保留，改成转调新模块。每一步先单独提交"只搬不改"，再提交整理，方便 `git log --follow` / `git blame -C` 追溯。在 P4 新功能开工前做，避免和功能开发互相冲突。

| 编号 | 内容 | 做法 | 验收 | 规模 |
| --- | --- | --- | --- | --- |
| G1 ✅ | 拆 `viewer/GeoViewer.ts`（2,248 行，63 条 import、38 个公开子系统字段、约 46 个方法） | 拆成：环境与光照（`updateEnvironment`、`updateAtmosphereLight`、阴影适配输入、体积云的帧状态）；帧循环（`tick`、`frame`、`idleFloorRate`、`pictureChanged`、`checkPendingWork`，保持现有调用顺序，作为一个整体搬，不重排）；拾取（`pick`、`pickAt`、`pickCartographic`、`classifyPick`、`gesturePick`、参考地面）；图层与贴地（3D Tiles / 矢量 / 点位的增删、竖直射线）；诊断（`stats`、`memory`、`snapshot`、`info`）。新模块经一个窄接口（类型导入）拿到 viewer 的状态，不反向 import `GeoViewer` | `GeoViewer.ts` 约 900 行以内；导出名不变；全部单测、冒烟通过；帧循环的手测清单（AGENTS.md §6）通过 | 1.5 人日 |
| G2 ✅ | 拆 `globe/Globe.ts`（1,988 行） | 请求调度与上传预算、遍历与细化（选择规则已在 `tileSelection.ts`）、影像揭示与交叉淡入、统计与调试分开。`visitTile` 改写自 CesiumJS，搬动后 `THIRD_PARTY_NOTICES.md` 里的路径同步 | 同上；`tests/tileSelection` 等调度测试通过；加载手测（无空洞、无闪烁）通过 | 1 人日 |
| G3 ✅ | 拆 `atmosphere/VolumetricClouds.ts`（1,252 行），云相关文件单独成目录 | 着色器节点构建（天气、密度、步进、光照、重投影、合成，函数接收 uniform 对象）与流程编排（渲染目标、帧状态、重画天气图的条件）分开；`VolumetricClouds`、`cloudNoise*`、`volumetricCloudMath`、`CloudLayer` 移到 `src/clouds/` | 同上；体积云手测清单（[volumetric-clouds.md](volumetric-clouds.md) §9）通过 | 0.5 人日 |
| G4 ✅ | 消除目录级反向依赖和文件级循环 | ① `TSLNode` 类型移到 `core/`（现在 `post`、`lighting` 为它反向依赖 `atmosphere`）；② `local/region.ts`、`local/regionMask.ts` 下沉到底层目录（`globe`、`tiles3d` 运行时依赖它们），`LocalScene`、侧壁、压暗留在 `local/`；③ 体积云移出 `atmosphere` 后（G3），`atmosphere` 不再依赖 `lighting` / `post`；④ 三对文件循环：`LevelControl` ↔ `IndoorManager`、`tileFeatures` ↔ `Tiles3DLayer`、`NavigationControls` ↔ `GeoViewer`，抽出接口类型或改为注入 | 依赖分析无目录级环、无文件级环 | 0.5–1 人日 |
| G5 ✅ | 分层检查脚本 | `scripts/check-layers.mjs`（不新增依赖，写法同 `check-dts.mjs`）：按目录列出允许的依赖方向，运行时的反向依赖和文件循环都算失败（只导入类型的放行），接进 `verify` 和 CI；AGENTS.md §2 写明分层 | 故意加一条反向依赖时 `verify` 失败 | 0.5 人日 |
| G6 ✅ | 文档同步 | AGENTS.md §2 目录树、各专题文档里搬动文件的路径引用（全部文档共约 166 处路径，只改涉及的）、`THIRD_PARTY_NOTICES.md` | 文档里搜不到旧路径 | 0.5 人日 |

**落地（2026-11-24）**：

- G1：`GeoViewer.ts` 2,248 → 1,084 行（目标约 900；剩下的是公共 API 本身：约 40 个带文档的字段和访问器、带 JSDoc 的转调方法、构造时的接线、相机命令、容器处理）。拆出 `viewerTypes`（公共类型，原样搬）、`viewerState`（部件共享的状态）、`ViewerEnvironment`、`FrameLoop`（`frame` 里的调用顺序不变）、`ViewerPicking`、`ViewerLayers`、`diagnostics`、`indoorBehaviors`。各部件声明自己的窄接口（`EnvironmentHost`、`FrameHost` 等），`GeoViewer` 传一组引用进去。`date` / `timeMultiplier` / `indoorBackdrop` 改为同类型的 getter / setter。局部场景的接线（`createLocalScene`）留在 `GeoViewer`：它的回调要用到之后才创建的图层部件，挪出去只是换个文件包一层同样的闭包。
- G2：`Globe.ts` 1,988 → 1,119 行，拆出 `TileLoader`（476 行：队列、并发、取消、预取、上传预算、失败上报）、`TileContent`（421 行：内容应用、影像揭示与交叉淡入、地形渐变）、`PolarCaps`（118 行）。部件读的 `Globe` 成员从 `private` 改为 `@internal`，发布的 `Globe` 声明不变。`visitTile` 仍在 `Globe.ts`，`THIRD_PARTY_NOTICES.md` 不用改。查询和缓存淘汰没有再拆（各约 110 行，拆出去要为公开的 `getHeight` 等加转调）。
- G3：云相关文件移到 `src/clouds/`；`VolumetricClouds.ts` 1,252 → 729 行，节点图在 `cloudNodes.ts`（634 行，无状态函数，接收 uniform 对象）。
- G4：①②③ 完成（`core/tsl`、`src/region/`、云移出 `atmosphere`）。④ 三对循环里两对拆开：`NavigationControls` 改用 `NavigationHost`；`TileFeature` 的声明移到 `Tiles3DLayer` 旁边，`tileFeatures` 只处理不带图层的部分。另外 `local/LocalScene` 对 `viewer/GlobeCameraController` 的类型依赖也去掉了（`CameraBounds` 移到 `core/`）。`IndoorManager` ↔ `LevelControl` 保留为只有类型的循环：公共的 `LevelContext.indoor` 就是管理器，内置层级控制由管理器自己注册；要拆就得收窄公共类型或把注册挪出管理器（测试和直接使用者都依赖它），收益只是一条构建时就擦掉的类型边。
- G5：`scripts/check-layers.mjs`（只用 TypeScript 编译器解析 import），`npm run check:layers` 接进 `verify` 和 CI；故意在 `core/` 加一条 import `globe/` 的运行时依赖时失败、只导入类型时通过（`--types` 时失败）。
- G6：AGENTS.md §2 目录树、新增 §2.1 分层，各专题文档、api.md、未发布的 CHANGELOG 里的路径和方法位置。已发布的 CHANGELOG 段落和本节的计划原文是历史记录，保留旧路径。
- 验证：每一步对照重构前的构建（`687311d`）在无头 Chrome（RTX 4060，WebGPU / WebGL2）里跑同一组场景，比较页面编译的全部 WGSL / GLSL 源码和经公共 API 观察到的行为：体积云 + 光照 + 云影、示例办公楼逐级进到房间、局部场景、静止超采样（16 个样本、静止后每秒 10 帧更新、输入只唤醒、改日期重画、关超采样后降帧、飞行）、调试影像 + AWS 地形下六个视角加载完成后画的瓦片、高程。着色器逐字节相同，行为逐项相同（帧率采样差 1 帧除外）。`verify` 通过，冒烟 8 项通过。

合计约 4–5 人日。风险低：只搬不改，有 typecheck、478 个单测、声明导出比对、打包检查和 8 项冒烟兜底；主要风险是帧循环里的调用顺序（降帧、变化 / 唤醒、阴影与云图在场景 pass 之前绑定），所以 G1 的帧循环作为整体搬、不重排。

暂不做的（见 roadmap §10.4 的触发条件）：轻量 monorepo（npm workspaces，`packages/terra-view` + `apps/demo` + 宿主工程，约 2–3 人日 + 1 天文档，需要重新生成 `package-lock.json`）；按子系统拆成多个包（约 3–5 周，主要风险是 14 项模块级共享状态在宿主里出现多份副本，以及 96 处跨目录使用的 `@internal` 成员要变成公开 API）。

## 5. 待人决定

| 事项 | 为什么需要决定 | 我的建议 |
| --- | --- | --- |
| ~~SDK 首发的四项~~ | 已全部决定（2026-11-11）：`terra-view`、Apache-2.0、`tv-`、单包，见 roadmap §10.4 | — |
| ~~下一个主线做 B1/B2 还是 D1~~ | 2026-11-12 按 SDK 定位重排：先 P0 收尾、P1 首发就绪，B1（按需渲染）可与 P1 并行，B2 起的画质链放到 P3。见 roadmap §0.2 | — |
| ~~是否为 B、C 两组建 Hub 任务~~ | TerraView 没有接入 Hub，不再适用 | — |
| ~~浏览器冒烟测试用哪个工具（P1.5）~~ | 2026-11-12 决定：有条件时用真实浏览器 MCP，Playwright 兜底（同意新增开发依赖） | — |
| ~~`cad-to-building` 技能与 CAD 数据去留（A10）~~ | 2026-11-12 决定不迁移，留在源仓库 | — |
| 首个对外版本号与发布时间（P1.7） | 发布、推标签都要明确同意 | ✅ 2026-11-25：`0.2.0` 当天发布，同时上 npm（包名 `terra-viewer`、去掉 `private`、配好 `NPM_TOKEN`、仓库公开） |
| ~~是否改 monorepo~~ | 2026-11-24 评估后决定：暂不改，先在单包内重构（G 组），触发条件见 roadmap §10.4 | — |
| ~~G 组（单包内重构）何时开工~~ | 2026-11-24 已完成（§4 G） | — |
| 源仓库 three-geo-global 的收尾方式（A9） | 涉及源仓库分支、Hub 任务 | 合并 `T261109-ppn` 分支后在 README 顶部注明"已迁移到 TerraView"，仓库归档 |

## 6. 推荐顺序

2026-11-12 起按 [roadmap.md](roadmap.md) §0.2 执行（原来的顺序以 B 组画质为先，迁移成 SDK 后改为先首发就绪）：

1. ~~A 组迁移收尾~~：全部完成（2026-11-12；A9 源仓库收口由维护者自行处理）。
2. ~~D3 → D2 → D4 首发就绪~~（P1）：2026-11-25 发布 0.2.0；同日插入 D5（使用手册、示例、文档站点）并完成。
3. ~~B1 按需渲染~~（P2.1）：P2.1a 空闲降帧已完成（2026-11-13），停画随 B4 静止超采样（P3.3）在 2026-11-18 完成。
4. ~~B6 楼层按需加载、C8 要素拾取~~（P2.2、P2.3）：2026-11-17 完成；加载与错误事件（P2.4）2026-11-13 完成。P2 至此全部完成（完全按需渲染 P2.1 暂缓到 P3.3）。
5. ~~B2 后期骨架 → B3 → B4 → B5~~（P3.1–P3.4）：2026-11-17、11-18 完成；~~B7 / B8~~（楼层 AO、光照跟随大气，P3.5）、~~B9~~（日照阴影与 OIT，P3.6）2026-11-19 完成。B10（冒名顶替）、E 组（P4）、C 组和 F 组（P5）按业务需求排期。

## 7. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-25 | D5 使用手册与示例：`docs/guide/` 18 章、`examples/` 16 个示例（`catalog.ts`、共享面板），VitePress 站点（`docs/.vitepress/`：中文分词搜索、指向站外的相对链接改写到 GitHub、`ExampleFrame` 嵌入示例），`pages.yml`（main 发布、PR 只构建），`build:examples` 进 `verify` / CI，冒烟新增 `examples` 项目。核对 roadmap：§0.1、首发准备清单、本文 D4 / 推荐顺序里 P1.7 "搁置" 的旧说法更正 |
| 2026-11-25 | 0.2.0 发布：包名改为 `terra-viewer`，去掉 `private`，CHANGELOG 填日期，打标签 `v0.2.0` |
| 2026-11-25 | P1.7 发布准备（0.2.0）：版本号、CHANGELOG `[0.2.0]`（日期待打标签当天填）、发布说明 `docs/releases/v0.2.0.md`（`release.yml` 用作 Release 正文）、README 重写（功能概览补齐、接入示例、文档索引、对标与限制更新）、package 描述与关键词、体积预算收紧。**没有**去掉 `private`、打标签或推送：这三步仍要单独确认（roadmap §0.2 P1.7 首发准备清单） |
| 2026-11-24 | 远端分支 `claude/confident-fermi-oy3is7` 的 6 个提交（M4.8 高斯泼溅第一期、层级绑定）cherry-pick 到 main：viewer 相关改动按 G1 拆分放进 `ViewerLayers` / `ViewerPicking` / `FrameLoop` / `diagnostics` / `viewerTypes`，`splats/` 加进分层表（只依赖 core），`TSLNode` 改从 `core/tsl` 取；泼溅的 API 小节改为 api.md §1.14（§1.13 是体积云）；合并后入口 874.7 / 265.6 KiB，在 880 / 270 预算内。`--types` 审查多出两条只导入类型的边（`splats`、`tiles3d` → `indoor/levelBinding` 的 `LevelBindingOptions`），规则允许，未改。verify 523 个测试通过，冒烟 12 项（WebGL / WebGPU）通过 |
| 2026-11-24 | B13 关闭：集显上"云影多 4 ms"是 `stats.gpuMs` 的波动，改用轮换顺序的吞吐测法后云影只占 0.1–0.6 ms，不改代码；volumetric-clouds §10 集显表和 B12 的数字更正。另评估了推送当前提交对远端分支 `claude/confident-fermi-oy3is7`（高斯泼溅、层级绑定）合并的影响 |
| 2026-11-24 | B12 完成：天气图按档位 512² / 1024²（`low` / 其余），40–200 km 高的云不再成方块；在 Intel Arc 集显上实测体积云（`low` 档 +0.6–1.5 ms，`medium` 档 +2.1–7.3 ms），`low` 默认维持关；集显上未定位的约 4 ms 记为 B13 |
| 2026-11-24 | G 组完成（单包内重构）：`GeoViewer` 2,248 → 1,084 行、`Globe` 1,988 → 1,119 行、`VolumetricClouds` 1,252 → 729 行，拆出的部件各自声明窄接口；`src/clouds/`、`src/region/`；`check:layers` 进 `verify` 和 CI，AGENTS.md §2.1 写明分层。新旧构建的着色器逐字节相同、行为逐项相同；`IndoorManager` ↔ `LevelControl` 的类型循环有意保留（§4 G 落地） |
| 2026-11-24 | 体积云的 Claude in Chrome 真机验证（WebGPU / WebGL2，检查清单全过，结果在 [volumetric-clouds.md](volumetric-clouds.md) §10）；第一次窗口最小化没测到性能，补测：RTX 40、1920×889，体积云让整帧多 0.4–1.2 ms，各视角都保持 60 FPS，有风时 10 FPS 节能、无风时静止停画；记下两项后续（B12）。monorepo 评估：暂不改（roadmap §10.4），单包内重构的细项登记为 G 组，未开工 |
| 2026-11-24 | 插入项：体积云（近地，`viewer.clouds.set({ volumetric })`）。参考 yisky/hillaire-sky-webgpu 的积云做法（该仓库无许可证，只借鉴思路，代码重写为 TSL 片元 pass，WebGPU / WebGL 2 都能跑）：天气图跟随云壳密度并随风滑动，2×2 交错追踪 + 按云距离 / 相机 / 风重投影的历史，按场景深度上采样合成，云影接进 `sunShadowFactor`。新增踩坑一条（AGENTS.md §7：TSL `If` 回调写成表达式箭头函数），专题文档 §7 记了六条。verify 478 个测试通过，冒烟硬件模式 8 项、软件模式新用例 2 项通过 |
| 2026-11-23 | 层级绑定（高斯泼溅二期 ①，同时是层级系统的通用扩展）：`indoor/levelBinding.ts`（纯函数规则 + 注册表 `viewer.indoor.bindings`），泼溅和 3D Tiles 的 `level` 选项，泼溅放进实体坐标系并跟随、懒加载、拾取归实体，实体的 `bindingOpacity`，建筑文档的 `splats` 字段（同步 indoor-bim.md、数据制作手册），演示面板的绑定控件和示例办公楼大堂里的示意实景；`tests/levelBinding.test.ts` 和冒烟用例。决定不让泼溅自成层级，理由见 indoor-bim.md §6.5 |
| 2026-11-22 | M4.8 高斯泼溅第一期（E8 的一项）：`viewer.addSplats`（`src/splats/`：Worker 解码 `.ply` / `.splat` / `.spz`、档位预算、地理锚定、three 自带 `GaussianSplat` 绘制、BVH 拾取接入 `pick` / `interaction` / 相机手势、裁剪、显存与加载状态、三个错误码），演示面板和 `?splats=`，`tests/splats.test.ts` 和冒烟用例；用 three.js 示例库的开放数据验证。规范 [splats.md](splats.md)。开发环境是软件渲染，真实 GPU 上的帧率没有量 |
| 2026-11-19 | P3.6（B9 / M3.9）：日照阴影（`viewer.shadows`：`lighting/shadowFit.ts` 纯函数适配、`lighting/SunShadows.ts` 自管阴影图和共享接收节点，地球瓦片、3D Tiles、展台接收，只在范围或内容变化时重画）、透明顺序无关混合（`viewer.transparency`，`PostPipeline` 的透明 pass 与合成，WebGPU，默认只在 `ultra`）。新增踩坑三条（AGENTS.md §7：无渲染目标的深度纹理被当成多重采样、放大渲染目标后材质仍绑旧纹理、MRT 按纹理名对应）。verify 436 个测试通过，冒烟硬件 / 软件模式各 4 项通过（roadmap §0.2"P3.6 落地"） |
| 2026-11-19 | P3.5（B7 / M3.4、B8 / M3.5）：楼层环境光遮蔽（`viewer.indoor.ambientOcclusion`，GPU 俯视烘焙、接触项加权最大值 + 柔和项平均、读回成 `DataTexture`、共享 `colorNode`、内容变化稳定后重烘）；光照跟随大气（大气 CPU 版、太阳光色、天光 SH 探针、建筑 / 设备 / 3D Tiles 的空气透视）。浏览器实测 TSL 与 CPU 透射率相差 < 7e-5，AO 贴图 WebGPU / WebGL 逐字节相同。P5 顺带：C11 第二处局限修复（`moved` 事件）、M5.1 的 `viewer.snapshot()`、建筑构建的控制台警告；新增 C12（Chapman 近似偏差）。verify 419 个测试通过，冒烟硬件 / 软件模式各 4 项通过（roadmap §0.2"P3.5 落地"）。P1.7 仍搁置 |
| 2026-11-18 | P3.4 GPU 版层级过渡（B5 / M1.4 遗留）：去掉 DOM 版 `FrameCrossfade` 和 `.tv-crossfade`，改为后期管线 display 阶段的 `transition` 效果：截帧和深度留在 GPU，每 4 CSS 像素一个网格点按深度重投影到飞行中的相机后溶解（`viewer.levelTransition.duration` / `reproject`）。WebGPU / WebGL2 下放慢截图对照、测开始过渡的同步耗时与过渡期间帧率；冒烟硬件 / 软件模式各 4 项通过（roadmap §0.2"P3.4 落地"）。P1.7 仍搁置 |
| 2026-11-18 | P3.3 静止超采样与调色（B4 / M3.3 后半，连同 B1 的停画）：安静 1 s 后 16 / 32 个 Halton 抖动样本在显示空间平均，画完不再画帧（`viewer.supersampling`、`stats.still` / `samples`）；输入只唤醒、不作废静止画面；补注记、地球、3D Tiles 淡入淡出与相机矩阵等变化检测；截图直接用超采样画面；调色 `viewer.colorGrading`（曝光、对比度、饱和度，`vivid` 预设）。评估 `TRAANode` 后不用（速度缓冲在 ECEF 尺度不准）。实测静止 CPU：地球 14% → 6.9%、建筑 27% → 7.9%（相对每秒 10 帧），WebGPU / WebGL2 行为一致；冒烟硬件 / 软件模式各 4 项通过（roadmap §0.2"P3.3 落地"）。P1.7 仍搁置 |
| 2026-11-17 | P3.1 后期管线骨架（B2 / M3.1）：每帧经 `viewer.postProcessing`，效果分 linear / display 两段，按需 MRT 附件。P3.2 描边与发光（B3 / M3.2）：`entity.effects`、`EntitySet.setEffects`、`viewer.effects`、`indoor.selectOutline` / `hoverOutline`；选中、悬停从自发光改为描边。WebGPU / WebGL2 下用 Playwright 驱动演示应用实测；扩展驱动的 Chrome 里出现过一次未复现的 GPU 卡死（roadmap §0.2"P3.1 / P3.2 落地"）。P1.7 仍搁置 |
| 2026-11-17 | P2.2 楼层模型按需加载（B6 / M3.8）：楼层第一次显示时加载，隐藏楼层超出建筑模型预算（按档位）时卸载，`viewer.memory.buildings`；修复移除建筑不释放模型纹理。P2.3 3D Tiles 要素拾取（C8）：`EXT_mesh_features` / 批量表的要素编号与属性，`event.tileFeature()`、`pickTileFeature`、`highlightTileFeature`（叠加网格高亮）。两项都在 WebGPU / WebGL2 下用 Playwright 驱动演示应用实测。P1.7 发布准备暂时搁置 |
| 2026-11-14 | P2.1a 收尾（roadmap P2.1a"收尾"）：从代码做的改动（实体样式 / 显隐 / 移动、模型加载完成、云层、图层与叠加层的 setter）下一帧就恢复全帧率；点位顶牌没建完时保持全帧率；修复 `refreshTransform()` 后拾取缓冲不失效（点击命中设备旧位置）。评估后"按帧计数改按时间"改为"报告 busy"，剔除间隔、遮挡去抖不改 |
| 2026-11-14 | P2.1a 收尾的文档整理：roadmap 的 P2 表格恢复完整（P2.1 评估与 P2.1a 移到表后），M3.3、§0.1 状态表、总顺序注明按需渲染以空闲降帧落地、完全停帧暂缓；本文 B1 行与推荐顺序更新；README 补静止降帧 |
| 2026-11-13 | P2.1 评估：实测静止画面的开销与帧率扫描（三轮中位数），完全按需渲染暂缓；P2.1a 空闲降帧完成（默认 10 fps、云层按漂移速度、离屏停帧、`requestRender()`），静止 CPU 约降到原来的 1/3–1/4；修复顶牌层"待放置"标志不清 |
| 2026-11-13 | P2.4 完成（首发前做，补 P1.1 之后稳定 API 里拿不到加载错误和加载完成的缺口）：`error` / `load-progress` / `idle` 事件、`viewer.loadState`、两个新错误码；演示应用和打包宿主改用它们 |
| 2026-11-13 | P1.1 完成：草案修正（被公开签名引用的类型不能裁剪）并确认；`stripInternal` + `tsconfig.dts.json` 严格检查发布的声明；`@advanced` 标记；入口移除 17 个内部导出（含 `geoidUndulation`，主入口 gzip 251 → 155 KB）；新增 `viewer.highlightedFeature`；api.md §3 每行标级别。P1 的代码项全部完成，剩 P1.7 发布准备 |
| 2026-11-13 | P1.5 修正：CI 首跑宿主冒烟 150 s 超时（软件渲染下等加载队列排空太慢，不是 SDK 回归）。软件渲染只等屏幕就绪、有 GPU 才要求排空；WebGPU 在 CI 上改走 SwiftShader，不再跳过；不重试；CI 合并打包检查与冒烟为一个 job。本机软件模式 4 项通过（1.7 分钟），硬件模式宿主 7 s / 3 s |
| 2026-11-12 | P1.5 完成：Playwright 浏览器冒烟（演示应用 + 打包宿主，WebGL / WebGPU），CI 新增 `smoke` job；本机 4 项通过，无 GPU 模拟 2 过 2 跳过 |
| 2026-11-12 | P1.3 完成：Webpack 5 宿主实际解码 Draco / KTX2 / meshopt（three.js r187 示例模型，临时目录），EGM96 评估；S6 完成。P1.1 分级等维护者确认 |
| 2026-11-12 | P1.1：`create()` 必填项检查完成，分级草案待确认；P1.4 完成（共享状态核对，修复帧外渲染串 viewer，WebGPU / WebGL 混用实测） |
| 2026-11-12 | P0 全部标为完成（源仓库收口由维护者自行处理）；确认 P1.2（默认 zh-CN、错误英文）和 P1.5（真实浏览器 MCP 优先、Playwright 兜底）；完成 P1.2 |
| 2026-11-12 | 决定先做发布准备、暂不发布；完成 P1.6 包体积预算和 `package.json` 发布元数据，roadmap §0.2 增加首发准备清单 |
| 2026-11-12 | A6、A7（第三方声明、lock 许可证）完成；A8 远端 CI 首跑确认全绿；A10 决定 CAD 技能和数据不迁移；核对源仓库，A9 的收口清单整理在本地（不入库） |
| 2026-11-12 | 迁移完整性核对（roadmap §10.5）：代码、测试、演示、文档逐项对照源仓库；修文档残留，抄入源仓库分支上的 S5 / Webpack 实测；按 SDK 定位重排计划（roadmap §0.2），§1、§4–§6 随之更新 |
| 2026-11-11 | 包名定为 `terra-view`；新增 GitHub Actions（CI、Release）和打包自检 |
| 2026-11-11 | **迁移到 TerraView 并 SDK 化**：包入口、库构建（three 外置）、样式拆分与 `tv-` 前缀、键盘监听改容器、解码器路径、聚合 Worker 关闭、docs/api.md；D1 完成，D2 / D3 部分完成 |
| 2026-11-11 | 建立：整理 11-04 至 11-10 的改造时间线、Hub 任务与 roadmap 对应、待办清单 |
| 2026-11-11 | 处理 A1（roadmap / CHANGELOG / README 同步）、A2（清理两个 worktree）、A3（暂存补发进行中） |
| 2026-11-11 | `T261111-lql` 合并到 main（`97a149c`），同步 §1–§3 状态 |
| 2026-11-11 | 完成 A3（Hub 暂存清空、b75 回执补交、lql 回执绑定）与 A4（人工验证）；A 组全部收尾 |
