/**
 * Where does Node prove time go? Proves one real window several times in THIS thread (no worker)
 * with snarkjs's debug logger and prints the time between its step messages.
 *
 *   npx tsx server/scripts/prove-profile.ts --variant groth16_60 --runs 3
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as snarkjs from 'snarkjs';
import { poseidonReady } from '@zkduel/shared/poseidon';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { buildWindowInput, sliceLogWindows, testSalt } from '@zkduel/shared/zkInput';
import { CIRCUITS_BUILD, REPO_ROOT } from '../test/support/paths';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const variant = arg('variant', 'groth16_60');
const runs = Number(arg('runs', '3'));

async function main(): Promise<void> {
  await poseidonReady();
  const dir = join(CIRCUITS_BUILD, variant);
  const n = Number(variant.split('_')[1]);
  const fx = join(REPO_ROOT, 'circuits', 'test', 'fixtures');
  const f = readdirSync(fx)
    .filter((x) => x.endsWith('.jsonl'))
    .sort()[0] as string;
  const lines = readFileSync(join(fx, f), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TickLogLine);
  const w = sliceLogWindows(lines, n, testSalt(1))[1];
  if (!w) throw new Error('no window');
  const { input } = await buildWindowInput(w.ctx, w.records);
  const wasm = new Uint8Array(readFileSync(join(dir, 'window.wasm')));
  const zkey = new Uint8Array(readFileSync(join(dir, 'window_final.zkey')));
  for (let r = 0; r < runs; r++) {
    let last = performance.now();
    const steps: string[] = [];
    const log = (m: string) => {
      const t = performance.now();
      steps.push(`${(t - last).toFixed(0).padStart(6)} ms  → ${m}`);
      last = t;
    };
    const logger = { debug: log, info: log, warn: log, error: log };
    const t0 = performance.now();
    const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasm, wtns);
    const t1 = performance.now();
    last = t1;
    await snarkjs.groth16.prove(zkey, wtns, logger);
    const t2 = performance.now();
    console.log(`run ${r}: witness ${(t1 - t0).toFixed(0)} ms, prove ${(t2 - t1).toFixed(0)} ms`);
    if (r === runs - 1) console.log(steps.join('\n'));
  }
  process.exit(0);
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
