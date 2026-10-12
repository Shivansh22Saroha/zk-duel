/**
 * Scripted input for automated matches (integration tests, `npm run bots`).
 * Wanders, aims at the opponent with jitter and fires when roughly on target.
 * Uses floats only to *choose inputs*; the rules (shared/sim) keep state integer and legal.
 */
import { ANGLE_UNITS } from '@zkduel/shared/constants';
import { mulberry32, randInt } from '@zkduel/shared/rng';
import { turnDelta } from '@zkduel/shared/sim';
import { relativeStep } from './facing';
import type { InputContext, InputSource } from './session';

export class BotInput implements InputSource {
  private readonly rng: () => number;
  private moveX = 0;
  private moveY = 0;
  private nextTurnTick = 0;
  private jitter = 0;

  constructor(
    seed: number,
    private readonly accuracy = 120, // ± angle units of aim jitter (misses → longer rounds, reloads)
    /** Minimum aim error (angle units): the bot still fires (weapon rules exercised) but never hits. */
    private readonly missBy = 0,
    /** Move like a first-person player: moveX/moveY become strafe/forward relative to the aim. */
    private readonly facingRelative = false,
  ) {
    this.rng = mulberry32(seed);
  }

  sample(ctx: InputContext) {
    if (ctx.tick >= this.nextTurnTick) {
      this.moveX = randInt(this.rng, -1, 1);
      this.moveY = randInt(this.rng, -1, 1);
      this.jitter = randInt(this.rng, -this.accuracy, this.accuracy);
      if (this.missBy > 0 && Math.abs(this.jitter) < this.missBy) {
        this.jitter = this.jitter < 0 ? -this.missBy : this.missBy;
      }
      this.nextTurnTick = ctx.tick + randInt(this.rng, 15, 45);
    }
    let aimTarget = ctx.self.pub.angle;
    let fire = false;
    if (ctx.opponent) {
      const dx = ctx.opponent.x - ctx.self.pub.x;
      const dy = ctx.opponent.y - ctx.self.pub.y;
      const ideal = Math.round((Math.atan2(dy, dx) * ANGLE_UNITS) / (2 * Math.PI));
      aimTarget = (((ideal + this.jitter) % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
      fire = turnDelta(ctx.self.pub.angle, aimTarget) < 40;
    }
    if (this.facingRelative) {
      // moveY −1 = W (forward), moveX +1 = D (strafe right) — same keys as KeyboardMouseInput
      const step = relativeStep(-this.moveY, this.moveX, ctx.self.pub.angle);
      return {
        moveX: 0,
        moveY: 0,
        step,
        aimTarget,
        fire,
        reload: ctx.self.hidden.ammo < 4 && this.rng() < 0.02,
      };
    }
    return {
      moveX: this.moveX,
      moveY: this.moveY,
      aimTarget,
      fire,
      reload: ctx.self.hidden.ammo < 4 && this.rng() < 0.02,
    };
  }
}
