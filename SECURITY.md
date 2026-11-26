# 安全策略 / Security Policy

[中文](#中文) | [English](#english)

## 中文

### 支持的版本

0.x 阶段只为最新的次版本修复安全问题。

| 版本 | 是否修复 |
| --- | --- |
| 0.2.x | ✅ |
| < 0.2 | ❌ |

### 报告漏洞

**请不要在公开的 issue、讨论或 PR 里披露安全问题。** 请通过 GitHub 的私下报告渠道提交：仓库的 [Security → Report a vulnerability](https://github.com/Yoy0o/TerraView/security/advisories/new)。

报告里请尽量写明：受影响的版本、问题类型（如 XSS、凭证泄露、构造的数据文件导致的崩溃或越界读取）、复现步骤或概念验证、可能的影响。

维护者会在 7 天内确认收到，评估后告知处理计划；修复发布后会在 GitHub Security Advisory 和 CHANGELOG 里致谢（不希望署名的可以说明）。

### 范围

TerraView 是运行在浏览器里的前端 SDK，以下属于本项目的范围：

- SDK 处理外部数据（GeoJSON、建筑文档、点位、3D Tiles、高斯泼溅文件、影像与地形瓦片）时的注入、崩溃、内存耗尽；
- HTML 顶牌、注记里的文本被当作 HTML 渲染导致的 XSS；
- SDK 泄露宿主传入的访问凭证（如把密钥写进日志、错误详情或第三方请求）。

以下不在范围内：宿主应用自己的代码与部署、第三方地图 / 地形 / 3D Tiles 服务本身、演示应用里为了演示而保存在本机 `localStorage` 的凭证（这是用户自己的浏览器）、依赖包的已知漏洞（请报告给上游；如果 TerraView 的用法放大了影响，欢迎报告）。

## English

### Supported versions

During 0.x, security fixes go to the latest minor version only.

| Version | Supported |
| --- | --- |
| 0.2.x | ✅ |
| < 0.2 | ❌ |

### Reporting a vulnerability

**Please do not disclose security issues in public issues, discussions or pull requests.** Report them privately through GitHub: [Security → Report a vulnerability](https://github.com/Yoy0o/TerraView/security/advisories/new) on the repository.

Please include, as far as you can: the affected version, the kind of issue (for example XSS, credential leaks, crashes or out-of-bounds reads caused by crafted data files), steps to reproduce or a proof of concept, and the possible impact.

The maintainer will acknowledge your report within 7 days and let you know the plan after assessing it. Once a fix is released you will be credited in the GitHub Security Advisory and the CHANGELOG (say so if you prefer not to be named).

### Scope

TerraView is a front-end SDK running in the browser. In scope:

- injection, crashes or memory exhaustion while the SDK processes external data (GeoJSON, building documents, points, 3D Tiles, Gaussian splat files, imagery and terrain tiles);
- XSS caused by text in HTML markers or labels being rendered as HTML;
- the SDK leaking credentials passed in by the host app (for example writing keys into logs, error details or third-party requests).

Out of scope: the host app's own code and deployment, the third-party map / terrain / 3D Tiles services themselves, credentials the demo app keeps in the user's own `localStorage` for convenience, and known vulnerabilities in dependencies (please report those upstream; if TerraView's usage makes the impact worse, a report is welcome).
