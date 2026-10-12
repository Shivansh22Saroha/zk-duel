/**
 * Phase 5 browser benchmark runner (/bench "Run benchmark in this browser", and the Playwright
 * driver client/scripts/bench-browser.ts). Same deterministic input log and windows as the Node
 * runner (`shared/benchLog.ts`, BENCH_SEED); the proving runs in a Web Worker.
 *
 * Artefacts are fetched from /zk/<variant>/ and checked against the published SHA-256, but not put
 * in the Cache API (PLONK zkeys are ~1–4 GB). A variant that cannot be loaded or proven (e.g. out
 * of memory) is recorded as a failure with its reason.
 */
import { BENCH_SAMPLES, BENCH_SEED, BENCH_WARMUPS } from '@zkduel/shared/constants';
import type { BenchSample } from '@zkduel/shared/benchStats';
import {
  benchLogName,
  benchLogSha256,
  benchWindows,
  generateBenchLog,
} from '@zkduel/shared/benchLog';
import { buildWindowInput, namePublicSignals, type PublicSignalName } from '@zkduel/shared/zkInput';
import { sha256Hex } from '../zk/artefacts';
import type { BenchWorkerRequest, BenchWorkerResponse } from './benchWorker';

export interface BrowserSample extends BenchSample {
  /** Epoch ms around the sample — the Playwright driver attributes Chrome memory with these. */
  startedAt: number;
  endedAt: number;
}

export interface BrowserVariantRun {
  id: string;
  ok: boolean;
  error?: string;
  zkeyBytes?: number;
  loadMs?: number;
  warmupMs: number[];
  samples: BrowserSample[];
}

export interface BrowserBenchResult {
  inputLog: string;
  inputLogSha256: string;
  seed: number;
  userAgent: string;
  cpuThreads: number;
  workerThreads: number | null;
  hiddenDuringRun: boolean;
  runs: BrowserVariantRun[];
}

interface Info {
  scheme: 'groth16' | 'plonk';
  windowTicks: number;
  constraints: number;
  zkeySha256: string;
  wasmSha256: string;
  zkeyBytes: number;
  publicSignalOrder: PublicSignalName[];
}

async function fetchChecked(url: string, sha256: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const got = await sha256Hex(buf);
  if (got !== sha256) throw new Error(`${url}: sha256 mismatch`);
  return buf;
}

