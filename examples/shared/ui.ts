/**
 * Page scaffolding shared by the examples: the viewer container, a floating panel with the
 * example's title, links (gallery, manual chapter, source) and small form controls, and error
 * display. Nothing here is SDK API: each example's `main.ts` calls the SDK itself, so that it
 * reads like host code. Global listeners are fine here (an example is an application, not the SDK).
 */
import type { GeoViewer } from 'terra-viewer';
import { findExample, REPO } from '../catalog';
import './example.css';

export interface SliderOptions {
  min: number;
  max: number;
  step?: number;
  value: number;
  /** Formats the value shown next to the label (default: the number itself). */
  format?: (value: number) => string;
}

export interface ExampleUi {
  /** The element to pass as `container` to `GeoViewer.create`. */
  container: HTMLElement;
  /** Exposes the viewer as `window.viewer` and shows its load errors in the panel. */
  attach(viewer: GeoViewer): void;
  /** A heading above the next controls. */
  section(title: string): void;
  /** A paragraph of explanation (plain text). */
  note(text: string): HTMLElement;
  /** A row of buttons. */
  buttons(items: Array<[label: string, onClick: () => void]>): HTMLButtonElement[];
  toggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement;
  slider(label: string, options: SliderOptions, onInput: (value: number) => void): HTMLInputElement;
  select<T extends string>(label: string, options: Array<[value: T, label: string]>, value: T, onChange: (value: T) => void): HTMLSelectElement;
  /** A read-only line the example updates (coordinates, counts, the last event). */
  output(label: string, initial?: string): { set(text: string): void };
  /** A short message at the bottom of the panel; `error` styles it as a failure. */
  status(text: string, kind?: 'info' | 'error'): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(text: string, href: string, external = false): HTMLAnchorElement {
  const a = el('a', undefined, text);
  a.href = href;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

/** Builds the page for example `id` (its folder name, listed in `examples/catalog.ts`). */
export function setupExample(id: string): ExampleUi {
  const info = findExample(id);
  document.title = `${info.title} · TerraView 示例`;

  const container = el('div', 'ex-viewer');
  const panel = el('aside', 'ex-panel');
  const header = el('header', 'ex-header');
  const title = el('h1', undefined, info.title);
  const collapse = el('button', 'ex-collapse', '−');
  collapse.title = '收起 / 展开';
  collapse.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('ex-collapsed');
    collapse.textContent = collapsed ? '+' : '−';
  });
  header.append(title, collapse);

  const links = el('nav', 'ex-links');
  // Examples live at <site>/examples/<id>/, the manual at <site>/guide/<page>.
  links.append(link('← 全部示例', '../'), link('手册', `../../guide/${info.guide}`, true), link('源码', `${REPO}/blob/main/examples/${id}/main.ts`, true));

  const body = el('div', 'ex-body');
  body.append(el('p', 'ex-summary', info.summary));
  const controls = el('div', 'ex-controls');
  body.append(controls);
  if (info.credit) body.append(el('p', 'ex-credit', info.credit));
  const statusLine = el('p', 'ex-status');
  statusLine.hidden = true;
  body.append(statusLine);

  panel.append(header, links, body);
  document.body.append(container, panel);

  const status = (text: string, kind: 'info' | 'error' = 'info') => {
    statusLine.hidden = !text;
    statusLine.textContent = text;
    statusLine.classList.toggle('ex-error', kind === 'error');
  };

  // Startup failures (no WebGPU / WebGL 2, a bad option) end up here instead of only in the console.
  const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  window.addEventListener('error', (e) => status(`出错：${describe(e.error ?? e.message)}`, 'error'));
  window.addEventListener('unhandledrejection', (e) => status(`出错：${describe(e.reason)}`, 'error'));

  const labeled = (label: string, input: HTMLElement, value?: HTMLElement) => {
    const row = el('label', 'ex-row');
    const name = el('span', 'ex-label', label);
    row.append(name, input);
    if (value) row.append(value);
    controls.append(row);
    return row;
  };

  return {
    container,
    attach(viewer) {
      // For the browser console and the smoke test (tests/e2e/examples.e2e.ts).
      (window as unknown as { viewer: GeoViewer }).viewer = viewer;
      viewer.events.on('error', ({ source, error }) => {
        const code = (error as { code?: string }).code;
        status(`${source} 加载失败${code ? `（${code}）` : ''}：${error.message}`, 'error');
      });
    },
    section(text) {
      controls.append(el('h2', undefined, text));
    },
    note(text) {
      const p = el('p', 'ex-note', text);
      controls.append(p);
      return p;
    },
    buttons(items) {
      const row = el('div', 'ex-buttons');
      const created = items.map(([label, onClick]) => {
        const b = el('button', undefined, label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
      });
      row.append(...created);
      controls.append(row);
      return created;
    },
    toggle(label, checked, onChange) {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      labeled(label, input).classList.add('ex-toggle');
      return input;
    },
    slider(label, options, onInput) {
      const input = el('input');
      input.type = 'range';
      input.min = String(options.min);
      input.max = String(options.max);
      input.step = String(options.step ?? 'any');
      input.value = String(options.value);
      const format = options.format ?? ((v: number) => String(v));
      const value = el('span', 'ex-value', format(options.value));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        value.textContent = format(v);
        onInput(v);
      });
      labeled(label, input, value).classList.add('ex-slider');
      return input;
    },
    select(label, options, value, onChange) {
      const input = el('select');
      for (const [v, text] of options) {
        const option = el('option', undefined, text);
        option.value = v;
        input.append(option);
      }
      input.value = value;
      input.addEventListener('change', () => onChange(input.value as (typeof options)[number][0]));
      labeled(label, input);
      return input;
    },
    output(label, initial = '—') {
      const value = el('output', 'ex-output', initial);
      labeled(label, value).classList.add('ex-readout');
      return { set: (text: string) => void (value.textContent = text) };
    },
    status,
  };
}
