/**
 * Is "ammo < MAG" safely implemented as "ammo ≠ MAG" (WeaponStep, W4)?
 *
 * Claim: in every window whose commitIn traces back to the round's public initialCommit through
 * a chain of windows that all satisfy the circuit, every hidden state is in the set S reachable
 * from (MAG, 0, 0) — and on S, "≠" and "<" decide W4 identically, and ammo ∈ [0, MAG].
 *
 * Proof structure (each step is a test below):
 *  1. `circuitStep` transcribes WeaponStep's constraint equations literally, in F_p. The next
 *     state is fully determined by them (each of ammoNext/cooldownNext/reloadTNext appears alone
 *     on one side of an `===`), so the circuit's transition relation is a partial function.
 *  2. The transcription equals the compiled template on every (s ∈ S, fired, press): the
 *     computed successor is accepted, a perturbed one rejected, illegal shots rejected.
 *  3. S (BFS from (MAG, 0, 0) under circuitStep, all 4 inputs) is closed, finite, and inside
 *     ammo ∈ [0, MAG], cooldown ∈ [0, COOLDOWN−1], reloadT ∈ [0, RELOAD]; on S, circuitStep
 *     equals shared/sim.ts stepWeapon (which uses "<"), for every input.
 *  4. Across windows (induction): window 0 must open initialCommit = Poseidon(MAG, 0, 0, 0), so
 *     its entering state is (MAG, 0, 0) unless Poseidon is broken; window k's commitIn is window
 *     k−1's commitOut, a commitment to window k−1's last state, which is in S by 1–3.
 *  5. The hypothesis is necessary: outside S the two readings differ (ammo = MAG+1), and a window
 *     whose commitIn is merely *claimed* (not backed by proven predecessors) can start anywhere.
 *     A range check would not change the guarantee: a cheater can claim a legal-looking state
 *     (e.g. a refilled magazine) at a boundary, which only the failing boundary window reveals.
 */
import type { WasmTester } from 'circom_tester';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIRE_COOLDOWN, MAG_SIZE, RELOAD_TICKS } from '@zkduel/shared/constants';
import { BN254_P } from '@zkduel/shared/field';
import { IllegalTransitionError, INITIAL_HIDDEN, spawnState, stepWeapon } from '@zkduel/shared/sim';
import { buildWindowInput, commitOf, initialCommitOf } from '@zkduel/shared/zkInput';
import { satisfiable, template, windowCircuit } from './helpers';

const P = BN254_P;
const MAG = BigInt(MAG_SIZE);
const COOLDOWN = BigInt(FIRE_COOLDOWN);
const RELOAD = BigInt(RELOAD_TICKS);
const mod = (v: bigint): bigint => ((v % P) + P) % P;

type S = readonly [ammo: bigint, cooldown: bigint, reloadT: bigint];
const key = (s: S): string => s.join(',');

/** circuits/src/weapon.circom, equation by equation. Returns null when no successor exists. */
function circuitStep([ammo, cooldown, reloadT]: S, fired: bigint, reloadPress: bigint): S | null {
  const isZero = (v: bigint): bigint => (mod(v) === 0n ? 1n : 0n);
  const isEq = (a: bigint, b: bigint): bigint => (mod(a - b) === 0n ? 1n : 0n);
  const ammoZero = isZero(ammo);
  const cdZero = isZero(cooldown);
  const rtZero = isZero(reloadT);
  const rtOne = isEq(reloadT, 1n);
  const magFull = isEq(ammo, MAG);
  // W1 legality
  if (mod(fired * ammoZero) !== 0n) return null;
  if (mod(fired * (1n - cdZero)) !== 0n) return null;
  if (mod(fired * (1n - rtZero)) !== 0n) return null;
  const cdDec = mod(cooldown - 1n + cdZero);
  const cooldownNext = mod(cdDec + fired * (COOLDOWN - 1n - cdDec));
  const rtAbove1 = mod(1n - rtZero - rtOne);
  const pressNotFull = mod(reloadPress * (1n - magFull));
  const startReload = mod(rtZero * pressNotFull);
  const rtIfIdle = mod(rtAbove1 * (reloadT - 1n) + startReload * RELOAD);
  const reloadTNext = mod(rtIfIdle - fired * rtIfIdle);
  const ammoIfIdle = mod(rtOne * (MAG - ammo) + ammo);
  const ammoNext = mod(ammoIfIdle + fired * (ammo - 1n - ammoIfIdle));
  return [ammoNext, cooldownNext, reloadTNext];
}

