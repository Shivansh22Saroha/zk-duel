/**
 * Each template on its own (TESTING §3): every constraint family has positive and negative
 * tests, including field-wrap and malicious-helper-witness cases.
 */
import type { WasmTester } from 'circom_tester';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANGLE_UNITS,
  ARENA_H,
  ARENA_W,
  FIRE_COOLDOWN,
  MAG_SIZE,
  MAX_SPEED,
  MAX_TURN,
  PLAYER_RADIUS as R,
  RELOAD_TICKS,
} from '@zkduel/shared/constants';
import { BN254_P } from '@zkduel/shared/field';
import { canFire, stepWeapon, type Hidden } from '@zkduel/shared/sim';
import { bindOf, commitOf, digestOf, toField } from '@zkduel/shared/zkInput';
import { satisfiable, signalIndex, template } from './helpers';

const neg = (v: number): string => toField(v); // negative ints as field elements (p − |v|)

describe('SpeedCheck', () => {
  let c: WasmTester;
  beforeAll(async () => {
    c = await template('speed.circom', 'SpeedCheck', [MAX_SPEED]);
  });
  it('every step in [−MAX_SPEED, +MAX_SPEED] passes', async () => {
    for (let d = -MAX_SPEED; d <= MAX_SPEED; d++) {
      expect(await satisfiable(c, { prev: 500, cur: 500 + d }), `Δ=${d}`).toBe(true);
    }
  });
  it('Δ = +(MAX_SPEED+1) fails', async () => {
    expect(await satisfiable(c, { prev: 500, cur: 500 + MAX_SPEED + 1 })).toBe(false);
  });
  it('Δ = −(MAX_SPEED+1) fails (field-wrap check)', async () => {
    expect(await satisfiable(c, { prev: 500, cur: 500 - MAX_SPEED - 1 })).toBe(false);
    expect(await satisfiable(c, { prev: 0, cur: neg(-1) })).toBe(true); // Δ = −1 via wrap is still −1
    expect(await satisfiable(c, { prev: 0, cur: neg(-(MAX_SPEED + 1)) })).toBe(false);
    expect(await satisfiable(c, { prev: 0, cur: (BN254_P / 2n).toString() })).toBe(false);
  });
});

describe('BoundsCheck', () => {
  let c: WasmTester;
  const ok = { x: 500, y: 300, angle: 0, fired: 0, reloadPress: 0 };
  beforeAll(async () => {
    c = await template('bounds.circom', 'BoundsCheck', [ARENA_W, ARENA_H, R, ANGLE_UNITS]);
  });
  it('edges pass', async () => {
    for (const p of [
      { x: R },
      { x: ARENA_W - R },
      { y: R },
      { y: ARENA_H - R },
      { angle: ANGLE_UNITS - 1 },
      { fired: 1, reloadPress: 1 },
    ]) {
      expect(await satisfiable(c, { ...ok, ...p }), JSON.stringify(p)).toBe(true);
    }
  });
  it('x = R − 1, x = W − R + 1, y out of range, negative x fail', async () => {
    for (const p of [
      { x: R - 1 },
      { x: ARENA_W - R + 1 },
      { y: R - 1 },
      { y: ARENA_H - R + 1 },
      { x: neg(-1) },
      { x: 5000 },
    ]) {
      expect(await satisfiable(c, { ...ok, ...p }), JSON.stringify(p)).toBe(false);
    }
  });
  it('angle = ANGLE_UNITS fails; fired = 2 / reloadPress = 2 fail (boolean)', async () => {
    expect(await satisfiable(c, { ...ok, angle: ANGLE_UNITS })).toBe(false);
    expect(await satisfiable(c, { ...ok, fired: 2 })).toBe(false);
    expect(await satisfiable(c, { ...ok, reloadPress: 2 })).toBe(false);
    expect(await satisfiable(c, { ...ok, fired: neg(-1) })).toBe(false);
  });
});