export async function runBrowserBench(
  variants: string[],
  onLog: (line: string) => void,
  samplesWanted: number = BENCH_SAMPLES,
  warmups: number = BENCH_WARMUPS,
): Promise<BrowserBenchResult> {
  let hiddenDuringRun = false;
  const onVis = (): void => {
    if (document.visibilityState === 'hidden') hiddenDuringRun = true;
  };
  document.addEventListener('visibilitychange', onVis);
  const log = generateBenchLog(BENCH_SEED);
  const result: BrowserBenchResult = {
    inputLog: benchLogName(BENCH_SEED),
    inputLogSha256: await benchLogSha256(log),
    seed: BENCH_SEED,
    userAgent: navigator.userAgent,
    cpuThreads: navigator.hardwareConcurrency,
    workerThreads: null,
    hiddenDuringRun: false,
    runs: [],
  };
  onLog(`input ${result.inputLog} sha256 ${result.inputLogSha256}`);

  for (const id of variants) {
    const run: BrowserVariantRun = { id, ok: true, warmupMs: [], samples: [] };
    result.runs.push(run);
    let worker: Worker | null = null;
    try {
      const base = `/zk/${id}`;
      const info = (await (await fetch(`${base}/info.json`)).json()) as Info;
      run.zkeyBytes = info.zkeyBytes;
      onLog(`${id}: loading ${(info.zkeyBytes / 2 ** 20).toFixed(0)} MiB zkey…`);
      const t0 = performance.now();
      const [wasm, zkey, vkey] = await Promise.all([
        fetchChecked(`${base}/window.wasm`, info.wasmSha256),
        fetchChecked(`${base}/window_final.zkey`, info.zkeySha256),
        fetch(`${base}/verification_key.json`).then((r) => r.json() as Promise<unknown>),
      ]);
      run.loadMs = performance.now() - t0;
      const windows = benchWindows(log, info.windowTicks, BENCH_SEED).slice(
        0,
        warmups + samplesWanted,
      );

      worker = new Worker(new URL('./benchWorker.ts', import.meta.url), { type: 'module' });
      const w = worker;
      const replies = new Map<number, (r: BenchWorkerResponse) => void>();
      let ready: (r: BenchWorkerResponse) => void = () => undefined;
      const readyP = new Promise<BenchWorkerResponse>((r) => (ready = r));
      let crashed: (e: Error) => void = () => undefined;
      const crash = new Promise<never>((_, reject) => (crashed = reject));
      crash.catch(() => undefined);
      w.onmessage = (ev: MessageEvent<BenchWorkerResponse>) => {
        const m = ev.data;
        if (m.t === 'ready' || (m.t === 'failed' && m.stage === 'init')) ready(m);
        else replies.get(m.id)?.(m);
      };
      w.onerror = (e) => crashed(new Error(`worker error: ${e.message || 'crashed'}`));
      const req: BenchWorkerRequest = { t: 'init', scheme: info.scheme, wasm, zkey, vkey };
      w.postMessage(req, [wasm, zkey]);
      const r0 = await Promise.race([readyP, crash]);
      if (r0.t === 'failed') throw new Error(`init: ${r0.reason}`);
      if (r0.t === 'ready') result.workerThreads = r0.hardwareConcurrency;

      let nextId = 1;
      for (const [i, win] of windows.entries()) {
        const { input, expected } = await buildWindowInput(win.ctx, win.records);
        const id2 = nextId++;
        const r = await Promise.race([
          new Promise<BenchWorkerResponse>((res) => {
            replies.set(id2, res);
            w.postMessage({ t: 'sample', id: id2, input } satisfies BenchWorkerRequest);
          }),
          crash,
        ]);
        replies.delete(id2);
        if (r.t === 'failed') throw new Error(`${r.stage}: ${r.reason}`);
        if (r.t !== 'sampled') throw new Error(`unexpected worker reply ${r.t}`);
        const named = namePublicSignals(info.publicSignalOrder, r.publicSignals);
        const signalsOk = (['bind', 'digest', 'commitIn', 'commitOut'] as const).every(
          (k) => named[k] === expected[k],
        );
        const s: BrowserSample = {
          scheme: info.scheme,
          windowTicks: info.windowTicks,
          constraints: info.constraints,
          sampleNo: i - warmups + 1,
          witnessMs: r.witnessMs,
          proveMs: r.proveMs,
          verifyMs: r.verifyMs,
          proofBytes: r.proofBytes,
          valid: r.verified && signalsOk,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        };
        const tag = i < warmups ? `warm-up ${i + 1}` : `${s.sampleNo}/${samplesWanted}`;
        onLog(
          `${id} ${tag}: witness ${s.witnessMs.toFixed(0)} ms, prove ${s.proveMs.toFixed(0)} ms, verify ${s.verifyMs.toFixed(1)} ms, ${s.proofBytes} B, ${s.valid ? 'valid' : 'INVALID'}`,
        );
        if (i < warmups) run.warmupMs.push(s.proveMs);
        else run.samples.push(s);
      }
    } catch (e) {
      run.ok = false;
      run.error = e instanceof Error ? e.message : String(e);
      onLog(`${id}: FAILED after ${run.samples.length} samples — ${run.error}`);
    } finally {
      worker?.terminate();
    }
  }
  document.removeEventListener('visibilitychange', onVis);
  result.hiddenDuringRun = hiddenDuringRun;
  return result;
}
