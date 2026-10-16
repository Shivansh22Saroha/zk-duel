/** BotInput (integration tests, `npm run bots`, `?bot=` automation): seeded, legal, on target. */
import { describe, expect, it } from 'vitest';
import { ANGLE_UNITS, type PlayerIndex } from '@zkduel/shared/constants';
import {
  checkSequence,
  spawnSnapshot,
  spawnState,
  stepPlayer,
  toRecord,
  turnDelta,
  type PlayerState,
  type TickRecord,
} from '@zkduel/shared/sim';
import type { TickInput } from '@zkduel/shared/sim';
import { BotInput } from './bot';

const TICKS = 600;

/** Drives `bot` as player 0 through the real sim against a stationary opponent at its spawn. */
function play(bot: BotInput, p: PlayerIndex = 0) {
  const opponent = spawnSnapshot(p === 0 ? 1 : 0);
  let state: PlayerState = spawnState(p);
  const inputs: TickInput[] = [];
  const records: TickRecord[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    const input = bot.sample({ tick, playerIndex: p, self: state, opponent });
    inputs.push(input);
    const r = stepPlayer(state, input);
    state = r.state;
    records.push(toRecord(tick, state, r.reloadPress));
  }
  return { inputs, records };
}

describe('BotInput', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = play(new BotInput(7)).inputs;
    expect(play(new BotInput(7)).inputs).toEqual(a);
    expect(play(new BotInput(8)).inputs).not.toEqual(a);
  });

  it('its inputs always give a legal tick sequence through shared/sim (grid + first-person)', () => {
    for (const fp of [false, true]) {
      for (const seed of [1, 2, 3]) {
        const { records } = play(new BotInput(seed, 120, 0, fp));
        expect(checkSequence(spawnState(0), records)).toBeNull();
      }
    }
  });

  it('aims inside [0, ANGLE_UNITS), fires only when roughly on target, and fires at all', () => {
    const { inputs, records } = play(new BotInput(5, 0));
    for (const i of inputs) {
      expect(Number.isInteger(i.aimTarget)).toBe(true);
      expect(i.aimTarget).toBeGreaterThanOrEqual(0);
      expect(i.aimTarget).toBeLessThan(ANGLE_UNITS);
    }
    expect(records.some((r) => r.fired === 1)).toBe(true);
  });

  it('missBy keeps the aim error at least that large (the bot fires but never hits)', () => {
    const missBy = 300;
    const opponent = spawnSnapshot(1);
    const bot = new BotInput(9, 400, missBy);
    let state = spawnState(0);
    for (let tick = 0; tick < TICKS; tick++) {
      const input = bot.sample({ tick, playerIndex: 0, self: state, opponent });
      const dx = opponent.x - state.pub.x;
      const dy = opponent.y - state.pub.y;
      const ideal = Math.round((Math.atan2(dy, dx) * ANGLE_UNITS) / (2 * Math.PI));
      const norm = ((ideal % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
      expect(turnDelta(norm, input.aimTarget)).toBeGreaterThanOrEqual(missBy);
      state = stepPlayer(state, input).state;
    }
  });
});
