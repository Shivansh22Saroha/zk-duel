/** Node Prover for bots / integration tests: builds the circuit input, proves in a worker_thread. */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildWindowInput } from '@zkduel/shared/zkInput';
import type { ProveOutcome, Prover } from '../../../client/src/zk/proofClient';
import type { WindowJob } from '../../../client/src/zk/recorder';

const WORKER_URL = new URL('./nodeProveWorker.mjs', import.meta.url);

export class NodeProver implements Prover {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (r: ProveOutcome) => void>();
  private nextId = 1;
  private readonly ready: Promise<void>;

  constructor(variantDir: string, threads = 2) {
    this.worker = new Worker(WORKER_URL, {
      workerData: {
        wasmPath: join(variantDir, 'window.wasm'),
        zkeyPath: join(variantDir, 'window_final.zkey'),
        threads,
      },
    });
    let markReady: () => void = () => undefined;
    this.ready = new Promise((r) => (markReady = r));
    this.worker.on('message', (m: { ready?: boolean; id?: number } & Record<string, unknown>) => {
      if (m.ready) return markReady();
      const done = this.pending.get(m.id as number);
      this.pending.delete(m.id as number);
      done?.(m as unknown as ProveOutcome);
    });
    const fail = (why: string) => {
      for (const done of this.pending.values()) done({ ok: false, reason: why });
      this.pending.clear();
    };
    this.worker.on('error', (e) => fail(`prover worker error: ${String(e)}`));
    this.worker.on('exit', (code) => fail(`prover worker exited (${code})`));
  }

  async prove(job: WindowJob): Promise<ProveOutcome> {
    await this.ready;
    const { input } = await buildWindowInput(job.ctx, job.records);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, input });
    });
  }

  dispose(): void {
    void this.worker.terminate();
    for (const done of this.pending.values()) done({ ok: false, reason: 'disposed' });
    this.pending.clear();
  }
}
