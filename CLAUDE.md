@AGENTS.md

## Claude Code 补充
- 结束任务前运行 `npm run verify`（typecheck、test、库构建、类型声明、演示构建），并在回复里说明结果
- 演示应用的开发服务器可能已经在 5173 端口跑着，先查端口占用，不要杀用户的进程；测试另起一个端口
- 改了公共 API、类名或容器行为，同步 `docs/api.md` 和 CHANGELOG
- 改了渲染、Worker、容器或层级相关的代码，再跑 `npm run smoke:build && npm run smoke`（Playwright，本机已装的 Chrome，端口 4180 / 4181）；有真实浏览器 MCP 时也手测
- Windows 环境：脚本用 Node，不用 python；Bash 中使用 POSIX 路径
