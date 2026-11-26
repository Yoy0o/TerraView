<!--
感谢贡献！提交前请读 CONTRIBUTING.md 和 AGENTS.md。
Thanks for contributing! Please read CONTRIBUTING.en.md and AGENTS.md (Chinese) first.
-->

## 改了什么 / What changed

<!-- 一两句话说明动机和做法；关联的 issue 写 Closes #123 / Motivation and approach; link issues with Closes #123 -->

## 怎么验证的 / How it was verified

- [ ] `npm run verify` 通过 / passes
- [ ] 涉及数学、调度规则或数据格式时补了单测 / Unit tests added for math, scheduling rules or data formats
- [ ] 改了渲染、Worker、容器或层级：跑了 `npm run smoke:build && npm run smoke`，并在真实浏览器里看过 / Touched rendering, workers, the container or levels: ran the smoke tests and checked in a real browser
- [ ] 改了 `docs/`：`npm run site:build` 通过 / Touched `docs/`: `npm run site:build` passes

<!-- 浏览器、GPU、后端（WebGPU / WebGL）；画面改动附前后截图 / Browser, GPU, backend; before/after screenshots for visual changes -->

## 公共 API 与文档 / Public API and docs

- [ ] 没有改公共 API / No public API change
- [ ] 改了公共 API：已同步 `docs/api.md`、`CHANGELOG.md`，宿主会用到的已同步使用手册与示例 / Public API changed: `docs/api.md`, `CHANGELOG.md`, and the manual and examples where hosts are affected
- [ ] 改了对外文档：中英两个版本都已更新（README、CONTRIBUTING、`docs/en/`）/ Public docs changed: both the Chinese and English versions are updated
