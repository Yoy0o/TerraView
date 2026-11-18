/**
 * `viewer.supersampling` (roadmap M3.3): settings and state of still supersampling. Once the view
 * has been still for a second (docs/api.md §1.8), the viewer draws `samples` frames with sub-pixel
 * camera offsets and averages them (`PostPipeline.renderSample`), then stops drawing until
 * something changes. The frame loop decides when (`viewer/framePacing.ts`, `drawMode`).
 */
import type { PostPipeline } from './PostPipeline';
import { normalizeSampleCount } from './postMath';

/** `GeoViewerOptions.supersampling` (or `true` / `false` for `enabled`). */
export interface SupersamplingOptions {
  /** Refine still views (default true). Off: still views are redrawn at `idleFrameRate` instead. */
  enabled?: boolean;
  /** Samples averaged into a still picture, 4–64 (default 16 with MSAA, 32 without). */
  samples?: number;
}

/** What the viewer gives `Supersampling`. */
export interface SupersamplingHost {
  /** The picture must be drawn again (turned on or off). */
  changed(): void;
  /** Run frames at the full rate (more samples to take). */
  wake(): void;
}

export class Supersampling {
  private _enabled: boolean;
  private _samples: number;

  /** Created by the viewer. */
  constructor(
    private readonly pipeline: PostPipeline,
    /** The canvas has MSAA (decides the default sample count). */
    private readonly msaa: boolean,
    private readonly host: SupersamplingHost,
    options: boolean | SupersamplingOptions = {},
  ) {
    const o = typeof options === 'boolean' ? { enabled: options } : (options ?? {});
    this._enabled = o.enabled !== false;
    this._samples = normalizeSampleCount(o.samples, msaa);
  }

  /**
   * Refine still views and stop drawing once refined (default true). Off: still views are drawn
   * at `idleFrameRate` like any quiet view, and the history buffer is freed.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(on: boolean) {
    on = on !== false;
    if (on === this._enabled) return;
    this._enabled = on;
    if (!on) this.pipeline.releaseHistory();
    this.host.changed();
  }

  /** Samples averaged into a still picture, 4–64 (default 16 with MSAA, 32 without). */
  get samples(): number {
    return this._samples;
  }

  set samples(n: number) {
    const v = normalizeSampleCount(n, this.msaa);
    if (v === this._samples) return;
    this._samples = v;
    // More samples: carry on refining the picture on screen; fewer: it is held as it is.
    this.host.wake();
  }

  /** Samples averaged in the picture on the canvas (0 while frames are drawn live). */
  get sampleCount(): number {
    return this._enabled ? this.pipeline.samples : 0;
  }

  /** The picture on the canvas has all its samples: the viewer holds it and draws nothing. */
  get converged(): boolean {
    return this._enabled && this.pipeline.samples >= this._samples;
  }

  /** Changes some settings (`enabled`, `samples`). */
  set(options: SupersamplingOptions): void {
    if (options.samples !== undefined) this.samples = options.samples;
    if (options.enabled !== undefined) this.enabled = options.enabled;
  }
}
