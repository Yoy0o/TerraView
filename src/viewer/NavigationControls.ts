/**
 * Basic navigation commands (zoom, rotate, tilt, north up, home, orbit,
 * fullscreen, screenshot, opening spin) as a UI-free API on top of the
 * camera controller. Buttons, keyboard shortcuts or a host application call
 * these; none of it depends on the demo panels in `demo/ui/`.
 *
 * Every motion goes through the controller (`zoomBy`, `orbitBy`, `flyTo`,
 * `playAnimation`), so the camera invariants hold (zero roll, zoom keeps
 * heading and pitch, orbiting never passes over the pivot) and any gesture
 * interrupts a running command.
 */
import { Quaternion, Vector2, Vector3 } from 'three';
import { DEG2RAD } from '../core/math';
import { rotateCameraAboutCenter } from './cameraMath';
import type { GeoViewer, ViewPosition } from './GeoViewer';
import { playIntroSpin, type IntroSpinOptions } from './IntroAnimation';

/** Pitch (degrees) the "tilt" toggle goes to from a top-down view. */
const TILTED_PITCH = -45;
/** Views steeper than this (degrees) count as top-down. */
const TOP_DOWN_PITCH = -80;
const SCREEN_CENTER = new Vector2(0, 0);
const POLAR_AXIS = new Vector3(0, 0, 1);

/**
 * What auto rotate does from a view:
 * - `globe`: spin the globe about its axis (global view: orbiting a point there would swing the planet around)
 * - `orbit`: orbit the point at the screen center (near the ground, tilted)
 * - `tilt-orbit`: tilt to `tiltBeforeOrbit` first, then orbit (near the ground, looking straight down,
 *   where orbiting alone would only turn the picture like a 2D map)
 * - `none`: not available (e.g. low and looking at the sky or a far horizon)
 */
export type AutoRotateMode = 'globe' | 'orbit' | 'tilt-orbit' | 'none';

export interface AutoRotateContext {
  /** Camera height above the ellipsoid, meters. */
  height: number;
  /** Camera pitch, degrees (-90 = straight down). */
  pitch: number;
  /** Distance from the camera to the surface at the screen center, meters; null when there is none. */
  pivotDistance: number | null;
}

export interface AutoRotateSettings {
  /**
   * Longest camera-to-pivot distance (meters) for orbiting (default 200 km).
   * Distance, not height: a low camera looking at the horizon can have its
   * pivot hundreds of kilometers away. Views above this height spin the globe.
   */
  orbitMaxDistance: number;
  /** Views steeper than this pitch (degrees) count as top-down (default -75). */
  topDownPitch: number;
  /** Pitch (degrees) to tilt to before orbiting a top-down view (default -45); null orbits as is. */
  tiltBeforeOrbit: number | null;
  /** Orbit speed, degrees of heading per second (default 12; negative turns counter-clockwise). */
  orbitDegreesPerSecond: number;
  /**
   * Globe spin from a global view (10,000 km up), degrees of longitude per
   * second (default 6; positive turns the globe east like the earth). Lower
   * views spin proportionally slower, so the picture moves at a similar speed.
   */
  globeDegreesPerSecond: number;
  /** Lowest camera height (meters) for the globe spin (default 100 km), whatever `orbitMaxDistance` is. */
  globeMinHeight: number;
  /** Optional veto: return false to make auto rotate unavailable for a view (e.g. only inside buildings). */
  filter?: (ctx: AutoRotateContext & { mode: AutoRotateMode }) => boolean;
}

export const AUTO_ROTATE_DEFAULTS: AutoRotateSettings = {
  orbitMaxDistance: 200_000,
  topDownPitch: -75,
  tiltBeforeOrbit: -45,
  orbitDegreesPerSecond: 12,
  globeDegreesPerSecond: 6,
  globeMinHeight: 100_000,
};

/** Picks the auto rotate mode for a view (pure; `filter` is applied by the caller). */
export function classifyAutoRotate(
  ctx: AutoRotateContext,
  settings: Pick<AutoRotateSettings, 'orbitMaxDistance' | 'topDownPitch' | 'tiltBeforeOrbit'> & Partial<Pick<AutoRotateSettings, 'globeMinHeight'>>,
): AutoRotateMode {
  if (ctx.pivotDistance !== null && ctx.pivotDistance <= settings.orbitMaxDistance) {
    return ctx.pitch <= settings.topDownPitch && settings.tiltBeforeOrbit !== null ? 'tilt-orbit' : 'orbit';
  }
  // High above: spin the globe (it needs no pivot). Low with nothing close at the center: nothing sensible to do.
  const globeMin = Math.max(settings.orbitMaxDistance, settings.globeMinHeight ?? AUTO_ROTATE_DEFAULTS.globeMinHeight);
  return ctx.height > globeMin ? 'globe' : 'none';
}

/** Globe spin rate (degrees per second) at a camera height: full speed from 10,000 km up, proportionally slower below. */
export function globeSpinRate(degreesPerSecond: number, height: number): number {
  return degreesPerSecond * Math.min(1, Math.max(0.01, height / 1e7));
}

