/**
 * Phase 5 Node benchmark runner (ARCHITECTURE §8, FEATURES F15).
 *
 *   npm run bench:node                                   all built benchmark variants
 *   npm run bench:node -- --variants groth16_60,plonk_30 --samples 5
 *   npm run bench:node -- --upload                       also POST to /api/bench/runs
 *
 * For every variant: the deterministic input log (BENCH_SEED, `shared/benchLog.ts`), sliced into
 * windows of N; BENCH_WARMUPS warm-up proofs (run, not stored), then BENCH_SAMPLES samples. Per
 * sample: witness / prove / verify ms, proof bytes (JSON, as sent on the wire), valid (verifies
 * AND the public signals equal the JS reference), peak process RSS (MiB, sampled every
 * MEM_SAMPLE_MS; snarkjs's worker threads live in this process).
 *
 * Writes bench/out/raw/node-<timestamp>.json; with --upload also uploads (needs BENCH_TOKEN in
 * server/.env and the server on PERF_API / localhost:8080). A variant that cannot run (out of
 * memory, missing build) is recorded as a failure, never skipped silently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  BENCH_SAMPLES,
  BENCH_SEED,
  BENCH_WARMUPS,
  BENCH_WINDOW_TICKS,
  type Scheme,
} from '@zkduel/shared/constants';
import { aggregate, type BenchSample } from '@zkduel/shared/benchStats';
import { readLarge } from '../circuits/scripts/bigFile';
import {
  benchLogName,
  benchLogSha256,
  benchWindows,
  generateBenchLog,
} from '@zkduel/shared/benchLog';
import { buildWindowInput, namePublicSignals, type PublicSignalName } from '@zkduel/shared/zkInput';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'circuits', 'build');
const OUT = join(ROOT, 'bench', 'out', 'raw');
const API = process.env.PERF_API ?? 'http://localhost:8080';
/** RSS sampling period while a sample runs. */
const MEM_SAMPLE_MS = 20;
const MIB = 2 ** 20;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const samplesWanted = Number(arg('samples') ?? BENCH_SAMPLES);
/**
 * PLONK can be run with fewer samples (owner decision, Phase 5: 3–13 min per PLONK proof here);
 * the run notes record it.
 */
const plan = (scheme: Scheme): { samples: number; warmups: number } =>
  scheme === 'plonk'
    ? {
        samples: Number(arg('plonk-samples') ?? samplesWanted),
        warmups: Number(arg('plonk-warmups') ?? BENCH_WARMUPS),
      }
    : { samples: samplesWanted, warmups: BENCH_WARMUPS };

interface Info {
  id: string;
  scheme: Scheme;
  windowTicks: number;
  constraints: number;
  publicSignalOrder: PublicSignalName[];
}

/** Epoch ms around the sample: lets a run be matched against a power-state log afterwards. */
export type TimedSample = BenchSample & { startedAt: number; endedAt: number };

export interface VariantRun {
  id: string;
  ok: boolean;
  error?: string;
  /** Process RSS before this variant's artefacts were loaded, MiB. */
  baseRssMb?: number;
  loadMs?: number;
  warmupMs?: number[];
  samples: TimedSample[];
}

function benchVariants(): string[] {
  const want = arg('variants')?.split(',');
  const all = readdirSync(BUILD).filter((d) => {
    const m = /^(groth16|plonk)_(\d+)$/.exec(d);
    return m && (BENCH_WINDOW_TICKS as readonly number[]).includes(Number(m[2]));
  });
  return (want ?? all).sort();
}

/** Run fn while sampling RSS; returns its result and the peak RSS in MiB. */
async function withPeakRss<T>(fn: () => Promise<T>): Promise<{ value: T; peakMb: number }> {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, MEM_SAMPLE_MS);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { value, peakMb: peak / MIB };
  } finally {
    clearInterval(t);
  }
}

