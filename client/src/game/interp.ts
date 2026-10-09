/** Render-only interpolation (floats are fine here; game state stays integer). */
import { ANGLE_UNITS } from '@zkduel/shared/constants';
import { signedTurn, type PublicSnap } from '@zkduel/shared/sim';
import type { OpponentSample } from './session';

export interface RenderPose {
  x: number;
  y: number;
  /** Angle in angle units (may be fractional). */
  angle: number;
}

export function lerpPose(
  a: PublicSnap | RenderPose,
  b: PublicSnap | RenderPose,
  t: number,
): RenderPose {
  const d = signedTurn(Math.round(a.angle), Math.round(b.angle));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: (((a.angle + d * t) % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS,
  };
}

/**
 * Opponent pose `delayMs` in the past, interpolated between buffered server samples by
 * arrival time (smooths network jitter).
 */
export function opponentPose(
  buf: readonly OpponentSample[],
  now: number,
  delayMs: number,
): RenderPose | null {
  if (!buf.length) return null;
  const t = now - delayMs;
  for (let i = buf.length - 1; i > 0; i--) {
    const b = buf[i] as OpponentSample;
    const a = buf[i - 1] as OpponentSample;
    if (a.at <= t && t <= b.at) {
      const span = b.at - a.at;
      return lerpPose(a.snap, b.snap, span > 0 ? (t - a.at) / span : 1);
    }
  }
  const first = buf[0] as OpponentSample;
  const last = buf[buf.length - 1] as OpponentSample;
  return t < first.at ? { ...first.snap } : { ...last.snap };
}