/** Spins the globe about the polar axis (the camera moves west) until interrupted; keeps latitude, heading and pitch. */
function spinGlobe(viewer: GeoViewer, degreesPerSecond: number): Promise<boolean> {
  const q = new Quaternion();
  return viewer.controller.playAnimation((dt, camera) => {
    const height = viewer.ellipsoid.cartesianToCartographic(camera.position)?.height ?? 1e7;
    q.setFromAxisAngle(POLAR_AXIS, -globeSpinRate(degreesPerSecond, height) * DEG2RAD * dt);
    rotateCameraAboutCenter(viewer.ellipsoid, camera.position, camera.quaternion, q);
    return true;
  });
}

export class NavigationControls {
  /** View that `home()` flies to (degrees / meters). */
  homeView: ViewPosition;
  /** Seconds for the animated rotate / tilt commands. */
  turnDuration = 0.6;
  /** Options `playIntro()` uses unless given others. */
  introOptions: IntroSpinOptions = {};
  /** How auto rotate behaves (see `classifyAutoRotate` and `startAutoRotate`). */
  autoRotate: AutoRotateSettings = { ...AUTO_ROTATE_DEFAULTS };

  private rotateToken = 0;
  /** Running auto rotate phase that is not a controller orbit: the globe spin or the tilt before an orbit. */
  private rotatePhase: 'globe' | 'tilt' | null = null;
  private introPlaying = false;

  constructor(
    private readonly viewer: GeoViewer,
    private readonly container: HTMLElement,
    homeView: ViewPosition,
  ) {
    this.homeView = { ...homeView };
    // A gesture ends every phase of auto rotate (the controller already stops its own orbit / animation).
    viewer.controller.events.on('interactionstart', () => {
      this.rotateToken++;
      this.rotatePhase = null;
    });
  }

  /** Zooms towards the screen center: the camera ends `factor` times closer (default 2). */
  zoomIn(factor = 2): void {
    if (factor > 0) this.viewer.controller.zoomBy(Math.log(factor));
  }

  /** Zooms away from the screen center: the camera ends `factor` times farther (default 2). */
  zoomOut(factor = 2): void {
    if (factor > 0) this.viewer.controller.zoomBy(-Math.log(factor));
  }

  /** Turns the heading by `degrees` (positive = clockwise) around the point at the screen center. */
  rotate(degrees: number): Promise<void> {
    return this.viewer.controller.orbitBy(degrees * DEG2RAD, 0, this.turnDuration);
  }

  /**
   * Changes the pitch by `degrees` around the point at the screen center
   * (positive raises the view towards the horizon), within the controller's
   * `pitchRangeDeg`.
   */
  tilt(degrees: number): Promise<void> {
    return this.viewer.controller.orbitBy(0, -degrees * DEG2RAD, this.turnDuration);
  }

  /** Orbits the screen-center point to a pitch in degrees (-90 = straight down), within `pitchRangeDeg`. */
  setPitch(pitch: number): Promise<void> {
    let delta = pitch - this.viewer.getView().pitch;
    // The orbit tilts by elevation above the pivot's horizon, which differs from the camera pitch
    // by the earth's curvature between them: aim past a pitch limit, the controller stops at it.
    if (pitch <= this.viewer.controller.pitchRangeDeg[0] + 0.01) delta -= 5;
    return this.tilt(delta);
  }

  /** True when looking (almost) straight down. */
  get isTopDown(): boolean {
    return this.viewer.getView().pitch <= TOP_DOWN_PITCH;
  }

  /** Top-down view when tilted, 45° tilt when top-down. */
  toggleTilt(): Promise<void> {
    return this.setPitch(this.isTopDown ? TILTED_PITCH : -90);
  }

  /** Turns back to north-up around the point at the screen center. */
  resetNorth(): void {
    this.viewer.resetNorth();
  }

  /** Flies to `homeView` (in a local scene: to its overview); duration in seconds (default: automatic). */
  home(duration?: number): Promise<void> {
    if (this.viewer.localScene.active) return this.viewer.localScene.fit(duration);
    return this.viewer.flyTo(this.homeView, duration);
  }

  // ---------------------------------------------------------------------------
  // Auto rotate: globe spin, orbit, or tilt-then-orbit depending on the view

  /** Surface point at the screen center (scene, else the reference ground when no globe is drawn). */
  private centerSurface(): Vector3 | null {
    return this.viewer.pick(SCREEN_CENTER)?.point ?? this.viewer.pickReferenceSurface(SCREEN_CENTER);
  }

  /** What `startAutoRotate()` would do from the current view (see `classifyAutoRotate`). */
  get autoRotateMode(): AutoRotateMode {
    const v = this.viewer;
    const view = v.getView();
    const pivot = this.centerSurface();
    const ctx = {
      height: view.height,
      pitch: view.pitch,
      pivotDistance: pivot ? v.camera.position.distanceTo(pivot) : null,
    };
    const mode = classifyAutoRotate(ctx, this.autoRotate);
    if (mode !== 'none' && this.autoRotate.filter && !this.autoRotate.filter({ ...ctx, mode })) return 'none';
    return mode;
  }

