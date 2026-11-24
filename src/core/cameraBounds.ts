/**
 * Contract between the camera controller and whatever keeps the view in an area (the local
 * scene sets it as `controller.bounds`). A plain type in `core/` so neither side imports the
 * other.
 */
import type { Vector3 } from 'three';

/**
 * Area the view stays in (a local scene, or any host that wants a "max bounds"): the view may
 * not lose it, the camera may not get farther than `maxRange` from `center`, and gestures over
 * empty space (no surface under the cursor) use `center` and the reference ground instead of
 * spinning the camera in place.
 *
 * "Not lose it": the line of sight through the screen center, from the camera down to the
 * reference ground, has to pass over the area (widened by the host's margin). Its point
 * closest to `center` is what `clampFocus` checks: looking straight down that is the point at
 * the screen center; looking across the area at a low angle the view may reach far beyond it.
 *
 * @advanced
 */
export interface CameraBounds {
  /** ECEF point orbited and zoomed towards when the cursor or the screen center is over empty space. */
  readonly center: Vector3;
  /** Ellipsoidal height (meters) of the reference ground: drags that miss the scene grab it; the view center is measured on it. */
  readonly referenceHeight: number;
  /** Farthest the camera may be from `center` (meters); zooming out stops there. */
  readonly maxRange: number;
  /**
   * Moves a point of the line of sight (ECEF) horizontally back into the allowed area; returns
   * whether it moved (`out` is then the moved point).
   */
  clampFocus(point: Vector3, out: Vector3): boolean;
}
