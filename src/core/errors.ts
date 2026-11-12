/**
 * Errors the SDK raises on purpose: a stable `code` plus `details` for hosts to react to or
 * translate, and an English `message` for logs and developers. User-facing wording belongs to
 * the host (the demo maps codes to Chinese in `demo/ui/errors.ts`).
 *
 * Dependency-free, so Workers can raise them too; across the Worker boundary the code and
 * details travel in the message and the main thread rebuilds the error.
 */

/**
 * What went wrong. `details` per code:
 * - `imagery-unreachable`: `provider` (name), `reason` (last request error)
 * - `terrain-format-unsupported`: `format` (from layer.json)
 * - `terrain-projection-unsupported`: `projection` (from layer.json)
 * - `ion-asset-not-terrain`: `assetId`, `type` (the asset's type)
 * - `building-invalid`: `path` (JSON path of the offending field, e.g. `$.floors[0].height`)
 * - `building-already-loaded`: `id`
 * - `points-empty`: none (`message` repeats the first parse warning when there is one)
 * - `geojson-invalid`: none
 * - `option-invalid`: `option` (name in `GeoViewerOptions`), `expected` (what it must be)
 */
export type TerraViewErrorCode =
  | 'imagery-unreachable'
  | 'terrain-format-unsupported'
  | 'terrain-projection-unsupported'
  | 'ion-asset-not-terrain'
  | 'building-invalid'
  | 'building-already-loaded'
  | 'points-empty'
  | 'geojson-invalid'
  | 'option-invalid';

export type TerraViewErrorDetails = Readonly<Record<string, string | number>>;

export class TerraViewError extends Error {
  readonly code: TerraViewErrorCode;
  readonly details: TerraViewErrorDetails;

  constructor(code: TerraViewErrorCode, message: string, details: TerraViewErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TerraViewError';
    this.code = code;
    this.details = details;
  }
}

/** Whether `value` is a `TerraViewError` (with the given code, when one is passed). */
export function isTerraViewError(value: unknown, code?: TerraViewErrorCode): value is TerraViewError {
  return value instanceof TerraViewError && (code === undefined || value.code === code);
}
