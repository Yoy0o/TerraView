/**
 * Checks of `GeoViewerOptions` that the type system cannot enforce for hosts written in plain
 * JavaScript: a missing required option otherwise surfaces much later as an error in every
 * frame (and in `dispose()`). Dependency-free, unit tested.
 */
import { TerraViewError } from '../core/errors';

/** Throws an `option-invalid` `TerraViewError` (`details.option`, `details.expected`) when a required option is missing or wrong. */
export function checkViewerOptions(options: unknown): void {
  const o = (options ?? {}) as { container?: unknown; imagery?: unknown };
  const container = o.container as { appendChild?: unknown } | null | undefined;
  if (!container || typeof container !== 'object' || typeof container.appendChild !== 'function') {
    throw new TerraViewError('option-invalid', 'GeoViewerOptions.container must be an HTMLElement', { option: 'container', expected: 'HTMLElement' });
  }
  const imagery = o.imagery as { requestImage?: unknown } | null | undefined;
  if (!imagery || typeof imagery !== 'object' || typeof imagery.requestImage !== 'function') {
    throw new TerraViewError('option-invalid', 'GeoViewerOptions.imagery must be an ImageryProvider, e.g. IMAGERY_PRESETS[0].create()', {
      option: 'imagery',
      expected: 'ImageryProvider',
    });
  }
}
