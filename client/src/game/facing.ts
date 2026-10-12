/** First-person movement math (pure; shared by KeyboardMouseInput and BotInput, no DOM). */
import { MAX_SPEED, TRIG_SCALE } from '@zkduel/shared/constants';
import { icos, isin } from '@zkduel/shared/trig';

/**
 * Facing-relative step for first-person: `forward` and `right` in {−1, 0, 1} rotated by the aim
 * yaw with the integer sin/cos table. Forward = (cos a, sin a); right = 90° clockwise on the
 * 2D screen = (−sin a, cos a). Each axis is rounded and clamped to ±MAX_SPEED, so the step is
 * always legal (the checker and circuit bound each axis by MAX_SPEED).
 */
export function relativeStep(
  forward: number,
  right: number,
  angle: number,
): { dx: number; dy: number } {
  const c = icos(angle);
  const s = isin(angle);
  const axis = (v: number) =>
    Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Math.round((MAX_SPEED * v) / TRIG_SCALE) || 0));
  return { dx: axis(forward * c - right * s), dy: axis(forward * s + right * c) };
}
