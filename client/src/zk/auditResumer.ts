/**
 * Resumes a post-match audit after a page reload (Phase 3 follow-up). The windows' private inputs
 * come from IndexedDB (auditStore); the server's window list says which of them are still
 * `committed`; those are proven one at a time and sent as window_proof (matchId-routed, accepted
 * until the audit closes). Exposes the same audit-progress surface as ProofClient for the results
 * screen. DOM-free apart from its inputs.
 */
import type { PlayerIndex, Scheme } from '@zkduel/shared/constants';
import type { AuditStatus, ClientFrame, ProofStatus, ServerMessage } from '@zkduel/shared/protocol';
import type { JobStore } from './jobStore';
import { MIN_PROOF_GAP_MS, proofMessageFor, type Prover, type WindowView } from './proofClient';
import type { WindowJob } from './recorder';

/** What the results screen reads (ProofClient and AuditResumer both provide it). */
export interface AuditProgress {
  readonly auditing: boolean;
  readonly auditDone: boolean;
  readonly auditStatus: AuditStatus | null;
  readonly overturned: boolean;
  readonly auditTotal: number;
  readonly auditProven: number;
  recent(p: PlayerIndex, n: number): WindowView[];
  onChange(fn: () => void): () => void;
}

export interface ServerWindowRow {
  playerIndex: number;
  roundNo: number;
  windowIndex: number;
  status: string;
  challenged: boolean;
  proveMs: number | null;
  verifyMs: number | null;
}

const key = (p: number, r: number, k: number): string => `${p}:${r}:${k}`;

export class AuditResumer implements AuditProgress {
  readonly resumed = true;
  auditing = true;
  auditDone = false;
  auditStatus: AuditStatus | null = null;
  overturned = false;
  auditTotal = 0;
  auditProven = 0;
  lastProveMs: number | null = null;

  private readonly windows = new Map<string, WindowView>();
  private readonly queue: WindowJob[] = [];
  private readonly sent = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private busy = false;
  private lastSentAt = -Infinity;
  private disposed = false;

  constructor(
    readonly matchId: string,
    private readonly me: PlayerIndex,
    private readonly scheme: Scheme,
    jobs: WindowJob[],
    serverWindows: ServerWindowRow[],
    private readonly o: {
      prover: Prover;
      send: (m: ClientFrame) => void;
      now: () => number;
      store: JobStore | null;
    },
  ) {
    for (const r of serverWindows) {
      this.windows.set(key(r.playerIndex, r.roundNo, r.windowIndex), {
        playerIndex: r.playerIndex as PlayerIndex,
        roundNo: r.roundNo,
        windowIndex: r.windowIndex,
        status: r.status as ProofStatus,
        challenged: r.challenged,
        proving: false,
        proveMs: r.proveMs,
        verifyMs: r.verifyMs,
      });
    }
    for (const j of jobs.sort((a, b) => a.roundNo - b.roundNo || a.windowIndex - b.windowIndex)) {
      const st = this.windows.get(key(me, j.roundNo, j.windowIndex))?.status;
      if (st === 'committed') this.queue.push(j);
      else if (st !== undefined) this.o.store?.deleteJob(matchId, j.roundNo, j.windowIndex); // decided
    }
    this.auditTotal = this.queue.length;
  }

  /** Start proving (call once the socket is connected). */
  start(): void {
    this.pump();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(p: PlayerIndex, n: number): WindowView[] {
    return [...this.windows.values()]
      .filter((w) => w.playerIndex === p)
      .sort((a, b) => a.roundNo - b.roundNo || a.windowIndex - b.windowIndex)
      .slice(-n);
  }

  /** After a reconnect: re-prove anything sent on the dead socket that is still committed. */
  onReconnected(): void {
    for (const k of this.sent) {
      const w = this.windows.get(k);
      if (w?.status !== 'committed') continue;
      this.sent.delete(k);
      const j = this.queueBack.get(k);
      if (j) this.queue.push(j);
    }
    this.pump();
  }

  private readonly queueBack = new Map<string, WindowJob>();

  handle(m: ServerMessage): void {
    if (this.disposed) return;
    if (m.t === 'proof_result' && m.matchId === this.matchId) {
      const k = key(m.playerIndex, m.roundNo, m.windowIndex);
      const w = this.windows.get(k);
      const was = w?.status;
      if (w) {
        w.status = m.status;
        w.verifyMs = m.verifyMs;
        w.proving = false;
      }
      if (m.playerIndex === this.me && was === 'committed' && m.status !== 'committed') {
        this.auditProven++;
        this.o.store?.deleteJob(this.matchId, m.roundNo, m.windowIndex);
      }
      this.emit();
    } else if (m.t === 'audit_end' && m.matchId === this.matchId) {
      this.auditing = false;
      this.auditDone = true;
      this.auditStatus = m.auditStatus;
      this.overturned = m.overturned;
      this.queue.length = 0;
      this.o.store?.deleteMatch(this.matchId);
      this.emit();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.o.prover.dispose();
    this.listeners.clear();
  }

  private pump(): void {
    if (this.busy || this.disposed) return;
    const j = this.queue.shift();
    if (!j) return;
    const k = key(this.me, j.roundNo, j.windowIndex);
    if (this.windows.get(k)?.status !== 'committed' || this.sent.has(k)) return this.pump();
    this.busy = true;
    void this.proveOne(k, j).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private async proveOne(k: string, j: WindowJob): Promise<void> {
    const w = this.windows.get(k);
    if (w) w.proving = true;
    this.emit();
    const r = await this.o.prover.prove(j);
    if (this.disposed) return;
    if (r.ok) {
      this.lastProveMs = r.proveMs;
      if (w) w.proveMs = Math.round(r.proveMs);
    }
    const wait = this.lastSentAt + MIN_PROOF_GAP_MS - this.o.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (this.disposed) return;
    this.lastSentAt = this.o.now();
    this.sent.add(k);
    this.queueBack.set(k, j);
    this.o.send(proofMessageFor(this.matchId, this.scheme, j.roundNo, j.windowIndex, r));
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