const INPUTS = [
  [0n, 0n],
  [0n, 1n],
  [1n, 0n],
  [1n, 1n],
] as const;

/** BFS over the circuit's transition relation from the round's public initial state. */
function reachable(): Map<string, S> {
  const start: S = [BigInt(INITIAL_HIDDEN.ammo), BigInt(INITIAL_HIDDEN.cooldown), 0n];
  const seen = new Map<string, S>([[key(start), start]]);
  const queue: S[] = [start];
  while (queue.length) {
    const s = queue.pop() as S;
    for (const [f, p] of INPUTS) {
      const n = circuitStep(s, f, p);
      if (n && !seen.has(key(n))) {
        seen.set(key(n), n);
        queue.push(n);
      }
    }
  }
  return seen;
}

const toHidden = (s: S) => ({
  ammo: Number(s[0]),
  cooldown: Number(s[1]),
  reloadTimer: Number(s[2]),
});

describe('ammo ≠ MAG is safe on every state reachable from the public initialCommit', () => {
  const S = reachable();

  it('the reachable set is closed and bounded: ammo ∈ [0, MAG], cooldown ∈ [0, COOLDOWN−1], reloadT ∈ [0, RELOAD]', () => {
    for (const s of S.values()) {
      expect(s[0] >= 0n && s[0] <= MAG, key(s)).toBe(true);
      expect(s[1] >= 0n && s[1] <= COOLDOWN - 1n, key(s)).toBe(true);
      expect(s[2] >= 0n && s[2] <= RELOAD, key(s)).toBe(true);
      for (const [f, p] of INPUTS) {
        const n = circuitStep(s, f, p);
        if (n) expect(S.has(key(n)), `${key(s)} --${f},${p}--> ${key(n)}`).toBe(true);
      }
    }
    // every ammo level and every reload/cooldown value actually occurs (the BFS is not trivial)
    expect(new Set([...S.values()].map((s) => s[0])).size).toBe(MAG_SIZE + 1);
    expect(new Set([...S.values()].map((s) => s[2])).size).toBe(RELOAD_TICKS + 1);
    console.log(`reachable hidden states from (MAG,0,0): ${S.size}`);
  });

  it('on the reachable set, the circuit relation equals shared/sim.ts stepWeapon ("ammo < MAG") for every input', () => {
    let w4Full = 0;
    for (const s of S.values()) {
      for (const [f, p] of INPUTS) {
        const c = circuitStep(s, f, p);
        let sim: ReturnType<typeof stepWeapon> | null;
        try {
          sim = stepWeapon(toHidden(s), Number(f), Number(p));
        } catch (e) {
          if (!(e instanceof IllegalTransitionError)) throw e;
          sim = null;
        }
        expect(c ? toHidden(c) : null, `${key(s)} fired=${f} press=${p}`).toEqual(sim);
        // the only place "≠" vs "<" could matter: idle, reload press, magazine full
        if (s[0] === MAG && s[2] === 0n && f === 0n && p === 1n) w4Full++;
      }
    }
    expect(w4Full).toBeGreaterThan(0); // the full-magazine press case is reachable and agrees
  });

  describe('the literal transcription equals the compiled WeaponStep on every reachable state', () => {
    let c: WasmTester;
    beforeAll(async () => {
      c = await template('weapon.circom', 'WeaponStep', [MAG_SIZE, FIRE_COOLDOWN, RELOAD_TICKS]);
    });
    it('successor accepted, perturbed successor rejected, illegal shots rejected', async () => {
      const run = (s: S, f: bigint, p: bigint, n: S) =>
        satisfiable(c, {
          ammo: s[0].toString(),
          cooldown: s[1].toString(),
          reloadT: s[2].toString(),
          fired: f.toString(),
          reloadPress: p.toString(),
          ammoNext: n[0].toString(),
          cooldownNext: n[1].toString(),
          reloadTNext: n[2].toString(),
        });
      let checked = 0;
      for (const s of S.values()) {
        for (const [f, p] of INPUTS) {
          const n = circuitStep(s, f, p);
          if (!n) {
            // illegal shot: the W1 successor (and the idle one) must both be rejected
            expect(await run(s, f, p, [mod(s[0] - 1n), COOLDOWN - 1n, 0n])).toBe(false);
            expect(await run(s, f, p, s)).toBe(false);
            continue;
          }
          expect(await run(s, f, p, n), `${key(s)} ${f},${p}`).toBe(true);
          expect(await run(s, f, p, [mod(n[0] + 1n), n[1], n[2]])).toBe(false);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(S.size);
    }, 600_000);
  });

  describe('across windows (Window N=4)', () => {
    let w: WasmTester;
    beforeAll(async () => {
      w = await windowCircuit(4);
    }, 300_000);
    const idleRecords = (h: { ammo: number; cooldown: number; reloadTimer: number }) => {
      const s = spawnState(0);
      return [0, 1, 2, 3].map((tick) => {
        h = stepWeapon(h, 0, 0);
        return { tick, ...s.pub, reloadPress: 0, ...h };
      });
    };
    const ctx = (hiddenIn: { ammo: number; cooldown: number; reloadTimer: number }) => {
      const s = spawnState(0);
      return {
        matchField: '77',
        playerIndex: 0 as const,
        roundNo: 1,
        windowIndex: 0,
        prev: [s.pub.x, s.pub.y, s.pub.angle, 0] as [number, number, number, number],
        hiddenIn,
        saltIn: '0',
        saltOut: '5',
      };
    };

    it('window 0 opening the public initialCommit forces the entering state (MAG, 0, 0)', async () => {
      const init = await initialCommitOf();
      const honest = await buildWindowInput(
        ctx({ ...INITIAL_HIDDEN }),
        idleRecords({ ...INITIAL_HIDDEN }),
      );
      expect(honest.input.commitIn).toBe(init);
      expect(await satisfiable(w, honest.input)).toBe(true);
      // any other entering state with commitIn = initialCommit fails the Commit constraint
      for (const h of [
        { ammo: MAG_SIZE + 1, cooldown: 0, reloadTimer: 0 },
        { ammo: MAG_SIZE, cooldown: 1, reloadTimer: 0 },
        { ammo: 1000, cooldown: 0, reloadTimer: 0 },
      ]) {
        const bad = await buildWindowInput(ctx(h), idleRecords(h));
        expect(await satisfiable(w, { ...bad.input, commitIn: init })).toBe(false);
      }
    });

    it('necessity: outside S the readings differ, and a merely *claimed* commitIn can start anywhere', async () => {
      // ammo = MAG + 1, idle, press: "≠ MAG" starts a reload (W4), "< MAG" would not (W5)
      expect(circuitStep([MAG + 1n, 0n, 0n], 0n, 1n)).toEqual([MAG + 1n, 0n, RELOAD]);
      expect(stepWeapon({ ammo: MAG_SIZE + 1, cooldown: 0, reloadTimer: 0 }, 0, 1)).toEqual({
        ammo: MAG_SIZE + 1,
        cooldown: 0,
        reloadTimer: 0,
      });
      // a window whose commitIn is an unproven claim to ammo = 1000 is satisfiable: only the
      // proof of the window that produced that claim (or the full audit) can expose it
      const h = { ammo: 1000, cooldown: 0, reloadTimer: 0 };
      const claimed = await buildWindowInput(ctx(h), idleRecords(h));
      expect(claimed.input.commitIn).toBe(await commitOf(h, '0'));
      expect(await satisfiable(w, claimed.input)).toBe(true);
    });
  });
});
