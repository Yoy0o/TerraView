/** The examples gallery (`examples/index.html`): every entry of the catalog, grouped. */
import { EXAMPLES, GROUP_TITLES, REPO, type ExampleGroup } from './catalog';
import './shared/example.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(text: string, href: string, external = false): HTMLAnchorElement {
  const a = el('a', text);
  a.href = href;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

const root = document.getElementById('gallery')!;

const header = el('header');
const nav = el('nav');
// The gallery lives at <site>/examples/, next to the manual (<site>/) and the demo (<site>/demo/).
nav.append(link('使用手册', '../'), link('演示应用', '../demo/'), link('GitHub', REPO, true));
header.append(
  el('h1', 'TerraView 示例'),
  el('p', '每个示例是一个独立页面，只通过 terra-viewer 的公共 API 编写，源码可以直接拿来改。需要支持 WebGPU 或 WebGL 2 的浏览器。'),
  nav,
);
root.append(header);

for (const group of Object.keys(GROUP_TITLES) as ExampleGroup[]) {
  const items = EXAMPLES.filter((e) => e.group === group);
  if (items.length === 0) continue;
  root.append(el('h2', GROUP_TITLES[group]));
  const cards = el('div');
  cards.className = 'ex-cards';
  for (const info of items) {
    const card = el('article');
    card.className = 'ex-card';
    const title = el('h3');
    title.append(link(info.title, `./${info.id}/`));
    const links = el('nav');
    links.append(link('打开', `./${info.id}/`), link('手册', `../guide/${info.guide}`), link('源码', `${REPO}/blob/main/examples/${info.id}/main.ts`, true));
    card.append(title, el('p', info.summary), links);
    cards.append(card);
  }
  root.append(cards);
}
