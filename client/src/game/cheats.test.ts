/** Each rule-breaking cheat yields records the circuit mirror rejects; smooth-aim stays legal. */
import { describe, expect, it } from 'vitest';
import type { CheatName } from '@zkduel/shared/protocol';
import {
  checkSequence,
  spawnState,
  stepPlayer,
  toRecord,
  type PlayerState,
  type TickInput,
  type TickRecord,
  type Violation,
} from '@zkduel/shared/sim';
import { Cheats } from './cheats';

/** 60 ticks of P0 moving right, aiming away from the opponent, holding fire. */
function play(cheat: CheatName | null): { recs: TickRecord[]; violation: Violation[] | null } {
  const c = new Cheats(0);
  if (cheat) c.set(cheat, true);
  const opponent = { x: 850, y: 100, angle: 1800, fired: 0 };
  let s: PlayerState = spawnState(0);
  const recs: TickRecord[] = [];
  for (let t = 0; t < 60; t++) {
    const input: TickInput = { moveX: 1, moveY: 0, aimTarget: 1800, fire: true, reload: false };
    const r = stepPlayer(s, input);
    const next = c.apply({ roundNo: 1, tick: t, opponent }, r.state, s, input);
    recs.push(toRecord(t, next, r.reloadPress));
    s = next;
  }
  const bad = checkSequence(spawnState(0), recs);
  return { recs, violation: bad ? bad.violations : null };
}

describe('dev cheats', () => {
  it('honest baseline is legal', () => {
    expect(play(null).violation).toBeNull();
  });
  it.each([
    ['speedhack', 'speed_x'],
    ['rapid_fire', 'fire_illegal'],
    ['infinite_ammo', 'weapon_transition'],
    ['snap_aim', 'turn'],
  ] as [CheatName, Violation][])('%s breaks a rule (%s)', (cheat, v) => {
    expect(play(cheat).violation).toContain(v);
  });
  it('smooth-aim turns toward the opponent but stays within MAX_TURN → legal', () => {
    const r = play('smooth_aim');
    expect(r.violation).toBeNull();
    expect(r.recs.at(-1)?.angle).not.toBe(play(null).recs.at(-1)?.angle);
  });
});
