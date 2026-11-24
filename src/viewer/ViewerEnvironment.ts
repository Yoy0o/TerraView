/**
 * Environment of a viewer for the frame (`GeoViewer` frame loop, and renders outside it): the
 * sun and atmosphere uniforms, stars, the sun and sky lights of buildings and 3D Tiles (from
 * the CPU atmosphere model while lighting is on, M3.5), the input of the sun shadow fit (M3.9)
 * and the frame state of the volumetric clouds.
 */
import { LinearSRGBColorSpace, Matrix4, Vector2, Vector3, type DirectionalLight, type HemisphereLight, type LightProbe, type PerspectiveCamera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { AtmosphereLighting, type AtmosphereLight } from '../atmosphere/AtmosphereLighting';
import { atmosphereUniforms, Z_SCALE } from '../atmosphere/AtmosphereNodes';
import type { StarField } from '../atmosphere/Stars';
import type { VolumetricClouds } from '../clouds/VolumetricClouds';
import type { Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD, smoothstep } from '../core/math';
import { greenwichMeanSiderealTime, sunDirectionECEF } from '../core/SunPosition';
import type { Globe } from '../globe/Globe';
import type { Building } from '../indoor/Building';
import type { IndoorManager } from '../indoor/IndoorManager';
import type { ShadowCaster, SunShadows } from '../lighting/SunShadows';
import type { LocalScene } from '../local/LocalScene';
import { cameraDirection } from './cameraMath';
import type { IndoorBackdrop } from './IndoorBackdrop';
import { enteredBuilding, type ViewerState } from './viewerState';

/** What the environment reads and writes of its viewer. */
export interface EnvironmentHost {
  readonly state: ViewerState;
  readonly renderer: WebGPURenderer;
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly globe: Globe;
  readonly indoor: IndoorManager;
  readonly localScene: LocalScene;
  readonly backdrop: IndoorBackdrop;
  readonly stars: StarField;
  readonly sunLight: DirectionalLight;
  readonly skyLight: HemisphereLight;
  readonly skyProbe: LightProbe;
  readonly shadows: SunShadows;
  readonly volumetricClouds: VolumetricClouds;
}

/**
 * Hemisphere light kept at night with `lighting` on (fades out by day): the sky alone lights
 * buildings to almost nothing then, and interiors should stay readable.
 */
const NIGHT_FILL = 0.25;

const _v = new Vector3();
const _dir = new Vector3();
const _lightPoint = new Vector3();
const _shadowOrigin = new Vector3();
const _shadowUp = new Vector3();
const _drawingBuffer = new Vector2();

export class ViewerEnvironment {
  /** Sun color and sky light at the view from the CPU atmosphere model (M3.5). */
  private readonly atmosphereLight = new AtmosphereLighting();

  /** Buildings casting sun shadows this frame (reused). */
  private readonly shadowCasters: (ShadowCaster & { matrix: Matrix4 })[] = [];

  constructor(private readonly viewer: EnvironmentHost) {}

  /**
   * The sun, the atmosphere and star uniforms (shared by the viewers on the page: written
   * before every render of this viewer), the lights of buildings and 3D Tiles, and the shadow
   * fit. The simulated date and `state.cameraCarto` are current.
   */
  update(): void {
    const u = atmosphereUniforms;
    const cam = this.viewer.camera;
    const sun = sunDirectionECEF(this.viewer.state.date, _v);
    u.lightDirection.value.copy(sun);
    const up = this.viewer.ellipsoid.geodeticNormal(cam.position, new Vector3());
    if (this.viewer.state.lighting) {
      u.sunDirection.value.copy(sun);
    } else {
      // "Studio" lighting: a virtual sun above the camera so the whole visible hemisphere glows.
      u.sunDirection.value.copy(cam.position).normalize();
    }
    u.cameraPositionKm.value.set(cam.position.x, cam.position.y, cam.position.z * Z_SCALE).multiplyScalar(0.001);
    const height = this.viewer.state.cameraCarto.height;
    u.cameraAltitudeKm.value = Math.max(height, 0) / 1000;
    u.lightingEnabled.value = this.viewer.state.lighting ? 1 : 0;
    u.uniformLighting.value = this.viewer.state.lighting ? 0 : 1;
    // A local scene on its studio background has no sky to haze the ground towards.
    u.atmosphereEnabled.value = this.viewer.state.atmosphere && !(this.viewer.localScene.backgroundAmount.value > 0.5) ? 1 : 0;
    u.groundHaze.value = this.viewer.state.lighting ? 0.7 : 0.5;

    // Stars: rotate with sidereal time, fade in when the sky is dark.
    this.viewer.stars.uniforms.siderealAngle.value = greenwichMeanSiderealTime(this.viewer.state.date);
    const space = smoothstep(30_000, 120_000, height);
    const sunAltitude = up.dot(sun);
    const night = this.viewer.state.lighting ? smoothstep(0.05, -0.2, sunAltitude) : 0;
    this.viewer.stars.uniforms.visibility.value = (this.viewer.state.atmosphere ? Math.max(space, night) : 1) * (1 - this.viewer.localScene.backgroundAmount.value);

    // Lights for 3D Tiles and buildings (globe tiles shade themselves).
    if (this.viewer.state.lighting) {
      // The sun's color and the sky light where the view is (the entered building, else the
      // ground under the camera), from the same atmosphere the globe is drawn with (M3.5).
      this.viewer.sunLight.position.copy(sun);
      const light = this.updateAtmosphereLight(sun);
      this.viewer.sunLight.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2], LinearSRGBColorSpace);
      this.viewer.sunLight.intensity = light.sunIntensity;
      this.viewer.skyProbe.intensity = 1;
      // A little fill at night so interiors stay readable (the sky alone gives next to nothing).
      this.viewer.skyLight.intensity = NIGHT_FILL * (1 - smoothstep(-0.15, 0.2, sunAltitude));
    } else {
      // Head light from above and behind the viewer.
      cameraDirection(cam.quaternion, _dir);
      this.viewer.sunLight.position.copy(up).addScaledVector(_dir, -0.7).normalize();
      this.viewer.sunLight.color.setRGB(1, 1, 1);
      this.viewer.sunLight.intensity = 2.4;
      this.viewer.skyLight.intensity = 1.2;
      this.viewer.skyProbe.intensity = 0;
    }
    this.viewer.sunLight.target.position.set(0, 0, 0);
    this.viewer.sunLight.updateMatrixWorld();
    this.viewer.sunLight.target.updateMatrixWorld();
    this.viewer.skyLight.position.copy(up);
    this.viewer.skyLight.updateMatrixWorld();
    this.updateShadows(sun);
  }

  /** Visibility, wind and light of the volumetric clouds for this frame (cameraCarto and the environment are current). */
  updateVolumetricClouds(dt: number): void {
    const size = this.viewer.renderer.getDrawingBufferSize(_drawingBuffer);
    const light = this.viewer.state.lighting ? this.atmosphereLight.current : null;
    this.viewer.volumetricClouds.update({
      dt,
      camera: this.viewer.camera,
      cameraHeight: this.viewer.state.cameraCarto.height,
      lighting: this.viewer.state.lighting,
      sun: atmosphereUniforms.lightDirection.value as Vector3,
      sunColor: light?.sunColor ?? null,
      sh: light?.sh ?? null,
      // No sky to draw clouds against: a local scene, or a building on the studio backdrop.
      suppressed: this.viewer.localScene.engaged || (this.viewer.backdrop.amount.value as number) > 0.5,
      width: size.x,
      height: size.y,
    });
  }

  /**
   * Fits the sun shadow map to the buildings in view (M3.9) and writes this viewer's shadow
   * uniforms (shared by the viewers on the page). The map itself is drawn just before the scene.
   */
  private updateShadows(sun: Vector3): void {
    const casters = this.shadowCasters;
    const entered = enteredBuilding(this.viewer.indoor);
    let focus: Building | null = entered;
    let nearest = Infinity;
    let n = 0;
    for (const b of this.viewer.indoor.buildings) {
      if (!b.root.visible || !b.visible) continue;
      const c = casters[n] ?? (casters[n] = { matrix: new Matrix4(), min: new Vector3(), max: new Vector3() });
      c.matrix.copy(b.root.matrixWorld);
      b.shadowBounds(c.min, c.max);
      n++;
      // The light frame hangs on the entered building, else on the nearest one (texels are snapped to it).
      if (!entered) {
        const d = _lightPoint.setFromMatrixPosition(c.matrix).distanceToSquared(this.viewer.camera.position);
        if (d < nearest) {
          nearest = d;
          focus = b;
        }
      }
    }
    casters.length = n;
    const origin = focus ? _shadowOrigin.setFromMatrixPosition(focus.root.matrixWorld) : _shadowOrigin.set(0, 0, 0);
    const cam = this.viewer.camera;
    const tanY = Math.tan((cam.fov * DEG2RAD) / 2) / cam.zoom;
    this.viewer.shadows.update({
      sun,
      lighting: this.viewer.state.lighting,
      casters,
      origin,
      up: this.viewer.ellipsoid.geodeticNormal(origin, _shadowUp),
      view: { matrixWorld: cam.matrixWorld, tanX: tanY * cam.aspect, tanY, near: cam.near },
    });
    this.viewer.shadows.bind();
  }

  /**
   * Sun color and sky light (SH) at the point the view is about (the entered building, else
   * the ground under the camera), recomputed when the sun or the point moved noticeably; the
   * SH goes into the light probe when it changed.
   */
  private updateAtmosphereLight(sun: Vector3): AtmosphereLight {
    const building = enteredBuilding(this.viewer.indoor);
    const c = this.viewer.state.cameraCarto;
    let p: Vector3;
    if (building) {
      p = building.group.getWorldPosition(_lightPoint);
    } else {
      const ground = this.viewer.state.showGlobe ? (this.viewer.globe.getHeight(c.longitude, c.latitude) ?? 0) : this.viewer.state.viewGround;
      p = this.viewer.ellipsoid.cartographicToCartesian(c.longitude, c.latitude, Math.max(ground, 0), _lightPoint);
    }
    if (this.atmosphereLight.update([p.x, p.y, p.z], [sun.x, sun.y, sun.z])) {
      this.atmosphereLight.current!.sh.forEach((rgb, i) => this.viewer.skyProbe.sh.coefficients[i].set(rgb[0], rgb[1], rgb[2]));
    }
    return this.atmosphereLight.current!;
  }
}
