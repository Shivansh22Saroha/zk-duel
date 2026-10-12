/// <reference lib="webworker" />
/**
 * Phase 5 benchmark worker (/bench): witness, prove and verify for one variant, Groth16 or PLONK,
 * timed separately. Same snarkjs calls and thread setting (default = hardwareConcurrency
 * sub-workers) as the live Proof Worker, which stays Groth16-only and untouched.
 */
import type * as SnarkjsModule from 'snarkjs';
import type { CircuitInput } from '@zkduel/shared/zkInput';

export type BenchWorkerRequest =
  | {
      t: 'init';
      scheme: 'groth16' | 'plonk';
      wasm: ArrayBuffer;
      zkey: ArrayBuffer;
      vkey: unknown;
    }
  | { t: 'sample'; id: number; input: CircuitInput };

export type BenchWorkerResponse =
  | { t: 'ready'; hardwareConcurrency: number }
  | {
      t: 'sampled';
      id: number;
      witnessMs: number;
      proveMs: number;
      verifyMs: number;
      proofBytes: number;
      verified: boolean;
      publicSignals: string[];
      startedAt: number;
      endedAt: number;
    }
  | { t: 'failed'; id: number; stage: 'init' | 'witness' | 'prove' | 'verify'; reason: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let snarkjs: typeof SnarkjsModule | null = null;
let scheme: 'groth16' | 'plonk' = 'groth16';
let wasm: Uint8Array | null = null;
let zkey: Uint8Array | null = null;
let vkey: unknown = null;

const post = (m: BenchWorkerResponse): void => ctx.postMessage(m);

ctx.onmessage = async (ev: MessageEvent<BenchWorkerRequest>) => {
  const m = ev.data;
  if (m.t === 'init') {
    try {
      snarkjs = await import('snarkjs');
      scheme = m.scheme;
      wasm = new Uint8Array(m.wasm);
      zkey = new Uint8Array(m.zkey);
      vkey = m.vkey;
      post({ t: 'ready', hardwareConcurrency: ctx.navigator.hardwareConcurrency });
    } catch (e) {
      post({ t: 'failed', id: 0, stage: 'init', reason: String(e) });
    }
    return;
  }
  if (!snarkjs || !wasm || !zkey) {
    post({ t: 'failed', id: m.id, stage: 'init', reason: 'worker not initialised' });
    return;
  }
  const prover = scheme === 'groth16' ? snarkjs.groth16 : snarkjs.plonk;
  let stage: 'witness' | 'prove' | 'verify' = 'witness';
  try {
    const startedAt = Date.now();
    const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
    const a = performance.now();
    await snarkjs.wtns.calculate(m.input, wasm, wtns);
    const b = performance.now();
    stage = 'prove';
    const { proof, publicSignals } = await prover.prove(zkey, wtns);
    const c = performance.now();
    stage = 'verify';
    const verified = await prover.verify(vkey, publicSignals, proof as never);
    const d = performance.now();
    post({
      t: 'sampled',
      id: m.id,
      witnessMs: b - a,
      proveMs: c - b,
      verifyMs: d - c,
      proofBytes: JSON.stringify(proof).length,
      verified,
      publicSignals,
      startedAt,
      endedAt: Date.now(),
    });
  } catch (e) {
    post({ t: 'failed', id: m.id, stage, reason: String(e) });
  }
};
