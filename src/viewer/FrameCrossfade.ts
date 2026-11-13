/**
 * Level-change crossfade: copies the last frame into a 2D canvas laid over
 * the WebGPU canvas and fades it out, so content switching on or off at a
 * level change (3D Tiles suppressed, building shell, floors) dissolves
 * instead of popping. The fade is a CSS opacity transition, run by the
 * compositor and independent of the render loop. HTML labels sit above it
 * and are not part of the copy.
 *
 * @advanced Reached as `viewer.levelTransition` (not exported from the package entry).
 */
export class FrameCrossfade {
  /** Fade length in milliseconds; 0 turns the crossfade off. */
  duration = 450;
  private readonly overlay: HTMLCanvasElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly source: HTMLCanvasElement) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'tv-crossfade';
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.hidden = true;
    source.after(this.overlay);
  }

  /**
   * Starts a crossfade from the current picture. `render` must draw the
   * current frame synchronously: a WebGL drawing buffer is only readable in
   * the task that drew it.
   */
  start(render: () => void): void {
    const { width, height } = this.source;
    if (this.duration <= 0 || width === 0 || height === 0 || document.visibilityState === 'hidden') return;
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    try {
      render();
      if (this.overlay.width !== width || this.overlay.height !== height) {
        this.overlay.width = width;
        this.overlay.height = height;
      }
      ctx.drawImage(this.source, 0, 0);
    } catch {
      return; // A frame that cannot be copied just switches without a fade.
    }
    const style = this.overlay.style;
    style.transition = 'none';
    style.opacity = '1';
    this.overlay.hidden = false;
    // Commit the opaque state before starting the transition.
    void this.overlay.offsetWidth;
    style.transition = `opacity ${this.duration}ms cubic-bezier(0.33, 0, 0.2, 1)`;
    style.opacity = '0';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.overlay.hidden = true;
    }, this.duration + 50);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.overlay.remove();
  }
}
