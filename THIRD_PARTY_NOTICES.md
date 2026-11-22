# 第三方声明

本项目移植或改写了下列开源代码的部分算法，并内嵌了由第三方数据生成的数据。按各自许可的要求，在此保留原始版权声明和许可条款；移植、改写处的文件头或注释注明了来源。收录规则见 [docs/agents/roadmap.md](docs/agents/roadmap.md) §1。

`three`、`3d-tiles-renderer` 是 peer 依赖，由宿主安装，不打进本包的产物，所以不在这里收录。

## t3d.js

- 来源：https://github.com/uinosoft/t3d.js ，提交 `1f2c3c8`（0.5.5）
- 用到的部分：`examples/renderer_culling_contribution.html` 中的球体屏幕投影范围计算（`sphereScreenExtents`）
- 移植位置：`src/indoor/ContributionCulling.ts`
- 许可：BSD 3-Clause

```
BSD 3-Clause License

Copyright (c) 2021-present, uino

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## CesiumJS

- 来源：https://github.com/CesiumGS/cesium ，`main` 分支（2026-11 阅读源码，没有固定到某个提交；没有复制文件）
- 用到的部分：
  - 地球四叉树的瓦片选择规则：选择记忆、不丢细节守卫、象限填充、兄弟瓦片预加载、地平线雾化屏幕空间误差及其默认常量。改写自 `Scene/QuadtreePrimitive.js`、`Scene/GlobeSurfaceTileProvider.js`、`Scene/Fog.js`，规则见 [docs/agents/tile-loading.md](docs/agents/tile-loading.md) §2、§10
  - 椭球缩放空间的地平线剔除（`EllipsoidalOccluder` 的遮挡点与可见性判断）
  - 按域名限流的请求调度（`RequestScheduler`，简化版）
  - 3D Tiles 远处放宽误差的密度参数（`dynamicScreenSpaceErrorDensity`）
  - 双精度拆成高低两个 float32 的相对视点渲染（RTE）写法
- 改写位置：`src/globe/tileSelection.ts`、`src/globe/Globe.ts`（`visitTile` 等）、`src/globe/GlobeTile.ts`（象限填充）、`src/core/geodesy.ts`、`src/globe/imagery/RequestScheduler.ts`、`src/tiles3d/lodPolicy.ts`、`src/vector/LabelManager.ts`（`splitDouble`）
- 许可：Apache License 2.0。条款全文与本项目根目录的 [LICENSE](LICENSE) 相同；CesiumJS 仓库根目录没有 NOTICE 文件

```
Copyright 2011-2026 CesiumJS Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

quantized-mesh 地形的解码（`src/globe/terrain/quantizedMesh.ts`）按公开的格式规范（https://github.com/CesiumGS/quantized-mesh ）自行实现，没有改写 CesiumJS 的代码。

## three.js

- 来源：https://github.com/mrdoob/three.js ，r187（0.187.0）
- 用到的部分：`examples/jsm/loaders/SPZLoader.js`、`SPLATLoader.js`、`GaussianSplatPLYLoader.js` 和 `examples/jsm/utils/GaussianSplatUtils.js` 里的文件布局与数据约定（SPZ 的头部与各属性流、定点位置、尺度与颜色的量化、"最小三分量"四元数；PLY 的球谐系数排列；`.splat` 的行布局；交给 `GaussianSplat` 的协方差和球谐打包格式）。three 的加载器要 import three 并在主线程解析，这里按同样的格式在 Worker 里重新实现，不含 three 的代码
- 移植位置：`src/splats/splatFormats.ts`、`src/splats/splatData.ts`
- 许可：MIT

（three 本身仍是 peer 依赖，不打进产物；渲染用的 `GaussianSplat`、SPZ 4 用的 Zstandard 解码器 `zstddec` 都从宿主安装的 three 里加载。）

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## EGM96 大地水准面数据（经 egm96-universal）

- 数据：美国国家地理空间情报局（NGA）发布的 EGM96 模型。美国政府作品，通常视为公有领域
- 生成方式：`scripts/generate-egm96.mjs` 调用 `egm96-universal`（1.1.1）的 `meanSeaLevel` 在 1° 网格上采样（该库用 NGA 的 15′ 样本数据做双线性插值），结果以 Int16（分米）内嵌
- 内嵌位置：`src/core/egm96Grid.ts`（随瓦片 Worker 打进产物）
- egm96-universal 来源：https://github.com/nicolas-van/egm96-universal ，许可：MIT

```
MIT License

Copyright (c) 2020 Nicolas Vanhoren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
