/**
 * The documentation site (GitHub Pages): the user manual (docs/guide/), the API reference
 * (docs/api.md), the building data manual and the release notes. `npm run docs:dev` serves it,
 * `npm run site:build` builds it together with the examples (`<site>/examples/`) and the demo
 * (`<site>/demo/`) into dist-site/ (.github/workflows/pages.yml publishes that folder).
 *
 * docs/agents/ (the subsystem specs for contributors) is not part of the site. Relative links
 * that leave the site (to docs/agents/, the sources, CHANGELOG.md, …) are rewritten to the file on
 * GitHub, so the same Markdown reads correctly on GitHub and on the site.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme, type MarkdownRenderer } from 'vitepress';

const REPO = 'https://github.com/Yoy0o/TerraView';
/** Path the site is served under: `/<repository>/` on GitHub Pages; SITE_BASE overrides. */
const BASE = process.env.SITE_BASE ?? '/TerraView/';
/** Folders of docs/ that are not published (see srcExclude). */
const EXCLUDED = ['agents/'];
const DOCS = fileURLToPath(new URL('..', import.meta.url));

/** Whether a link target (relative to docs/, normalized) is a page of this site. */
function isSitePage(target: string): boolean {
  if (target.startsWith('../') || EXCLUDED.some((dir) => target.startsWith(dir))) return false;
  if (target.endsWith('/')) return existsSync(`${DOCS}/${target}index.md`);
  // .md / .html pages and extensionless page paths; anything else (JSON, sources) is a file.
  return /\.(md|html)$/.test(target) || !/\.[a-z0-9]+$/i.test(target);
}

/** Rewrites relative links that leave the site to the file or folder on GitHub (main branch). */
function githubLinks(md: MarkdownRenderer): void {
  const render = md.renderer.rules.link_open!;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href');
    if (href && !/^([a-z]+:|\/|#)/i.test(href)) {
      const [path, hash = ''] = href.split(/(?=#)/);
      const from = posix.dirname((env as { relativePath: string }).relativePath);
      const target = posix.normalize(posix.join(from, path));
      if (!isSitePage(target)) {
        const repoPath = posix.normalize(posix.join('docs', target));
        const kind = path.endsWith('/') ? 'tree' : 'blob';
        token.attrSet('href', `${REPO}/${kind}/main/${repoPath.replace(/\/$/, '')}${hash}`);
      }
    }
    return render(tokens, idx, options, env, self);
  };
}

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: '开始',
    items: [
      { text: '简介', link: '/guide/' },
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '基本概念', link: '/guide/concepts' },
      { text: '创建、容器与释放', link: '/guide/viewer' },
    ],
  },
  {
    text: '地球与数据',
    items: [
      { text: '相机与导航', link: '/guide/camera' },
      { text: '影像、叠加层与地形', link: '/guide/imagery-terrain' },
      { text: '3D Tiles', link: '/guide/tiles3d' },
      { text: 'GeoJSON 矢量与注记', link: '/guide/vector' },
      { text: '顶牌与点位标注', link: '/guide/markers' },
      { text: '高斯泼溅（3DGS）', link: '/guide/splats' },
    ],
  },
  {
    text: '室内与 BIM',
    items: [
      { text: '建筑、层级与实体', link: '/guide/indoor' },
      { text: '建筑数据制作手册', link: '/building-data-manual' },
    ],
  },
  {
    text: '场景与画面',
    items: [
      { text: '光照、大气、阴影与云', link: '/guide/environment' },
      { text: '局部场景（沙盘）', link: '/guide/local-scene' },
      { text: '描边、调色与自定义对象', link: '/guide/effects' },
    ],
  },
  {
    text: '交互与运行',
    items: [
      { text: '交互、拾取与事件', link: '/guide/interaction' },
      { text: '加载、错误与性能', link: '/guide/performance' },
    ],
  },
  {
    text: '附录',
    items: [
      { text: '演示应用', link: '/guide/demo-app' },
      { text: '常见问题', link: '/guide/faq' },
      { text: 'API 参考', link: '/api' },
      { text: '0.2.0 发布说明', link: '/releases/v0.2.0' },
    ],
  },
];

export default defineConfig({
  lang: 'zh-CN',
  title: 'TerraView',
  description: 'WebGPU 优先的三维地球 SDK：影像与地形、大气与体积云、3D Tiles、高斯泼溅、GeoJSON、顶牌与点位、室内 / BIM。',
  base: BASE,
  cleanUrls: true,
  outDir: '../dist-site',
  srcExclude: EXCLUDED.map((dir) => `${dir}**`),
  head: [
    [
      'link',
      {
        rel: 'icon',
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='28' fill='%231d4ed8'/%3E%3Cpath d='M4 32h56M32 4c10 9 10 47 0 56M32 4c-10 9-10 47 0 56' stroke='%2393c5fd' stroke-width='3' fill='none'/%3E%3C/svg%3E",
      },
    ],
  ],
  markdown: {
    config: githubLinks,
  },
  themeConfig: {
    nav: [
      { text: '手册', link: '/guide/', activeMatch: '^/guide/' },
      // The examples and the demo are separate Vite builds next to the site, not VitePress pages:
      // a `target` keeps the router from handling the click (the theme still prefixes the base).
      { text: '示例', link: '/examples/', target: '_self' },
      { text: '在线演示', link: '/demo/', target: '_self' },
      { text: 'API 参考', link: '/api' },
      {
        text: '0.2.0',
        items: [
          { text: '发布说明', link: '/releases/v0.2.0' },
          { text: '更新记录', link: `${REPO}/blob/main/CHANGELOG.md` },
          { text: 'npm', link: 'https://www.npmjs.com/package/terra-viewer' },
        ],
      },
    ],
    sidebar: {
      '/guide/': guide,
      '/building-data-manual': guide,
      '/api': guide,
      '/releases/': guide,
    },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: '在 GitHub 上编辑此页' },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    footer: {
      message: '以 Apache-2.0 许可发布。示例里的第三方数据按各自的许可使用，见示例面板中的署名。',
      copyright: 'TerraView',
    },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          // Chinese has no spaces between words: split with the browser's / Node's word segmenter.
          // VitePress serializes this function into the client, so it must not use outer variables.
          options: {
            tokenize: (text: string) => {
              const words: string[] = [];
              for (const part of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)) {
                if (!part.isWordLike) continue;
                words.push(part.segment);
                // `viewer.requestRender` is one segment: index its pieces too.
                if (/[._]/.test(part.segment)) words.push(...part.segment.split(/[._]+/).filter(Boolean));
              }
              return words;
            },
          },
          searchOptions: { combineWith: 'AND', fuzzy: false, prefix: true },
        },
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除',
            backButtonTitle: '关闭',
            noResultsText: '没有找到',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
  },
});
