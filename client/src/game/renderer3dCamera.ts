/**
 * Pure camera / axis math for the Three.js renderer, kept apart so it can be unit-tested in Node
 * against the Canvas 2D mapping (axisMapping.test.ts).
 *
 * World mapping: arena x → X, arena y → Z, Y is up. The 2D renderer draws arena +x to the right
 * and arena +y downwards; the overview camera looks from +Z (the arena's bottom edge) towards
 * the centre, so on screen +X is right and +Z is down — the same orientation as 2D.
 * Angle a (0 = +x, clockwise on screen in 2D) is the heading (cos a, 0, sin a).
 */
import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { ANGLE_UNITS } from '@zkduel/shared/constants';

const OVERVIEW_TILT_DEG = 58; // camera pitch below the horizon
const EYE_H = 40;

export function radiansOf(angle: number): number {
  return (angle * 2 * Math.PI) / ANGLE_UNITS;
}

/** Arena point (x, y) at height `up` in world space. */
export function worldOf(x: number, y: number, up = 0): Vector3 {
  return new Vector3(x, up, y);
}

/** Object3D yaw (rotation.y) that turns local +X onto the heading of `angle`. */
export function yawOf(angle: number): number {
  return -radiansOf(angle);
}

/** Angled top-down camera that keeps the whole arena (w × h) in view for the camera's aspect. */
export function placeOverview(cam: PerspectiveCamera, w: number, h: number): void {
  const tilt = (OVERVIEW_TILT_DEG * Math.PI) / 180;
  const vfov = (cam.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
  // distance so that both the arena width (horizontally) and depth (foreshortened) fit
  const dW = (w * 0.56) / Math.tan(hfov / 2);
  const dH = (h * 0.62 * Math.sin(tilt) + h * 0.1) / Math.tan(vfov / 2);
  const d = Math.max(dW, dH);
  const target = worldOf(w / 2, h / 2);
  cam.up.set(0, 1, 0);
  cam.position.set(target.x, d * Math.sin(tilt), target.z + d * Math.cos(tilt));
  cam.lookAt(target);
}

/** First-person camera at the own position, yaw = aim angle, no pitch. */
export function placeFirstPerson(
  cam: PerspectiveCamera,
  x: number,
  y: number,
  angle: number,
): void {
  const a = radiansOf(angle);
  cam.up.set(0, 1, 0);
  cam.position.copy(worldOf(x, y, EYE_H));
  cam.lookAt(worldOf(x + Math.cos(a) * 100, y + Math.sin(a) * 100, EYE_H));
}
