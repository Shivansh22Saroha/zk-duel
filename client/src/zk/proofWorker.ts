/// <reference lib="webworker" />
/**
 * Proof Worker (ARCHITECTURE §7): snarkjs Groth16 in a dedicated Web Worker, one proof at a time.
 * The main thread owns the queue (challenges first, audit after the match — ProofQueue); this
 * worker only proves what it is given and reports witness / prove time separately.
 *
 * Threads: snarkjs (ffjavascript) spawns `navigator.hardwareConcurrency` sub-workers the first
 * time the curve is built. `threads` caps that by overriding hardwareConcurrency inside this
 * worker before snarkjs is loaded; 'single' proves inside this worker with no sub-workers.
 */
import { holdTick, spawnState, toRecord, toTuple, type TickRecord } from '@zkduel/shared/sim';
import { buildWindowInput, type CircuitInput, type WindowContext } from '@zkduel/shared/zkInput';
import type * as SnarkjsModule from 'snarkjs';
import type { Groth16Proof } from 'snarkjs';

export type ThreadSetting = 'default' | 'single' | number;

export type WorkerRequest =
  | {
      t: 'init';
      wasm: ArrayBuffer;
      zkey: ArrayBuffer;
      threads: ThreadSetting;
      /** Prove one synthetic honest window of this size before reporting ready (cold start). */
      warmupWindowTicks?: number;
    }
  | { t: 'prove'; id: number; input: CircuitInput }
  /** Build the circuit input here (digest chain, bind, commitments), then prove. */
  | { t: 'proveWindow'; id: number; ctx: WindowContext; records: TickRecord[] };

export type WorkerResponse =
  | { t: 'ready'; hardwareConcurrency: number; warmupMs: number | null }
  | {
      t: 'proved';
      id: number;
      proof: Groth16Proof;
      publicSignals: string[];
      witnessMs: number;
      proveMs: number;
      /** snarkjs sub-workers actually used (0 = single-threaded in this worker). */
      threads: number;
    }
  | { t: 'failed'; id: number; stage: 'witness' | 'prove'; reason: string };

type Snarkjs = typeof SnarkjsModule;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let snarkjs: Snarkjs | null = null;
let wasm: Uint8Array | null = null;
let zkey: Uint8Array | null = null;
let single = false;

const post = (m: WorkerResponse): void => ctx.postMessage(m);

function threadsInUse(): number {
  if (single) return 0;
  const c = (globalThis as { curve_bn128?: { tm?: { concurrency?: number } } | null }).curve_bn128;
  return c?.tm?.concurrency ?? -1;
}

/** One honest synthetic window (player 0 standing at spawn), proved and discarded. */
async function warmUp(n: number): Promise<void> {
  if (!snarkjs || !wasm || !zkey) return;
  let s = spawnState(0);
  const records: TickRecord[] = [];
  for (let t = 0; t < n; t++) {
    s = holdTick(s);
    records.push(toRecord(t, s, 0));
  }
  const { input } = await buildWindowInput(
    {
      matchField: '1',
      playerIndex: 0,
      roundNo: 1,
      windowIndex: 0,
      prev: toTuple(spawnState(0).pub),
      hiddenIn: spawnState(0).hidden,
      saltIn: '0',
      saltOut: '1',
    },
    records,
  );
  const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
  await snarkjs.wtns.calculate(input, wasm, wtns);
  await snarkjs.groth16.prove(zkey, wtns, undefined, single ? { singleThread: true } : undefined);
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  if (m.t === 'init') {
    if (typeof m.threads === 'number') {
      Object.defineProperty(ctx.navigator, 'hardwareConcurrency', { value: m.threads });
    }
    single = m.threads === 'single';
    snarkjs = await import('snarkjs');
    wasm = new Uint8Array(m.wasm);
    zkey = new Uint8Array(m.zkey);
    let warmupMs: number | null = null;
    if (m.warmupWindowTicks) {
      // The first proof pays for WASM compilation and the snarkjs thread pool (seconds). Pay it
      // during the countdown instead of inside the first challenge's deadline.
      const t0 = performance.now();
      try {
        await warmUp(m.warmupWindowTicks);
        warmupMs = performance.now() - t0;
      } catch {
        warmupMs = null;
      }
    }
    post({ t: 'ready', hardwareConcurrency: ctx.navigator.hardwareConcurrency, warmupMs });
    return;
  }
  if (!snarkjs || !wasm || !zkey) {
    post({ t: 'failed', id: m.id, stage: 'witness', reason: 'worker not initialised' });
    return;
  }
  const t0 = performance.now();
  const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
  try {
    const input = m.t === 'prove' ? m.input : (await buildWindowInput(m.ctx, m.records)).input;
    await snarkjs.wtns.calculate(input, wasm, wtns);
  } catch (e) {
    // a rule violation surfaces here: no witness satisfies the circuit (FR-20)
    post({ t: 'failed', id: m.id, stage: 'witness', reason: String(e).slice(0, 200) });
    return;
  }
  const t1 = performance.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.prove(
      zkey,
      wtns,
      undefined,
      single ? { singleThread: true } : undefined,
    );
    post({
      t: 'proved',
      id: m.id,
      proof,
      publicSignals,
      witnessMs: t1 - t0,
      proveMs: performance.now() - t1,
      threads: threadsInUse(),
    });
  } catch (e) {
    post({ t: 'failed', id: m.id, stage: 'prove', reason: String(e).slice(0, 200) });
  }
};
