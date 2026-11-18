/**
 * Color grading (roadmap M3.3): exposure, contrast and saturation of the picture
 * (`viewer.colorGrading`).
 *
 * Exposure is the renderer's `toneMappingExposure` (part of tone mapping, free). Contrast and
 * saturation are a `display` effect, applied to the tone-mapped picture before the outlines (so
 * outline colors stay exactly as given), and active only while one of them differs from 1: the
 * neutral setting costs nothing. Values are uniforms; changing them does not rebuild shaders.
 */
import { saturation, uniform, vec4 } from 'three/tsl';
import type { WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { PostEffect } from './PostPipeline';
import { COLOR_GRADING_PRESETS, gradingPassNeeded, normalizeGrading, type ColorGradingOptions } from './postMath';

/** The contrast / saturation pass (registered as `grading` in `viewer.postProcessing`). */
export class ColorGradingEffect implements PostEffect {
  readonly name = 'grading';
  readonly stage = 'display' as const;
  /** Before the outlines (order 100). */
  readonly order = 0;
  readonly graphVersion = 0;
  readonly contrast = uniform(1);
  readonly saturation = uniform(1);

  get active(): boolean {
    return gradingPassNeeded({ exposure: 1, contrast: this.contrast.value as number, saturation: this.saturation.value as number });
  }

  build(input: TSLNode): TSLNode {
    // Contrast around mid gray of the displayed (sRGB) values, then saturation against luminance.
    const contrasted = input.rgb.sub(0.5).mul(this.contrast).add(0.5);
    return vec4(saturation(contrasted, this.saturation).clamp(0, 1), input.a);
  }

  dispose(): void {
    /* uniforms only */
  }
}

/** `viewer.colorGrading`: exposure, contrast and saturation of the picture. */
export class ColorGrading {
  /** Created by the viewer. */
  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly effect: ColorGradingEffect,
    private readonly changed: () => void,
  ) {}

  /** Light multiplier before tone mapping, 0.1–4 (default 1). */
  get exposure(): number {
    return this.renderer.toneMappingExposure;
  }

  set exposure(v: number) {
    this.set({ exposure: v });
  }

  /** Contrast around mid gray, 0–2 (default 1: no change). */
  get contrast(): number {
    return this.effect.contrast.value as number;
  }

  set contrast(v: number) {
    this.set({ contrast: v });
  }

  /** Saturation, 0 (gray) – 2 (default 1: no change). */
  get saturation(): number {
    return this.effect.saturation.value as number;
  }

  set saturation(v: number) {
    this.set({ saturation: v });
  }

  /** The settings in effect. */
  get options(): Required<ColorGradingOptions> {
    return { exposure: this.exposure, contrast: this.contrast, saturation: this.saturation };
  }

  /**
   * Changes some settings (others stay; values outside the ranges are clamped, invalid ones
   * ignored). E.g. `set(COLOR_GRADING_PRESETS.vivid)`.
   */
  set(options: ColorGradingOptions): void {
    const before = this.options;
    if (options.exposure !== undefined) this.renderer.toneMappingExposure = normalizeGrading('exposure', options.exposure, before.exposure);
    if (options.contrast !== undefined) this.effect.contrast.value = normalizeGrading('contrast', options.contrast, before.contrast);
    if (options.saturation !== undefined) this.effect.saturation.value = normalizeGrading('saturation', options.saturation, before.saturation);
    const after = this.options;
    if (after.exposure !== before.exposure || after.contrast !== before.contrast || after.saturation !== before.saturation) this.changed();
  }

  /** Back to the neutral look (exposure, contrast and saturation 1). */
  reset(): void {
    this.set(COLOR_GRADING_PRESETS.neutral);
  }
}
