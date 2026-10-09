/**
 * Window(N=4): real Phase 1 logs, the TESTING §3 table on the composed circuit, JS-reference
 * equality, and property tests proving circuit ⇔ shared/sim.ts agreement.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
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
import { mulberry32, randInt } from '@zkduel/shared/rng';
import {
  checkSequence,
  weaponRow,
  stepPlayer,
  toRecord,
  type Hidden,
  type PlayerState,
  type TickInput,
  type TickRecord,
} from '@zkduel/shared/sim';
import {
  buildWindowInput,
  initialCommitOf,
  sliceLogWindows,
  testSalt,
  type Tuple4,
  type WindowContext,
} from '@zkduel/shared/zkInput';
import { CIRCUITS_DIR, fixtureLogs, satisfiable, signalIndex, windowCircuit } from './helpers';

const N = 4;
const MUTATION_RUNS = 1000;
const REPORT_DIR = join(CIRCUITS_DIR, '..', 'server', 'data', 'test-reports');
let c: WasmTester;
beforeAll(async () => {
  c = await windowCircuit(N);
}, 300_000);

const baseCtx = (s: PlayerState): WindowContext => ({
  matchField: '4242424242',
  playerIndex: 1,
  roundNo: 2,
  windowIndex: 3,
  prev: [s.pub.x, s.pub.y, s.pub.angle, s.pub.fired],
  hiddenIn: { ...s.hidden },
  saltIn: '9876543210',
  saltOut: '1234567890123',
});

/** Simulate N honest ticks from `start` with the given inputs. */
function simulate(start: PlayerState, inputs: TickInput[]): TickRecord[] {
  let s = start;
  return inputs.map((inp, t) => {
    const r = stepPlayer(s, inp);
    s = r.state;
    return toRecord(t, r.state, r.reloadPress);
  });
}

/** Satisfiable with digest/commitments recomputed from (possibly mutated) data: only the rules can fail. */
async function rulesHold(ctx: WindowContext, recs: TickRecord[]): Promise<boolean> {
  const { input } = await buildWindowInput(ctx, recs);
  return satisfiable(c, input);
}

const idle: TickInput = { moveX: 0, moveY: 0, aimTarget: 0, fire: false, reload: false };
const start = (
  pub: Partial<PlayerState['pub']> = {},
  hidden: Partial<Hidden> = {},
): PlayerState => ({
  pub: { x: 500, y: 300, angle: 0, fired: 0, ...pub },
  hidden: { ammo: MAG_SIZE, cooldown: 0, reloadTimer: 0, ...hidden },
});
const hold = (s: PlayerState, extra: Partial<TickInput> = {}): TickInput[] =>
  Array.from({ length: N }, () => ({ ...idle, aimTarget: s.pub.angle, ...extra }));

describe('real Phase 1 match logs, N=4', () => {
  it('every window of every fixture log satisfies the circuit and outputs equal the JS reference', async () => {
    const commit0 = await initialCommitOf();
    let windows = 0;
    for (const log of fixtureLogs()) {
      const rs = log.lines.find((l) => l.type === 'round_start');
      expect(rs && rs.type === 'round_start' && rs.initialCommit).toBe(commit0);
      for (const w of sliceLogWindows(log.lines, N, testSalt(7))) {
        const { input, expected } = await buildWindowInput(w.ctx, w.records);
        if (w.ctx.windowIndex === 0) expect(expected.commitIn).toBe(commit0);
        const wit = await c.calculateWitness(input, true);
        await c.checkConstraints(wit);
        await c.assertOut(wit, { commitOut: expected.commitOut });
        windows++;
      }
    }
    expect(windows).toBeGreaterThan(300);
  }, 300_000);
});

