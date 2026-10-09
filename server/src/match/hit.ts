/**
 * Server-authoritative hit detection (FEATURES F7): integer ray vs circle, using the integer
 * sin/cos table scaled by TRIG_SCALE. No floats, no projectile travel time.
 */
import { PLAYER_RADIUS, RAY_LENGTH, TRIG_SCALE } from '@zkduel/shared/constants';
import { X_MAX, X_MIN, Y_MAX, Y_MIN, normAngle, type PublicSnap } from '@zkduel/shared/sim';
import { icos, isin } from '@zkduel/shared/trig';

/**
 * Does a ray from (sx, sy) at `angle` (length RAY_LENGTH) touch the circle at (tx, ty)?
 * Tangent counts as a hit. A target behind the shooter is a miss, unless the circles
 * overlap the shooter's position (point-blank).
 */
export function rayHitsCircle(
  sx: number,
  sy: number,
  angle: number,
  tx: number,
  ty: number,
  radius: number = PLAYER_RADIUS,
  length: number = RAY_LENGTH,
): boolean {
  const dx = tx - sx;
  const dy = ty - sy;
  if (dx * dx + dy * dy <= radius * radius) return true;
  const c = icos(angle);
  const s = isin(angle);
  const proj = dx * c + dy * s; // distance along the ray × TRIG_SCALE
  if (proj < 0 || proj > length * TRIG_SCALE) return false;
  const cross = dx * s - dy * c; // perpendicular distance × TRIG_SCALE
  const r = radius * TRIG_SCALE;
  return cross * cross <= r * r;
}

/** Clamp a received snapshot into the legal arena/angle range before ray-casting (SECURITY §4). */
export function clampForHit(s: PublicSnap): PublicSnap {
  const cl = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  return {
    x: cl(s.x, X_MIN, X_MAX),
    y: cl(s.y, Y_MIN, Y_MAX),
    angle: normAngle(s.angle),
    fired: s.fired,
  };
}

/** Does `shooter`'s shot at this tick hit `target`? Only `fired === 1` is a shot. */
export function shotHits(shooter: PublicSnap, target: PublicSnap): boolean {
  if (shooter.fired !== 1) return false;
  const a = clampForHit(shooter);
  const b = clampForHit(target);
  return rayHitsCircle(a.x, a.y, a.angle, b.x, b.y);
}
