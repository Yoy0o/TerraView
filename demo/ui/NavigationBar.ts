/**
 * Navigation button bar (demo UI): zoom, rotate, top-down / tilt, home,
 * orbit, fullscreen, screenshot and replaying the opening spin. Every button
 * only calls `viewer.navigation` (the UI-free API in
 * `viewer/NavigationControls.ts`), so a host application can build its own
 * controls on the same commands.
 */
import type { AutoRotateMode, GeoViewer } from 'terra-viewer';
import { h } from './dom';

/** 24×24 stroke icons (currentColor). Static markup, no user input. */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  rotateLeft: '<path d="M4 4v5h5"/><path d="M4.6 15a8 8 0 1 0 1.8-8.4L4 9"/>',
  rotateRight: '<path d="M20 4v5h-5"/><path d="M19.4 15a8 8 0 1 1-1.8-8.4L20 9"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><path d="M20.5 9.5A9 9 0 1 0 21 12"/><path d="M21 5v4.5h-4.5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  intro: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c-2.6 2.4-3.8 5.2-3.8 8.5s1.2 6.1 3.8 8.5c2.6-2.4 3.8-5.2 3.8-8.5S14.6 5.9 12 3.5z"/>',
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

export class NavigationBar {
  readonly root: HTMLElement;
  private readonly tiltButton: HTMLButtonElement;
  private readonly orbitButton: HTMLButtonElement;
  private readonly introButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private frame = 0;

  constructor(
    private readonly viewer: GeoViewer,
    /** Called when a command fails (e.g. fullscreen refused by the browser). */
    private readonly notify: (text: string, kind?: 'info' | 'error') => void = () => undefined,
  ) {
    const nav = viewer.navigation;
    const button = (title: string, content: SVGSVGElement | string, onClick: () => void) => {
      const b = h('button', { class: 'nav-btn', type: 'button', title, 'aria-label': title });
      b.append(content);
      b.addEventListener('click', onClick);
      return b;
    };
    this.tiltButton = button('俯视 / 倾斜', '3D', () => void nav.toggleTilt());
    this.tiltButton.classList.add('nav-text');
    this.orbitButton = button('自动旋转', icon('orbit'), () => {
      nav.toggleAutoRotate();
      this.refresh();
    });
    this.introButton = button('重播开场动画', icon('intro'), () => {
      if (nav.isIntroPlaying) nav.stopIntro();
      else void nav.playIntro({ ...nav.introOptions, force: true });
      this.refresh();
    });
    this.fullscreenButton = button('全屏', icon('fullscreen'), () => {
      nav.toggleFullscreen().catch(() => this.notify('浏览器拒绝了全屏请求', 'error'));
    });

    this.root = h(
      'nav',
      { class: 'nav-bar', 'aria-label': '导航控制' },
      h(
        'div',
        { class: 'nav-group' },
        button('放大', icon('plus'), () => nav.zoomIn()),
        button('缩小', icon('minus'), () => nav.zoomOut()),
      ),
      h(
        'div',
        { class: 'nav-group' },
        button('向左旋转 45°', icon('rotateLeft'), () => void nav.rotate(-45)),
        button('向右旋转 45°', icon('rotateRight'), () => void nav.rotate(45)),
        this.tiltButton,
      ),
      h(
        'div',
        { class: 'nav-group' },
        button('回到初始视角', icon('home'), () => void nav.home()),
        this.orbitButton,
        this.introButton,
      ),
      h(
        'div',
        { class: 'nav-group' },
        this.fullscreenButton,
        button('截图（保存为 PNG）', icon('camera'), () => void this.saveScreenshot()),
      ),
    );

    document.addEventListener('fullscreenchange', () => this.refresh());
    // Button states follow the camera; a few updates per second is enough.
    viewer.events.on('frame', () => {
      if (++this.frame % 10 === 0) this.refresh();
    });
    this.refresh();
  }

  private refresh(): void {
    const nav = this.viewer.navigation;
    const topDown = nav.isTopDown;
    setText(this.tiltButton, topDown ? '3D' : '2D');
    this.tiltButton.title = topDown ? '倾斜视角（45°）' : '俯视';
    // Auto rotate picks its behavior from the view (globe spin / orbit / tilt then orbit); a running one can always be stopped.
    const rotating = nav.isAutoRotating;
    const mode = rotating ? null : nav.autoRotateMode;
    this.orbitButton.classList.toggle('active', rotating);
    this.orbitButton.disabled = mode === 'none';
    this.orbitButton.title = rotating ? '停止旋转' : autoRotateLabel(mode!);
    const intro = nav.isIntroPlaying;
    this.introButton.classList.toggle('active', intro);
    this.introButton.title = intro ? '停止开场动画' : '重播开场动画';
    const full = nav.isFullscreen;
    if (this.fullscreenButton.classList.contains('active') !== full || !this.fullscreenButton.firstChild) {
      this.fullscreenButton.replaceChildren(icon(full ? 'exitFullscreen' : 'fullscreen'));
      this.fullscreenButton.classList.toggle('active', full);
      this.fullscreenButton.title = full ? '退出全屏' : '全屏';
    }
  }

  private async saveScreenshot(): Promise<void> {
    try {
      const blob = await this.viewer.navigation.screenshot();
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = h('a', { href: url, download: `terraview-${stamp}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.notify(`截图失败：${(err as Error).message}`, 'error');
    }
  }
}

/** Button tooltip for what auto rotate will do from the current view (shared with the panel). */
export function autoRotateLabel(mode: AutoRotateMode): string {
  switch (mode) {
    case 'globe':
      return '地球自转（全球视角；任意操作即停止）';
    case 'orbit':
      return '环绕浏览：绕屏幕中心点旋转（任意操作即停止）';
    case 'tilt-orbit':
      return '环绕浏览：先倾斜到 45°，再绕屏幕中心点旋转';
    case 'none':
      return '自动旋转不可用：屏幕中心附近没有地面（请对准地面或拉远到全球视角）';
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
