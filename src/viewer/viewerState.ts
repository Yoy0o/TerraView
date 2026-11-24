/**
 * State a viewer's parts share (`GeoViewer` owns it; the environment, the frame loop, picking
 * and the layers read and write it): scene switches behind the viewer's getters and setters,
 * the simulated date, and what each frame learns about the camera's position and the ground
 * under it.
 */
import { cartographic, type Cartographic } from '../core/Ellipsoid';
import type { Building } from '../indoor/Building';
import type { IndoorManager } from '../indoor/IndoorManager';

export interface ViewerState {
  /** `viewer.lighting`, `atmosphere`, `showGlobe`, `showStars`. */
  lighting: boolean;
  atmosphere: boolean;
  showGlobe: boolean;
  showStars: boolean;
  /** Simulated date driving the sun and star positions (`viewer.date`). */
  date: Date;
  /** Simulated seconds per real second, 0 = paused (`viewer.timeMultiplier`). */
  timeMultiplier: number;
  /** `viewer.indoorBackdrop`. */
  indoorBackdrop: boolean;
  /** Camera position (radians, meters above the ellipsoid), refreshed at the start of each frame. */
  readonly cameraCarto: Cartographic;
  /** Ground height under the camera from the last collision query (meters above the ellipsoid; 0 until known). */
  viewGround: number;
}

export function createViewerState(): ViewerState {
  return {
    lighting: false,
    atmosphere: true,
    showGlobe: true,
    showStars: true,
    date: new Date(),
    timeMultiplier: 0,
    indoorBackdrop: true,
    cameraCarto: cartographic(),
    viewGround: 0,
  };
}

/** Building the indoor level is in, or null on the globe. */
export function enteredBuilding(indoor: IndoorManager): Building | null {
  return (indoor.current?.closest('building') as Building | null) ?? null;
}
