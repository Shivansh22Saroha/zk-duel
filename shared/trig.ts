import { ANGLE_UNITS, TRIG_SCALE } from './constants';
import { normAngle } from './sim';

/**
 * Integer sin/cos tables, scaled by TRIG_SCALE, indexed by angle in tenths of a degree.
 *
 * Angle convention (screen space, y grows downward): angle 0 points to +x, angle 900 points
 * to +y (down the screen), so increasing angle turns clockwise on screen.
 *
 * Built once with Math.sin/Math.cos and rounded. trig.test.ts asserts that no entry lies
 * within 1e-6 of a .5 rounding boundary, so every JS engine produces identical integers.
 */
function build(fn: (r: number) => number): Int16Array {
  const t = new Int16Array(ANGLE_UNITS);
  for (let a = 0; a < ANGLE_UNITS; a++) {
    t[a] = Math.round(fn((a * 2 * Math.PI) / ANGLE_UNITS) * TRIG_SCALE);
  }
  return t;
}

export const SIN_TABLE: Int16Array = build(Math.sin);
export const COS_TABLE: Int16Array = build(Math.cos);

export function isin(angle: number): number {
  return SIN_TABLE[normAngle(angle)] as number;
}

export function icos(angle: number): number {
  return COS_TABLE[normAngle(angle)] as number;
}
