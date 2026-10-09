/**
 * Scripted input for automated matches (integration tests, `npm run bots`).
 * Wanders, aims at the opponent with jitter and fires when roughly on target.
 * Uses floats only to *choose inputs*; the rules (shared/sim) keep state integer and legal.
 */
import { ANGLE_UNITS } from '@zkduel/shared/constants';
import { mulberry32, randInt } from '@zkduel/shared/rng';
import { turnDelta } from '@zkduel/shared/sim';
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
  ) {
    this.rng = mulberry32(seed);
  }

  sample(ctx: InputContext) {
    if (ctx.tick >= this.nextTurnTick) {
      this.moveX = randInt(this.rng, -1, 1);
      this.moveY = randInt(this.rng, -1, 1);
      this.jitter = randInt(this.rng, -this.accuracy, this.accuracy);
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
    return {
      moveX: this.moveX,
      moveY: this.moveY,
      aimTarget,
      fire,
      reload: ctx.self.hidden.ammo < 4 && this.rng() < 0.02,
    };
  }
}
