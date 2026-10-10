/**
 * VerifierPool (ARCHITECTURE §6, SECURITY §6): `size` worker_threads running snarkjs verify, one
 * job per worker at a time, FIFO queue. A job that exceeds `timeoutMs` resolves as not ok
 * (→ `invalid`) and its worker is replaced. Verify times are recorded in `verifyTiming`.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { Scheme } from '@zkduel/shared/constants';
import { TimingStats } from '../match/stats';

export interface VerifyOutcome {
  ok: boolean;
  /** Time spent inside snarkjs verify (worker-measured); the timeout value when timed out. */
  ms: number;
  timedOut: boolean;
  error: string | null;
}

/** Anything that can verify a proof (the pool, or a fake in unit tests). */
export interface Verifier {
  verify(publicSignals: string[], proof: unknown): Promise<VerifyOutcome>;
}

interface Job {
  id: number;
  publicSignals: string[];
  proof: unknown;
  resolve: (o: VerifyOutcome) => void;
  queuedAt: number;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

/** Process-wide verify-time samples (ms, inside the worker) — NFR-4. */
export const verifyTiming = new TimingStats();

const WORKER_URL = new URL('./verifyWorker.mjs', import.meta.url);

export class VerifierPool implements Verifier {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly vkeyPath: string,
    private readonly scheme: Scheme,
    size: number,
    private readonly timeoutMs: number,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  /** Resolves once every worker has loaded its vkey and warmed up. */
  async ready(): Promise<void> {
    await Promise.all(
      this.slots.map(
        (s) =>
          new Promise<void>((res) => {
            if (s.ready) return res();
            const on = (m: { ready?: boolean }) => {
              if (m.ready) {
                s.worker.off('message', on);
                res();
              }
            };
            s.worker.on('message', on);
          }),
      ),
    );
  }

  verify(publicSignals: string[], proof: unknown): Promise<VerifyOutcome> {
    if (this.closed) return Promise.resolve({ ok: false, ms: 0, timedOut: false, error: 'closed' });
    return new Promise((resolve) => {
      this.queue.push({
        id: this.nextId++,
        publicSignals,
        proof,
        resolve,
        queuedAt: performance.now(),
      });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const j of this.queue.splice(0))
      j.resolve({ ok: false, ms: 0, timedOut: false, error: 'closed' });
    await Promise.all(
      this.slots.map(async (s) => {
        if (s.timer) clearTimeout(s.timer);
        s.job?.resolve({ ok: false, ms: 0, timedOut: false, error: 'closed' });
        await s.worker.terminate();
      }),
    );
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      workerData: { vkeyPath: this.vkeyPath, scheme: this.scheme },
    });
    const slot: Slot = { worker, ready: false, job: null, timer: null };
    worker.on(
      'message',
      (m: { ready?: boolean; id?: number; ok?: boolean; ms?: number; error?: string | null }) => {
        if (m.ready) {
          slot.ready = true;
          return this.dispatch();
        }
        const job = slot.job;
        if (!job || m.id !== job.id) return;
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = null;
        slot.job = null;
        verifyTiming.record(m.ms ?? 0);
        job.resolve({ ok: m.ok === true, ms: m.ms ?? 0, timedOut: false, error: m.error ?? null });
        this.dispatch();
      },
    );
    worker.on('error', () => this.replace(slot, 'worker error'));
    // a worker that dies without an 'error' event must not leave its job pending forever
    worker.on('exit', () => this.replace(slot, 'worker exited'));
    return slot;
  }

  private replace(slot: Slot, error: string): void {
    if (this.closed) return;
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.job?.resolve({ ok: false, ms: this.timeoutMs, timedOut: error === 'timeout', error });
    void slot.worker.terminate();
    this.slots[i] = this.spawn();
  }

  private dispatch(): void {
    for (const s of this.slots) {
      if (!s.ready || s.job || !this.queue.length) continue;
      const job = this.queue.shift() as Job;
      s.job = job;
      s.timer = setTimeout(() => this.replace(s, 'timeout'), this.timeoutMs);
      s.worker.postMessage({ id: job.id, publicSignals: job.publicSignals, proof: job.proof });
    }
  }
}
