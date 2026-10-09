/**
 * Offline end-to-end checks:
 *  - mutated (cheating) real logs: the circuit rejects exactly the windows shared/sim.ts rejects
 *  - N=60 smoke: every real N=60 window has a witness; with built artefacts, one window is
 *    proved + verified and its public signals (named via info.json) equal the JS reference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WasmTester } from 'circom_tester';
import * as snarkjs from 'snarkjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkSequence, type PlayerState } from '@zkduel/shared/sim';
import {
  buildWindowInput,
  namePublicSignals,
  sliceLogWindows,
  testSalt,
  type LogWindow,
} from '@zkduel/shared/zkInput';
import type { VariantInfo } from '../scripts/build';
import { mutateLog, type Cheat } from '../scripts/mutate-log';
import { CIRCUITS_DIR, fixtureLogs, satisfiable, windowCircuit } from './helpers';

const start = (w: LogWindow): PlayerState => ({
  pub: { x: w.ctx.prev[0], y: w.ctx.prev[1], angle: w.ctx.prev[2], fired: w.ctx.prev[3] },
  hidden: { ...w.ctx.hiddenIn },
});

describe('mutated real logs, N=4: circuit rejects exactly the cheating windows', () => {
  let c: WasmTester;
  beforeAll(async () => {
    c = await windowCircuit(4);
  }, 300_000);

  for (const cheat of ['speed', 'rapid', 'ammo'] as Cheat[]) {
    it(`${cheat}`, async () => {
      let rejected = 0;
      for (const log of fixtureLogs().filter((l) => l.name.includes('bffb33a1'))) {
        const m = mutateLog(log.lines, cheat, { windowTicks: 4 });
        for (const w of sliceLogWindows(m.lines, 4, testSalt(3)).filter(
          (x) => x.ctx.roundNo === m.roundNo,
        )) {
          const simOk = checkSequence(start(w), w.records) === null;
          const { input } = await buildWindowInput(w.ctx, w.records);
          expect(await satisfiable(c, input), `${log.name} window ${w.ctx.windowIndex}`).toBe(
            simOk,
          );
          const containsCheat = w.records.some((r) => r.tick === m.tick);
          if (containsCheat) expect(simOk).toBe(false);
          if (!simOk) rejected++;
        }
      }
      expect(rejected).toBeGreaterThanOrEqual(1);
    }, 300_000);
  }
});

describe('N=60 smoke', () => {
  let c: WasmTester;
  beforeAll(async () => {
    c = await windowCircuit(60);
  }, 600_000);

  it('every N=60 window of every real log has a witness; commitOut equals JS', async () => {
    let n = 0;
    for (const log of fixtureLogs()) {
      for (const w of sliceLogWindows(log.lines, 60, testSalt(11))) {
        const { input, expected } = await buildWindowInput(w.ctx, w.records);
        const wit = await c.calculateWitness(input, true);
        await c.assertOut(wit, { commitOut: expected.commitOut });
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(20);
  }, 600_000);

  const dir = join(CIRCUITS_DIR, 'build', 'groth16_60');
  it.skipIf(!existsSync(join(dir, 'info.json')))(
    'built groth16_60: prove + verify a real window; publicSignalOrder from info.json maps to the JS values',
    async () => {
      const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as VariantInfo;
      const vkey = JSON.parse(readFileSync(join(dir, 'verification_key.json'), 'utf8')) as unknown;
      const log = fixtureLogs()[0];
      const w = sliceLogWindows(log?.lines ?? [], 60, testSalt(5))[0] as LogWindow;
      const { input, expected } = await buildWindowInput(w.ctx, w.records);
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        join(dir, 'window.wasm'),
        join(dir, 'window_final.zkey'),
      );
      expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
      expect(namePublicSignals(info.publicSignalOrder, publicSignals)).toEqual(expected);
      // a tampered public signal must not verify
      const bad = [...publicSignals];
      bad[info.publicSignalOrder.indexOf('digest')] = '1';
      expect(await snarkjs.groth16.verify(vkey, bad, proof)).toBe(false);
    },
    300_000,
  );
});