describe('TurnCheck', () => {
  let c: WasmTester;
  beforeAll(async () => {
    c = await template('turn.circom', 'TurnCheck', [ANGLE_UNITS, MAX_TURN]);
  });
  const wrap = (a: number) => ((a % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
  it('exactly MAX_TURN passes in both directions, across the 3599→0 boundary', async () => {
    for (const [p, q] of [
      [3590, wrap(3590 + MAX_TURN)],
      [wrap(3590 + MAX_TURN), 3590],
      [0, MAX_TURN],
      [MAX_TURN, 0],
      [10, wrap(10 - MAX_TURN)],
      [wrap(10 - MAX_TURN), 10],
      [1800, 1800],
      [3599, 0],
    ]) {
      expect(await satisfiable(c, { prev: p, cur: q }), `${p}→${q}`).toBe(true);
    }
  });
  it('MAX_TURN + 1 fails in both directions, across the boundary', async () => {
    for (const [p, q] of [
      [3590, wrap(3590 + MAX_TURN + 1)],
      [wrap(3590 + MAX_TURN + 1), 3590],
      [0, MAX_TURN + 1],
      [10, wrap(10 - MAX_TURN - 1)],
      [0, 1800],
      [100, 2000],
    ]) {
      expect(await satisfiable(c, { prev: p, cur: q }), `${p}→${q}`).toBe(false);
    }
  });
  it('a malicious prover cannot set the helper k (or turnD) inconsistently', async () => {
    const w = await c.calculateWitness({ prev: 3590, cur: 50 }, true); // honest: k = 1, turnD = 60
    await c.checkConstraints(w);
    const kIdx = await signalIndex(c, 'main.k');
    expect(w[kIdx]).toBe(1n);
    // turnD = cur − prev + ANGLES·k is linear, so --O2 substitutes it away: it is not a free
    // wire at all. k is the only prover-chosen helper; every wrong value must break a constraint.
    expect(await signalIndex(c, 'main.turnD')).toBe(-1);
    for (const v of [0n, 2n, BN254_P - 1n]) {
      const bad = [...w];
      bad[kIdx] = v;
      await expect(c.checkConstraints(bad), `k := ${v}`).rejects.toThrow();
    }
    // flipping k with every range-check bit left honest fails; and no satisfying bit pattern
    // exists for k = 0 either: turnD would be 50 − 3590 = −3540 ≡ p − 3540, not a 12-bit value.
    expect(BN254_P - 3540n >= 1n << 12n).toBe(true);
  });
});

describe('WeaponStep (table W1–W5 vs shared/sim.ts)', () => {
  let c: WasmTester;
  beforeAll(async () => {
    c = await template('weapon.circom', 'WeaponStep', [MAG_SIZE, FIRE_COOLDOWN, RELOAD_TICKS]);
  });
  const run = (h: Hidden, fired: number, reloadPress: number, next: Hidden) =>
    satisfiable(c, {
      ammo: h.ammo,
      cooldown: h.cooldown,
      reloadT: h.reloadTimer,
      fired,
      reloadPress,
      ammoNext: next.ammo,
      cooldownNext: next.cooldown,
      reloadTNext: next.reloadTimer,
    });

  it('agrees with sim on every reachable (ammo, cooldown, reloadT ∈ {0,1,2,45,90}) × fired × press', async () => {
    let checked = 0;
    for (let ammo = 0; ammo <= MAG_SIZE; ammo++) {
      for (let cd = 0; cd < FIRE_COOLDOWN; cd++) {
        for (const rt of [0, 1, 2, 45, RELOAD_TICKS]) {
          for (const fired of [0, 1]) {
            for (const press of [0, 1]) {
              const h = { ammo, cooldown: cd, reloadTimer: rt };
              if (fired && !canFire(h)) {
                // illegal shot: no claimed next state may satisfy the circuit
                expect(
                  await run(h, 1, press, {
                    ammo: ammo - 1,
                    cooldown: FIRE_COOLDOWN - 1,
                    reloadTimer: 0,
                  }),
                ).toBe(false);
                continue;
              }
              const next = stepWeapon(h, fired, press);
              expect(await run(h, fired, press, next), JSON.stringify({ h, fired, press })).toBe(
                true,
              );
              expect(await run(h, fired, press, { ...next, ammo: next.ammo + 1 })).toBe(false);
              expect(await run(h, fired, press, { ...next, cooldown: next.cooldown + 1 })).toBe(
                false,
              );
              expect(
                await run(h, fired, press, { ...next, reloadTimer: next.reloadTimer + 1 }),
              ).toBe(false);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  }, 120_000);

  const H = (ammo: number, cooldown: number, reloadTimer: number): Hidden => ({
    ammo,
    cooldown,
    reloadTimer,
  });
  it('fire on the last round of ammo → ammo 0, cooldown COOLDOWN−1', async () => {
    expect(await run(H(1, 0, 0), 1, 0, H(0, FIRE_COOLDOWN - 1, 0))).toBe(true);
  });
  it('auto-reload at 0 ammo (press) starts a reload', async () => {
    expect(await run(H(0, 5, 0), 0, 1, H(0, 4, RELOAD_TICKS))).toBe(true);
    expect(await run(H(0, 5, 0), 0, 1, H(0, 4, 0))).toBe(false);
  });
  it('fire attempt on the tick a reload completes is illegal; the completion itself is W3', async () => {
    expect(await run(H(3, 0, 1), 1, 0, H(2, FIRE_COOLDOWN - 1, 0))).toBe(false);
    expect(await run(H(3, 0, 1), 1, 0, H(MAG_SIZE, 0, 0))).toBe(false);
    expect(await run(H(3, 0, 1), 0, 0, H(MAG_SIZE, 0, 0))).toBe(true);
  });
  it('fire with ammo 0 / cooldown 1 / during reload fails', async () => {
    expect(await run(H(0, 0, 0), 1, 0, H(0, FIRE_COOLDOWN - 1, 0))).toBe(false);
    expect(await run(H(0, 0, 0), 1, 0, H(neg(-1) as unknown as number, FIRE_COOLDOWN - 1, 0))).toBe(
      false,
    );
    expect(await run(H(5, 1, 0), 1, 0, H(4, FIRE_COOLDOWN - 1, 0))).toBe(false);
    expect(await run(H(5, 0, 30), 1, 0, H(4, FIRE_COOLDOWN - 1, 0))).toBe(false);
  });
  it('ammo not decremented after fire fails; reload completing to anything but MAG fails', async () => {
    expect(await run(H(5, 0, 0), 1, 0, H(5, FIRE_COOLDOWN - 1, 0))).toBe(false);
    for (let a = 0; a < MAG_SIZE; a++) expect(await run(H(2, 0, 1), 0, 0, H(a, 0, 0))).toBe(false);
  });
  it('fire wins over a same-tick reload press; presses during a reload are ignored', async () => {
    expect(await run(H(5, 0, 0), 1, 1, H(4, FIRE_COOLDOWN - 1, 0))).toBe(true);
    expect(await run(H(5, 0, 0), 1, 1, H(4, FIRE_COOLDOWN - 1, RELOAD_TICKS))).toBe(false);
    expect(await run(H(5, 0, 40), 0, 1, H(5, 0, 39))).toBe(true);
    expect(await run(H(5, 0, 40), 0, 1, H(5, 0, RELOAD_TICKS))).toBe(false);
  });
});

describe('Poseidon templates match the JS reference', () => {
  it('Bind', async () => {
    const c = await template('bind.circom', 'Bind');
    const w = await c.calculateWitness(
      { matchField: '123456789', playerIndex: 1, roundNo: 2, windowIndex: 7 },
      true,
    );
    await c.assertOut(w, { out: await bindOf('123456789', 1, 2, 7) });
  });
  it('Commit', async () => {
    const c = await template('commit.circom', 'Commit');
    const salt = (2n ** 247n + 12345n).toString();
    const w = await c.calculateWitness({ ammo: 7, cooldown: 3, reloadT: 0, salt }, true);
    await c.assertOut(w, { out: await commitOf({ ammo: 7, cooldown: 3, reloadTimer: 0 }, salt) });
  });
  it('DigestChain(4)', async () => {
    const c = await template('digest.circom', 'DigestChain', [4]);
    const snaps = [
      { x: 154, y: 304, angle: 0, fired: 0 },
      { x: 158, y: 308, angle: 150, fired: 1 },
      { x: 162, y: 312, angle: 300, fired: 0 },
      { x: 162, y: 312, angle: 300, fired: 0 },
    ];
    const prev: [number, number, number, number] = [150, 300, 0, 0];
    const w = await c.calculateWitness(
      {
        prev,
        x: snaps.map((s) => s.x),
        y: snaps.map((s) => s.y),
        angle: snaps.map((s) => s.angle),
        fired: snaps.map((s) => s.fired),
      },
      true,
    );
    const expected = await digestOf(prev, snaps);
    await c.assertOut(w, { digest: expected });
    // one altered public snapshot → a different digest
    const altered = snaps.map((s, i) => (i === 2 ? { ...s, x: s.x + 1 } : s));
    expect(await digestOf(prev, altered)).not.toBe(expected);
  });
});
