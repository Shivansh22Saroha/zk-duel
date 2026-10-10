/**
 * Isolated Node measurement (no match running): prove real fixture windows through the bots'
 * worker_threads prover and verify them in the server's VerifierPool.
 *
 *   npx tsx server/scripts/zk-node-bench.ts --variant groth16_60 --count 10 --threads 12 --verifiers 1
 *
 * Writes server/data/test-reports/phase3-node-zk-<variant>-t<threads>.txt.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { poseidonReady } from '@zkduel/shared/poseidon';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { sliceLogWindows, testSalt } from '@zkduel/shared/zkInput';
import { NodeProver } from '../test/support/nodeProver';
import { CIRCUITS_BUILD, REPO_ROOT, REPORT_DIR } from '../test/support/paths';
import { loadVariant } from '../src/zk/variant';
import { VerifierPool, verifyTiming } from '../src/zk/verifierPool';
import type { WindowJob } from '../../client/src/zk/recorder';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const variant = arg('variant', 'groth16_60');
const count = Number(arg('count', '10'));
const threads = Number(arg('threads', '12'));
const verifiers = Number(arg('verifiers', '1'));
const VERIFY_REPEAT = 20;
const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;

async function main(): Promise<void> {
  await poseidonReady();
  const v = loadVariant(CIRCUITS_BUILD, variant);
  const n = v.info.windowTicks;
  const fx = join(REPO_ROOT, 'circuits', 'test', 'fixtures');
  const jobs: WindowJob[] = [];
  for (const f of readdirSync(fx)
    .filter((x) => x.endsWith('.jsonl'))
    .sort()) {
    const lines = readFileSync(join(fx, f), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TickLogLine);
    for (const w of sliceLogWindows(lines, n, testSalt(9))) {
      jobs.push({
        roundNo: w.ctx.roundNo,
        windowIndex: w.ctx.windowIndex,
        ctx: w.ctx,
        records: w.records,
        commitOut: '',
        padded: w.padded,
      });
    }
  }
  const pick = jobs
    .filter((_, i) => i % Math.max(1, Math.floor(jobs.length / (count + 1))) === 0)
    .slice(0, count + 1);
  const prover = new NodeProver(join(CIRCUITS_BUILD, variant), threads);
  const proofs: { proof: unknown; publicSignals: string[] }[] = [];
  const prove: number[] = [];
  const wit: number[] = [];
  for (const [i, j] of pick.entries()) {
    const r = await prover.prove(j);
    if (!r.ok) throw new Error(r.reason);
    if (i > 0) {
      prove.push(r.proveMs);
      wit.push(r.witnessMs);
    }
    proofs.push({ proof: r.proof, publicSignals: r.publicSignals });
  }
  prover.dispose();
  const pool = new VerifierPool(v.vkeyPath, 'groth16', verifiers, 2000);
  await pool.ready();
  verifyTiming.reset();
  const wall: number[] = [];
  let ok = 0;
  for (let k = 0; k < VERIFY_REPEAT; k++) {
    for (const p of proofs) {
      const t0 = performance.now();
      const r = await pool.verify(p.publicSignals, p.proof);
      wall.push(performance.now() - t0);
      if (r.ok) ok++;
    }
  }
  const vt = verifyTiming.summary();
  await pool.close();
  const text = [
    `${new Date().toISOString()} Node ${process.version}, ${variant} (${v.info.constraints} constraints), prover threads=${threads}, ${count} real windows (+1 warm-up)`,
    `witness p50 ${pct(wit, 0.5).toFixed(0)} p95 ${pct(wit, 0.95).toFixed(0)} ms; prove p50 ${pct(prove, 0.5).toFixed(0)} p95 ${pct(prove, 0.95).toFixed(0)} ms`,
    `verify in VerifierPool (${verifiers} worker, idle machine): n=${vt.n} in-worker p50 ${vt.p50.toFixed(1)} p95 ${vt.p95.toFixed(1)} max ${vt.max.toFixed(1)} ms; round-trip p50 ${pct(wall, 0.5).toFixed(1)} p95 ${pct(wall, 0.95).toFixed(1)} ms; ${ok}/${wall.length} valid`,
  ].join('\n');
  console.log(text);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `phase3-node-zk-${variant}-t${threads}.txt`), text + '\n');
  process.exit(0);
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
