# 贡献指南

简体中文 | [English](CONTRIBUTING.en.md)

感谢你愿意为 TerraView 出力！问题报告、文档修正、示例和代码都欢迎。参与本项目即表示同意遵守[行为准则](CODE_OF_CONDUCT.md)。

## 提问与反馈

- **用法问题**：先看[使用手册](https://yoy0o.github.io/TerraView/guide/)和[常见问题](https://yoy0o.github.io/TerraView/guide/faq)。
- **Bug**：用 [Bug 模板](https://github.com/Yoy0o/TerraView/issues/new?template=bug_report.yml)。最有用的信息是：版本、渲染后端（WebGPU / WebGL）、浏览器与 GPU、最小复现（或演示应用的完整地址，含 URL 参数和 `#相机位置`），以及 `JSON.stringify(viewer.snapshot())` 的输出。
- **功能建议**：用[需求模板](https://github.com/Yoy0o/TerraView/issues/new?template=feature_request.yml)，先讲场景，再讲方案。较大的改动请先开 issue 讨论，避免做完后方向对不上。
- **安全问题**：不要公开提 issue，见 [SECURITY.md](SECURITY.md)。

## 开发环境

- Node 20.19+ 或 22.12+，用 npm 安装（仓库带 `package-lock.json`；`.npmrc` 设了 `legacy-peer-deps=true`）。
- 支持 WebGPU 的 Chrome / Edge（113+），用来跑演示应用和浏览器冒烟测试。
- Windows 上脚本一律用 Node，不用 Python；在 Git Bash 里跑 vitest 时用大写盘符进入仓库（见 [AGENTS.md](AGENTS.md) §7 最后一条）。

```bash
git clone https://github.com/Yoy0o/TerraView.git
cd TerraView
npm install
npm run dev            # 演示应用 http://localhost:5173
npm run examples:dev   # 示例 http://localhost:5175
npm run docs:dev       # 文档站点（与 examples:dev 一起开）
```

## 写代码之前

**先读 [AGENTS.md](AGENTS.md)**。它是本仓库的开发规范（面向人和 AI 代理），记录了坐标与精度约定、TSL 着色器规则、相机不变量、分层规则和几十条踩过的坑。涉及具体子系统时，再读 `docs/agents/` 下对应的专题文档。几条最常被违反的约定：

- **SDK 边界**：`src/` 不能 import `demo/`、`examples/`；演示应用和示例只能从包入口 `terra-viewer` 引用 SDK。`src/` 里不读 URL 参数、`localStorage`，不在 `window` / `document` 上注册全局监听。
- **分层**：目录间的依赖只能自下而上，`npm run check:layers` 会检查。
- **着色器**：只用 TSL，禁止 `onBeforeCompile` 和 GLSL 字符串注入（WebGPU 下静默失效）。
- **文案与错误**：`src/` 里不写界面文案，加到 `src/core/i18n.ts`（每种语言都要有）；错误用 `TerraViewError`（英文消息 + `code`）。
- **依赖**：版本是锁定的，新增或升级依赖要先在 issue 里讨论，不要顺手改 `package-lock.json`。

## 提交改动

1. Fork 仓库，从 `main` 拉一个分支（如 `fix/terrain-seams`、`feat/mvt-layer`）。
2. 改动保持聚焦：一个 PR 解决一件事；重构和功能分开提交。
3. 提交说明用英文祈使句开头，说清"改了什么、为什么"，例如 `Volumetric clouds: 1024 weather map above the low tier`。与现有历史保持一致即可。
4. 推送分支，开 PR，按模板勾选验证项。CI（typecheck、分层检查、单测、构建、打包检查、浏览器冒烟）全绿后由维护者审阅合并。

## 提交前验证

```bash
npm run verify    # typecheck、分层检查、单测、库构建与类型声明、演示与示例构建：必须全部通过
```

按改动范围追加：

| 改了什么 | 再跑 |
| --- | --- |
| 数学、调度规则、数据格式 | 在 `tests/` 补单测（照着已有的写） |
| 渲染、Worker、容器、层级 | `npm run smoke:build && npm run smoke`（Playwright，本机 Chrome），并在真实浏览器里看一遍（[AGENTS.md](AGENTS.md) §6 的手测清单） |
| `docs/` | `npm run site:build`（死链、Markdown 里的 Vue 模板错误会让它失败） |
| 包内容、导出、Worker、样式 | `npm run build && npm run check:package`（体积预算） |

不要通过修改或删除测试让检查变绿。

## 文档同步

- **公共 API**（导出、类名、容器行为）有变化：同步 [docs/api.md](docs/api.md) 和 [CHANGELOG.md](CHANGELOG.md) 的「未发布」；宿主会用到的，同步使用手册（`docs/guide/`）和示例（`examples/`）。
- **对外文档中英同步**：下列文档有中英两个版本，改一边时另一边一起改（英文跟不上时，在 PR 里说明，由维护者补）：

  | 中文 | English |
  | --- | --- |
  | [README.md](README.md) | [README.en.md](README.en.md) |
  | [CONTRIBUTING.md](CONTRIBUTING.md) | [CONTRIBUTING.en.md](CONTRIBUTING.en.md) |
  | [docs/index.md](docs/index.md)（站点首页） | [docs/en/index.md](docs/en/index.md) |
  | [docs/guide/getting-started.md](docs/guide/getting-started.md) | [docs/en/guide/getting-started.md](docs/en/guide/getting-started.md) |
  | [docs/releases/](docs/releases/)（发布说明） | [docs/en/releases/](docs/en/releases/) |
  | [docs/sponsor.md](docs/sponsor.md) | [docs/en/sponsor.md](docs/en/sponsor.md) |

  [SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 `.github/` 下的模板是双语单文件。使用手册的其余章节、API 参考和 `docs/agents/` 目前只有中文。

## 许可

提交到本仓库的贡献按 [Apache-2.0](LICENSE) 授权（许可证第 5 条）。引入第三方代码前先确认其许可与 Apache-2.0 兼容，并在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 保留版权声明。不要提交访问凭证（天地图、Cesium ion、Google、Mapbox 等的密钥）、`.env` 或未经授权的数据。