describe('TESTING §3 on the composed circuit', () => {
  it('honest window passes; public signals must equal the JS values', async () => {
    const s = start();
    const recs = simulate(s, hold(s, { moveX: 1, fire: true }));
    const { input, expected } = await buildWindowInput(baseCtx(s), recs);
    const wit = await c.calculateWitness(input, true);
    await c.assertOut(wit, { commitOut: expected.commitOut });
    expect(await satisfiable(c, { ...input, digest: '1' })).toBe(false);
    expect(await satisfiable(c, { ...input, bind: '1' })).toBe(false);
    expect(await satisfiable(c, { ...input, commitIn: '1' })).toBe(false);
  });

  it('Δx = MAX_SPEED+1 and Δx = −(MAX_SPEED+1) fail (field wrap)', async () => {
    const s = start();
    const recs = simulate(s, hold(s));
    for (const d of [MAX_SPEED + 1, -(MAX_SPEED + 1)]) {
      const bad = recs.map((r) => ({ ...r, x: r.x + d })); // tick 0 jumps d, then stays
      expect(await rulesHold(baseCtx(s), bad), `Δx=${d}`).toBe(false);
    }
    const okRecs = recs.map((r) => ({ ...r, x: r.x - MAX_SPEED }));
    expect(await rulesHold(baseCtx(s), okRecs)).toBe(true);
  });

  it('x = R − 1 and x = W − R + 1 fail', async () => {
    const lo = start({ x: R });
    const hi = start({ x: ARENA_W - R, y: ARENA_H - R });
    expect(
      await rulesHold(
        baseCtx(lo),
        simulate(lo, hold(lo)).map((r) => ({ ...r, x: R - 1 })),
      ),
    ).toBe(false);
    expect(
      await rulesHold(
        baseCtx(hi),
        simulate(hi, hold(hi)).map((r) => ({ ...r, x: ARENA_W - R + 1 })),
      ),
    ).toBe(false);
    expect(
      await rulesHold(
        baseCtx(hi),
        simulate(hi, hold(hi)).map((r) => ({ ...r, y: ARENA_H - R + 1 })),
      ),
    ).toBe(false);
  });

  it('turn across 3599→0: exactly MAX_TURN passes both ways, MAX_TURN+1 fails both ways', async () => {
    for (const [from, delta, ok] of [
      [3590, MAX_TURN, true],
      [10, -MAX_TURN, true],
      [3590, MAX_TURN + 1, false],
      [10, -(MAX_TURN + 1), false],
    ] as const) {
      const s = start({ angle: from });
      const recs = simulate(s, hold(s)).map((r, i) =>
        i === 0
          ? { ...r, angle: (from + delta + ANGLE_UNITS) % ANGLE_UNITS }
          : { ...r, angle: (from + delta + ANGLE_UNITS) % ANGLE_UNITS },
      );
      expect(await rulesHold(baseCtx(s), recs), `${from}${delta >= 0 ? '+' : ''}${delta}`).toBe(ok);
    }
  });

  it('a malicious helper witness (k) inside Window fails', async () => {
    const s = start({ angle: 3590 });
    const recs = simulate(s, hold(s, { aimTarget: 50 })); // wraps across 0 on tick 0
    const { input } = await buildWindowInput(baseCtx(s), recs);
    const wit = await c.calculateWitness(input, true);
    const k = await signalIndex(c, 'main.turn[0].k');
    expect(wit[k]).toBe(1n);
    const bad = [...wit];
    bad[k] = 0n;
    await expect(c.checkConstraints(bad)).rejects.toThrow();
  });

  it('fire with ammo 0 / cooldown 1 / while reloading fails', async () => {
    for (const hidden of [{ ammo: 0 }, { cooldown: 1 }, { reloadTimer: 30, ammo: 3 }]) {
      const s = start({}, hidden);
      const recs = simulate(s, hold(s)).map((r, i) =>
        i === 0
          ? {
              ...r,
              fired: 1,
              ammo: Math.max(0, s.hidden.ammo - 1),
              cooldown: FIRE_COOLDOWN - 1,
              reloadTimer: 0,
            }
          : r,
      );
      expect(await rulesHold(baseCtx(s), recs), JSON.stringify(hidden)).toBe(false);
    }
  });

  it('ammo not decremented after fire fails (infinite ammo)', async () => {
    const s = start();
    const recs = simulate(s, hold(s, { fire: true }));
    expect(recs[0]?.fired).toBe(1);
    const cheat = recs.map((r) => ({ ...r, ammo: MAG_SIZE }));
    expect(await rulesHold(baseCtx(s), cheat)).toBe(false);
  });

  it('reload completes → ammo = MAG passes; any other ammo fails', async () => {
    const s = start({}, { ammo: 2, reloadTimer: 2 });
    const recs = simulate(s, hold(s)); // completes on tick 1
    expect(recs[1]?.ammo).toBe(MAG_SIZE);
    expect(await rulesHold(baseCtx(s), recs)).toBe(true);
    for (const a of [2, MAG_SIZE - 1, MAG_SIZE + 1]) {
      expect(
        await rulesHold(
          baseCtx(s),
          recs.map((r, i) => (i >= 1 ? { ...r, ammo: a } : r)),
        ),
      ).toBe(false);
    }
  });

  it('rapid fire (cooldown ignored) fails', async () => {
    const s = start();
    const recs = simulate(s, hold(s, { fire: true })); // shot on tick 0 only (cooldown)
    const rapid = recs.map((r, i) =>
      i === 1
        ? { ...r, fired: 1, ammo: r.ammo - 1, cooldown: FIRE_COOLDOWN - 1 }
        : i > 1
          ? { ...r, ammo: r.ammo - 1 }
          : r,
    );
    expect(await rulesHold(baseCtx(s), rapid)).toBe(false);
  });

  it('fired = 2 / reloadPress = 2 fail', async () => {
    const s = start();
    const recs = simulate(s, hold(s));
    expect(
      await rulesHold(
        baseCtx(s),
        recs.map((r, i) => (i === 2 ? { ...r, fired: 2 } : r)),
      ),
    ).toBe(false);
    expect(
      await rulesHold(
        baseCtx(s),
        recs.map((r, i) => (i === 2 ? { ...r, reloadPress: 2 } : r)),
      ),
    ).toBe(false);
  });

  it('commitIn for a different hidden state fails (ammo reset attack)', async () => {
    const s = start({}, { ammo: 3 });
    const recs = simulate(s, hold(s));
    const { input } = await buildWindowInput(baseCtx(s), recs);
    // claim the window started with a full magazine while commitIn commits to ammo 3
    const fake = await buildWindowInput(
      { ...baseCtx(s), hiddenIn: { ammo: MAG_SIZE, cooldown: 0, reloadTimer: 0 } },
      recs.map((r) => ({ ...r, ammo: MAG_SIZE })),
    );
    expect(await satisfiable(c, { ...fake.input, commitIn: input.commitIn })).toBe(false);
  });

  it('altering one public snapshot changes the digest (and the old digest no longer verifies)', async () => {
    const s = start();
    const recs = simulate(s, hold(s, { moveX: 1 }));
    const a = await buildWindowInput(baseCtx(s), recs);
    const altered = recs.map((r, i) => (i === 3 ? { ...r, y: r.y + 1 } : r));
    const b = await buildWindowInput(baseCtx(s), altered);
    expect(b.expected.digest).not.toBe(a.expected.digest);
    expect(await satisfiable(c, { ...b.input, digest: a.expected.digest })).toBe(false);
  });

  it('bind is tied to match, player, round and window', async () => {
    const s = start();
    const recs = simulate(s, hold(s));
    const a = await buildWindowInput(baseCtx(s), recs);
    for (const patch of [
      { windowIndex: 4 },
      { roundNo: 3 },
      { playerIndex: 0 as const },
      { matchField: '1' },
    ]) {
      const b = await buildWindowInput({ ...baseCtx(s), ...patch }, recs);
      expect(b.expected.bind).not.toBe(a.expected.bind);
      expect(await satisfiable(c, { ...b.input, bind: a.expected.bind })).toBe(false);
    }
  });
});

