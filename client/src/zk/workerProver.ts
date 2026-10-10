/** Browser Prover: the Proof Worker (Web Worker running snarkjs), one proof at a time. */
import type { WindowJob } from './recorder';
import type { ProveOutcome, Prover } from './proofClient';
import type { ThreadSetting, WorkerRequest, WorkerResponse } from './proofWorker';

export class WorkerProver implements Prover {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (r: ProveOutcome) => void>();
  private nextId = 1;
  private readonly ready: Promise<void>;

  /** `wasm`/`zkey` buffers are transferred to the worker (they become unusable here). */
  /** Cold-start proof time paid during init (null: no warm-up or it failed). */
  warmupMs: number | null = null;

  constructor(
    wasm: ArrayBuffer,
    zkey: ArrayBuffer,
    threads: ThreadSetting = 'default',
    warmupWindowTicks?: number,
  ) {
    this.worker = new Worker(new URL('./proofWorker.ts', import.meta.url), { type: 'module' });
    let markReady: () => void = () => undefined;
    this.ready = new Promise((r) => (markReady = r));
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.t === 'ready') {
        this.warmupMs = m.warmupMs;
        return markReady();
      }
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!done) return;
      done(
        m.t === 'proved'
          ? {
              ok: true,
              proof: m.proof,
              publicSignals: m.publicSignals,
              witnessMs: m.witnessMs,
              proveMs: m.proveMs,
            }
          : { ok: false, reason: `${m.stage}: ${m.reason}` },
      );
    };
    this.worker.onerror = (e) => {
      for (const done of this.pending.values())
        done({ ok: false, reason: `worker error: ${e.message}` });
      this.pending.clear();
    };
    const init: WorkerRequest = { t: 'init', wasm, zkey, threads, warmupWindowTicks };
    this.worker.postMessage(init, [wasm, zkey]);
  }

  async prove(job: WindowJob): Promise<ProveOutcome> {
    await this.ready;
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const req: WorkerRequest = { t: 'proveWindow', id, ctx: job.ctx, records: job.records };
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const done of this.pending.values()) done({ ok: false, reason: 'disposed' });
    this.pending.clear();
  }
}
