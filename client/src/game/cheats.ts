/**
 * Dev cheat module (FEATURES F13, PRD FR-19/FR-20). Only reachable from builds with
 * VITE_DEV_CHEATS=true (the browser loads it with a dynamic import behind that compile-time flag)
 * and accepted by the server only with DEV_CHEATS=true. DOM-free: the Node bots of the detection
 * experiment use the same code.
 *
 * Cheats rewrite the player's REAL state after the honest tick (the honest clamps are bypassed),
 * so what is recorded, sent and committed is the cheating state and the prover runs honestly over
 * it: a cheated window has no witness (proof_failed → unprovable) — except smooth-aim, which stays
 * within MAX_TURN and therefore proves (the input-provenance limitation, SECURITY A10).
 */
import { ANGLE_UNITS, FIRE_COOLDOWN, type PlayerIndex } from '@zkduel/shared/constants';
import type { CheatName } from '@zkduel/shared/protocol';
import {
  normAngle,
  stepAim,
  X_MAX,
  X_MIN,
  Y_MAX,
  Y_MIN,
  type PlayerState,
  type PublicSnap,
  type TickInput,
} from '@zkduel/shared/sim';

export const CHEATS: readonly CheatName[] = [
  'speedhack',
  'rapid_fire',
  'infinite_ammo',
  'snap_aim',
  'smooth_aim',
];

export const CHEAT_LABELS: Record<CheatName, string> = {
  speedhack: 'Speedhack (×2 speed)',
  rapid_fire: 'Rapid-fire (no cooldown)',
  infinite_ammo: 'Infinite ammo',
  snap_aim: 'Snap-aimbot (instant turn)',
  smooth_aim: 'Smooth-aimbot (≤ MAX_TURN)',
};

export interface CheatContext {
  roundNo: number;
  tick: number;
  /** Latest server-reported opponent snapshot, if any. */
  opponent: PublicSnap | null;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Integer angle (tenths of a degree) from `a` to `b` — floats only to choose the aim. */
export function angleTo(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return normAngle(Math.round((Math.atan2(b.y - a.y, b.x - a.x) * ANGLE_UNITS) / (2 * Math.PI)));
}

export class Cheats {
  readonly active = new Set<CheatName>();
  /** Snap-aim snaps on every n-th tick (1 = every tick, as in F13). The experiment uses > 1. */
  snapEveryTicks = 1;

  constructor(readonly playerIndex: PlayerIndex) {}

  set(c: CheatName, on: boolean): void {
    if (on) this.active.add(c);
    else this.active.delete(c);
  }

  /**
   * Rewrite the honest result of one tick. `prev` = state before the tick, `honest` = state the
   * honest rules produced from `input`.
   */
  apply(ctx: CheatContext, honest: PlayerState, prev: PlayerState, input: TickInput): PlayerState {
    if (!this.active.size) return honest;
    const pub = { ...honest.pub };
    const hidden = { ...honest.hidden };
    const a = this.active;

    // aim (snap: exact angle, any turn size; smooth: toward the target at ≤ MAX_TURN — legal)
    if (ctx.opponent && (a.has('snap_aim') || a.has('smooth_aim'))) {
      const target = angleTo(prev.pub, ctx.opponent);
      if (a.has('snap_aim') && ctx.tick % this.snapEveryTicks === 0) pub.angle = target;
      else if (a.has('smooth_aim') && !a.has('snap_aim'))
        pub.angle = stepAim(prev.pub.angle, target);
    }

    // movement: twice the honest per-axis step (|Δ| = 2·MAX_SPEED), still inside the arena
    if (a.has('speedhack')) {
      pub.x = clamp(prev.pub.x + 2 * (honest.pub.x - prev.pub.x), X_MIN, X_MAX);
      pub.y = clamp(prev.pub.y + 2 * (honest.pub.y - prev.pub.y), Y_MIN, Y_MAX);
    }

    // weapon
    const h0 = prev.hidden;
    if (
      a.has('rapid_fire') &&
      input.fire &&
      honest.pub.fired === 0 &&
      h0.ammo > 0 &&
      h0.reloadTimer === 0
    ) {
      // fires although the cooldown has not elapsed
      pub.fired = 1;
      hidden.ammo = h0.ammo - 1;
      hidden.cooldown = FIRE_COOLDOWN - 1;
      hidden.reloadTimer = 0;
    }
    if (a.has('infinite_ammo') && pub.fired === 1) hidden.ammo = h0.ammo; // never decremented

    return { pub, hidden };
  }
}
