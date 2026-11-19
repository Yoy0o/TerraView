/**
 * `viewer.transparency` (roadmap M3.9): order-independent transparency (OIT) for buildings and
 * devices. Glass curtain walls, windows and level-faded rooms are blended by weight instead of
 * being sorted per object, so overlapping transparent surfaces look the same from every angle
 * (no popping as the camera turns). The pass itself is in `PostPipeline` (`drawTransparent`).
 */
import type { PostPipeline } from './PostPipeline';

/** `GeoViewerOptions.transparency`. */
export interface TransparencyOptions {
  /**
   * Weighted blended OIT for transparent building and device surfaces (WebGPU; default from the
   * GPU tier: on `ultra` only). Costs two more multisampled targets the size of the canvas while
   * such surfaces are on screen (9 bytes per sample and pixel). The WebGL backend keeps sorting.
   */
  orderIndependent?: boolean;
}

export class Transparency {
  /** Created by the viewer. */
  constructor(
    private readonly pipeline: PostPipeline,
    /** The picture must be drawn again. */
    private readonly changed: () => void,
    defaults: { orderIndependent: boolean; supported: boolean },
    options: TransparencyOptions = {},
  ) {
    pipeline.oitSupported = defaults.supported;
    pipeline.oitEnabled = options.orderIndependent ?? defaults.orderIndependent;
  }

  /** Order-independent transparency for buildings and devices (see `TransparencyOptions`). Only takes effect where `supported`. */
  get orderIndependent(): boolean {
    return this.pipeline.oitEnabled;
  }

  set orderIndependent(on: boolean) {
    on = on === true;
    if (on === this.pipeline.oitEnabled) return;
    this.pipeline.oitEnabled = on;
    this.changed();
  }

  /** The backend can draw order-independent transparency (WebGPU). */
  get supported(): boolean {
    return this.pipeline.oitSupported;
  }

  /** Transparent building surfaces were blended order-independently in the last frame. */
  get active(): boolean {
    return this.pipeline.oitDrawn;
  }

  /** Changes some settings. */
  set(options: TransparencyOptions): void {
    if (options.orderIndependent !== undefined) this.orderIndependent = options.orderIndependent;
  }
}