  /** True while auto rotate runs in any mode (including the tilt before an orbit). */
  get isAutoRotating(): boolean {
    return this.rotatePhase !== null || this.viewer.controller.isAutoOrbiting;
  }

  /**
   * Starts auto rotating the way that suits the view (`autoRotateMode`):
   * spinning the globe about its axis from a global view, orbiting the
   * screen-center point near the ground, tilting first when looking straight
   * down. Any gesture or other camera command stops it. Resolves when it stops.
   */
  async startAutoRotate(): Promise<void> {
    this.stopAutoRotate();
    const mode = this.autoRotateMode;
    const token = ++this.rotateToken;
    const o = this.autoRotate;
    if (mode === 'none') return;
    if (mode === 'globe') {
      this.rotatePhase = 'globe';
      await spinGlobe(this.viewer, o.globeDegreesPerSecond);
    } else {
      if (mode === 'tilt-orbit' && o.tiltBeforeOrbit !== null) {
        this.rotatePhase = 'tilt';
        const [minPitch, maxPitch] = this.viewer.controller.pitchRangeDeg;
        const target = Math.min(maxPitch, Math.max(minPitch, o.tiltBeforeOrbit));
        await this.setPitch(target);
        // Interrupted (gesture, stop, another command) or the tilt could not happen: do not orbit.
        if (token !== this.rotateToken || Math.abs(this.viewer.getView().pitch - target) > 5) {
          if (token === this.rotateToken) this.rotatePhase = null;
          return;
        }
      }
      this.rotatePhase = null;
      await this.viewer.startAutoOrbit({ degreesPerSecond: o.orbitDegreesPerSecond });
      return;
    }
    if (token === this.rotateToken) this.rotatePhase = null;
  }

  /** Stops auto rotate in whatever mode or phase it is. */
  stopAutoRotate(): void {
    const phase = this.rotatePhase;
    this.rotateToken++;
    this.rotatePhase = null;
    if (phase === 'globe') this.viewer.controller.stopAnimation();
    // Stops the orbit as well as the eased tilt that precedes it (both are controller orbit animations).
    this.viewer.controller.stopAutoOrbit();
  }

  /** Starts auto rotate, or stops it when running. */
  toggleAutoRotate(): void {
    if (this.isAutoRotating) this.stopAutoRotate();
    else void this.startAutoRotate();
  }

  /** @deprecated Use `isAutoRotating`. */
  get isAutoOrbiting(): boolean {
    return this.isAutoRotating;
  }

  /** @deprecated Use `toggleAutoRotate`; the orbit speed is `autoRotate.orbitDegreesPerSecond`. */
  toggleAutoOrbit(): void {
    this.toggleAutoRotate();
  }

  /**
   * The point an auto orbit may use: `pivot`, else the surface at the screen
   * center, as long as it is within `autoRotate.orbitMaxDistance` of the
   * camera. Null when orbiting would swing the camera across a region (or the
   * planet) instead of around a place.
   */
  orbitPivot(pivot?: Vector3): Vector3 | null {
    // Over the background of a local scene: orbit its center.
    const p = pivot ?? this.centerSurface() ?? this.viewer.controller.bounds?.center.clone() ?? null;
    return p && this.viewer.camera.position.distanceTo(p) <= this.autoRotate.orbitMaxDistance ? p : null;
  }

  /** True while the opening spin (or another scripted camera animation, e.g. the globe spin) runs. */
  get isAnimating(): boolean {
    return this.viewer.controller.isAnimating;
  }

  /** True while the opening spin runs. */
  get isIntroPlaying(): boolean {
    return this.introPlaying;
  }

  /**
   * Plays the opening spin ending on the current view (see `IntroSpinOptions`).
   * Resolves true when it ran to the end, false when skipped or interrupted.
   */
  async playIntro(options: IntroSpinOptions = this.introOptions): Promise<boolean> {
    this.stopAutoRotate();
    this.introPlaying = true;
    try {
      return await playIntroSpin(this.viewer, options);
    } finally {
      this.introPlaying = false;
    }
  }

  /** Stops the opening spin where it is. */
  stopIntro(): void {
    if (this.introPlaying) this.viewer.controller.stopAnimation();
  }

  get isFullscreen(): boolean {
    return document.fullscreenElement === this.container;
  }

  /** Shows the viewer's container full screen, or leaves full screen. */
  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.container.requestFullscreen?.();
  }

  /**
   * The current 3D view as an image (PNG unless `type` says otherwise). HTML
   * markers and panels lie above the canvas and are not included.
   */
  screenshot(type = 'image/png', quality?: number): Promise<Blob> {
    const canvas = this.viewer.captureFrame();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('screenshot failed: empty canvas'))), type, quality);
    });
  }
}