describe('property tests (fast-check, N=4)', () => {
  const arbStart = fc.record({
    x: fc.integer({ min: R, max: ARENA_W - R }),
    y: fc.integer({ min: R, max: ARENA_H - R }),
    angle: fc.integer({ min: 0, max: ANGLE_UNITS - 1 }),
    ammo: fc.integer({ min: 0, max: MAG_SIZE }),
    cooldown: fc.integer({ min: 0, max: FIRE_COOLDOWN - 1 }),
    reloadTimer: fc.constantFrom(0, 0, 0, 1, 2, 45, RELOAD_TICKS),
    seed: fc.integer(),
  });
  const legal = (a: {
    x: number;
    y: number;
    angle: number;
    ammo: number;
    cooldown: number;
    reloadTimer: number;
    seed: number;
  }) => {
    const s = start(
      { x: a.x, y: a.y, angle: a.angle },
      { ammo: a.ammo, cooldown: a.cooldown, reloadTimer: a.reloadTimer },
    );
    const rng = mulberry32(a.seed);
    const inputs = Array.from({ length: N }, () => ({
      moveX: randInt(rng, -1, 1),
      moveY: randInt(rng, -1, 1),
      aimTarget: randInt(rng, 0, ANGLE_UNITS - 1),
      fire: rng() < 0.6,
      reload: rng() < 0.3,
    }));
    return { s, recs: simulate(s, inputs) };
  };

  it('random legal sequences are always satisfiable and commitOut matches JS', async () => {
    await fc.assert(
      fc.asyncProperty(arbStart, async (a) => {
        const { s, recs } = legal(a);
        const { input, expected } = await buildWindowInput(baseCtx(s), recs);
        const wit = await c.calculateWitness(input, true);
        await c.assertOut(wit, { commitOut: expected.commitOut });
        return true;
      }),
      { numRuns: 150 },
    );
  }, 300_000);

  const FIELDS = [
    'x',
    'y',
    'angle',
    'fired',
    'reloadPress',
    'ammo',
    'cooldown',
    'reloadTimer',
  ] as const;
  it('one random mutation: circuit satisfiable ⇔ shared/sim.ts checkSequence accepts it; otherwise digest/commitment changes', async () => {
    let rejected = 0;
    let accepted = 0;
    let ignoredPresses = 0;
    await fc.assert(
      fc.asyncProperty(
        arbStart,
        fc.integer({ min: 0, max: N - 1 }),
        fc.constantFrom(...FIELDS),
        fc.integer({ min: -200, max: 200 }).filter((d) => d !== 0),
        async (a, tick, field, delta) => {
          const { s, recs } = legal(a);
          const mutated = recs.map((r, i) =>
            i === tick ? { ...r, [field]: r[field] + delta } : r,
          );
          const simOk = checkSequence(s, mutated) === null;
          const circuitOk = await rulesHold(baseCtx(s), mutated);
          if (circuitOk !== simOk) return false; // circuit and sim must agree exactly
          if (circuitOk) {
            accepted++;
            const before = await buildWindowInput(baseCtx(s), recs);
            const after = await buildWindowInput(baseCtx(s), mutated);
            // A still-legal mutation is visible (digest or commitment changes) — with ONE exception:
            // a reload press the rules ignore (W1 fire wins, W2/W3 reload running, W5 full mag)
            // changes no state at all, so it is an equivalent witness, not a cheat.
            const visible =
              before.expected.digest !== after.expected.digest ||
              before.expected.commitOut !== after.expected.commitOut;
            if (visible) return true;
            const prevHidden = tick === 0 ? s.hidden : (recs[tick - 1] as TickRecord);
            const r = recs[tick] as TickRecord;
            const ignoredPress =
              field === 'reloadPress' &&
              weaponRow(
                {
                  ammo: prevHidden.ammo,
                  cooldown: prevHidden.cooldown,
                  reloadTimer: prevHidden.reloadTimer,
                },
                r.fired,
                1,
              ) !== 'W4';
            if (ignoredPress) ignoredPresses++;
            return ignoredPress;
          }
          rejected++;
          return true;
        },
      ),
      { numRuns: MUTATION_RUNS },
    );
    expect(rejected).toBeGreaterThan(50);
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, 'phase2-mutation-property.txt'),
      `${new Date().toISOString()} N=${N}, ${MUTATION_RUNS} runs: ${rejected} rejected by both circuit and sim; ` +
        `${accepted} accepted by both (${accepted - ignoredPresses} changed digest/commitment, ` +
        `${ignoredPresses} were reload presses the rules ignore — no state change); 0 disagreements\n`,
    );
  }, 600_000);
});

describe('tuples', () => {
  it('prev is the spawn for window 0 of each round', () => {
    for (const log of fixtureLogs()) {
      const ws = sliceLogWindows(log.lines, N, testSalt(1));
      for (const w of ws.filter((x) => x.ctx.windowIndex === 0)) {
        const sp: Tuple4 = w.ctx.playerIndex === 0 ? [150, 300, 0, 0] : [850, 300, 1800, 0];
        expect(w.ctx.prev).toEqual(sp);
        expect(w.ctx.saltIn).toBe('0');
      }
    }
  });
});