async function runVariant(
  id: string,
  log: ReturnType<typeof generateBenchLog>,
): Promise<VariantRun> {
  const dir = join(BUILD, id);
  if (!existsSync(join(dir, 'info.json')))
    return { id, ok: false, error: 'not built', samples: [] };
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as Info;
  const baseRssMb = Math.round((process.memoryUsage().rss / MIB) * 10) / 10;
  const t0 = performance.now();
  const wasm = readLarge(join(dir, 'window.wasm'));
  const zkey = readLarge(join(dir, 'window_final.zkey')); // PLONK N=120: 4.2 GB
  const vkey = JSON.parse(readFileSync(join(dir, 'verification_key.json'), 'utf8')) as unknown;
  const loadMs = performance.now() - t0;
  const prover = info.scheme === 'groth16' ? snarkjs.groth16 : snarkjs.plonk;
  const { samples: nSamples, warmups } = plan(info.scheme);
  const windows = benchWindows(log, info.windowTicks, BENCH_SEED).slice(0, warmups + nSamples);

  const one = async (w: (typeof windows)[number], sampleNo: number): Promise<TimedSample> => {
    const startedAt = Date.now();
    const { input, expected } = await buildWindowInput(w.ctx, w.records);
    const { value, peakMb } = await withPeakRss(async () => {
      const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
      const a = performance.now();
      await snarkjs.wtns.calculate(input, wasm, wtns);
      const b = performance.now();
      const { proof, publicSignals } = await prover.prove(zkey, wtns);
      const c = performance.now();
      const verified = await prover.verify(vkey, publicSignals, proof as never);
      const d = performance.now();
      const named = namePublicSignals(info.publicSignalOrder, publicSignals);
      const signalsOk = (['bind', 'digest', 'commitIn', 'commitOut'] as const).every(
        (k) => named[k] === expected[k],
      );
      return {
        witnessMs: b - a,
        proveMs: c - b,
        verifyMs: d - c,
        proofBytes: JSON.stringify(proof).length,
        valid: verified && signalsOk,
      };
    });
    return {
      scheme: info.scheme,
      windowTicks: info.windowTicks,
      constraints: info.constraints,
      sampleNo,
      ...value,
      peakMemMb: Math.round(peakMb * 10) / 10,
      startedAt,
      endedAt: Date.now(),
    };
  };

  const run: VariantRun = { id, ok: true, baseRssMb, loadMs, warmupMs: [], samples: [] };
  try {
    for (const [i, w] of windows.entries()) {
      const s = await one(w, i - warmups + 1);
      const tag = i < warmups ? `warm-up ${i + 1}` : `${s.sampleNo}/${nSamples}`;
      console.log(
        `[${id}] ${tag}: witness ${s.witnessMs.toFixed(0)} ms, prove ${s.proveMs.toFixed(0)} ms, verify ${s.verifyMs.toFixed(1)} ms, ${s.proofBytes} B, ${s.valid ? 'valid' : 'INVALID'}, peak RSS ${s.peakMemMb} MiB`,
      );
      if (i < warmups) run.warmupMs?.push(s.proveMs);
      else run.samples.push(s);
    }
  } catch (e) {
    run.ok = false;
    run.error = e instanceof Error ? e.message : String(e);
    console.error(`[${id}] FAILED after ${run.samples.length} samples: ${run.error}`);
  }
  return run;
}

async function main(): Promise<void> {
  const log = generateBenchLog(BENCH_SEED);
  const inputLog = benchLogName(BENCH_SEED);
  const inputLogSha256 = await benchLogSha256(log);
  mkdirSync(join(ROOT, 'bench', 'logs'), { recursive: true });
  writeFileSync(
    join(ROOT, 'bench', 'logs', inputLog),
    log.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
  const deviceLabel = `${cpu}, ${Math.round(totalmem() / 2 ** 30)} GB, ${cpus().length} threads`;
  let gitCommit: string | undefined;
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    gitCommit = undefined;
  }
  console.log(
    `Node ${process.version}, snarkjs, ${deviceLabel}; input ${inputLog} sha256 ${inputLogSha256}`,
  );
  const runs: VariantRun[] = [];
  for (const id of benchVariants()) runs.push(await runVariant(id, log));

  const samples = runs.flatMap((r) => r.samples);
  for (const a of aggregate(samples)) {
    console.log(
      `${a.scheme}_${a.windowTicks}: n=${a.n} valid=${a.valid} prove mean ${a.proveMs.mean.toFixed(0)} p5 ${a.proveMs.p5.toFixed(0)} p50 ${a.proveMs.p50.toFixed(0)} p95 ${a.proveMs.p95.toFixed(0)} ms; verify ${a.verifyMs.mean.toFixed(1)} ms; ${a.proofBytes} B; play ${a.playMs} ms → prove/play ${a.proveToPlay.toFixed(2)}, r_max ${a.rMax.toFixed(2)}; peak ${a.peakMemMb} MiB`,
    );
  }
  const failures = runs.filter((r) => !r.ok).map((r) => `${r.id}: ${r.error}`);
  const notes = [
    `Node ${process.version}`,
    `Groth16: ${BENCH_WARMUPS} warm-ups + ${samplesWanted} samples`,
    `PLONK: ${plan('plonk').warmups} warm-ups + ${plan('plonk').samples} samples`,
    ...failures.map((f) => `FAILED ${f}`),
  ].join('; ');
  const record = {
    environment: 'node' as const,
    deviceLabel,
    cpuThreads: cpus().length,
    inputLog,
    inputLogSha256,
    seed: BENCH_SEED,
    gitCommit,
    notes,
    nodeVersion: process.version,
    runs,
  };
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `node-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 1));
  console.log(`wrote ${file}`);

  if (process.argv.includes('--upload') && samples.length) {
    const env = readFileSync(join(ROOT, 'server', '.env'), 'utf8');
    const token = /^BENCH_TOKEN=(.+)$/m.exec(env)?.[1]?.trim();
    if (!token) throw new Error('BENCH_TOKEN missing in server/.env');
    const { nodeVersion: _n, runs: _r, ...meta } = record;
    const r = await fetch(`${API}/api/bench/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bench-token': token },
      body: JSON.stringify({
        ...meta,
        results: samples.map(({ peakMemMb, startedAt: _s, endedAt: _e, ...s }) => ({
          ...s,
          peakMemMb: peakMemMb ?? undefined,
        })),
      }),
    });
    console.log(`upload: HTTP ${r.status} ${await r.text()}`);
    if (!r.ok) process.exitCode = 1;
  }
  if (failures.length) console.log(`failures: ${failures.join('; ')}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0)) // snarkjs keeps worker threads alive
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
