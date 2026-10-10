/**
 * ProofClient (ARCHITECTURE §4, FEATURES F9): the client half of "commit every window, prove on
 * challenge, audit after the match". DOM-free — the browser (Web Worker prover) and the Node bots
 * (worker_threads prover) both use it.
 *
 *  - commits: freezes final windows (WindowRecorder) and sends window_commit{commitOut};
 *  - keeps every window's private input until the audit ends;
 *  - Proof Queue: the challenged window first, then — after match_end — every window the server
 *    still has as `committed`, in window order; one proof at a time;
 *  - tracks every window's status for both players (HUD strip, spot-check counter, audit progress).
 *
 * Only commitments, proofs and public signals ever leave this class (frame-inspector test).
 */
import { RATE_LIMIT_PROOFS_PER_S, type PlayerIndex, type Scheme } from '@zkduel/shared/constants';
import {
  FAILURE_STATUSES,
  type AuditStatus,
  type ClientFrame,
  type ProofStatus,
  type ServerMessage,
  type WindowProofMessage,
} from '@zkduel/shared/protocol';
import type { Groth16Proof } from 'snarkjs';
import type { GameSession, TickLogSink } from '../game/session';
import type { JobStore } from './jobStore';
import { WindowRecorder, type WindowJob } from './recorder';

export type ProveOutcome =
  | { ok: true; proof: Groth16Proof; publicSignals: string[]; witnessMs: number; proveMs: number }
  | { ok: false; reason: string };

/** Proves one frozen window (browser: Web Worker; Node: worker_threads). */
export interface Prover {
  prove(job: WindowJob): Promise<ProveOutcome>;
  dispose(): void;
}

/** Test-only behaviour switches (scripted misbehaving clients in integration tests). */
export interface ProofClientHooks {
  /** Do not commit this window. */
  skipCommit?: (roundNo: number, windowIndex: number) => boolean;
  /** Never answer challenges or audit (a silent cheater). */
  silent?: boolean;
  /** Rewrite (or drop, by returning null) an outgoing window_proof. n = 0-based proof count. */
  mutateProof?: (m: WindowProofMessage, n: number) => WindowProofMessage | null;
}

export interface ProofClientOptions {
  send: (m: ClientFrame) => void;
  prover: Prover;
  scheme: Scheme;
  now: () => number;
  log?: TickLogSink;
  hooks?: ProofClientHooks;
  /** Salt source for tests; crypto randomness otherwise. */
  salt?: () => string;
  /** Local persistence of unproven windows (browser: IndexedDB) so the audit survives a reload. */
  store?: JobStore | null;
}

export interface WindowView {
  playerIndex: PlayerIndex;
  roundNo: number;
  windowIndex: number;
  status: ProofStatus | 'pending';
  challenged: boolean;
  /** Own windows: being proven right now. */
  proving: boolean;
  proveMs: number | null;
  verifyMs: number | null;
}

const FAILURES: ReadonlySet<string> = new Set(FAILURE_STATUSES);
const key = (p: number, r: number, k: number): string => `${p}:${r}:${k}`;
/** Leave a little headroom under the server's window_proof rate limit. */
export const MIN_PROOF_GAP_MS = 1000 / RATE_LIMIT_PROOFS_PER_S + 20;

/** The message for one proving outcome: window_proof, or proof_failed (no witness: a rule broke). */
export function proofMessageFor(
  matchId: string,
  scheme: Scheme,
  roundNo: number,
  windowIndex: number,
  r: ProveOutcome,
): ClientFrame {
  return r.ok
    ? {
        t: 'window_proof',
        matchId,
        roundNo,
        windowIndex,
        scheme,
        proof: r.proof as WindowProofMessage['proof'],
        publicSignals: r.publicSignals,
        proveMs: Math.round(r.proveMs),
      }
    : { t: 'proof_failed', matchId, roundNo, windowIndex, reason: r.reason.slice(0, 200) };
}

export class ProofClient {
  readonly windows = new Map<string, WindowView>();
  readonly jobs = new Map<string, WindowJob>();
  auditing = false;
  auditDone = false;
  auditStatus: AuditStatus | null = null;
  overturned = false;
  /** Own windows that still had to be proven when the audit started (+ later commits). */
  auditTotal = 0;
  auditProven = 0;
  lastProveMs: number | null = null;
  lastWitnessMs: number | null = null;

  private recorder: WindowRecorder | null = null;
  private matchId = '';
  private me: PlayerIndex = 0;
  private roundRecords: { roundNo: number; records: GameSession['records'] } | null = null;
  private freezing = false;
  private nextPrev: [number, number, number, number] | null = null;
  private challenge: string | null = null;
  private readonly auditQueue: string[] = [];
  private busy = false;
  private lastSentAt = -Infinity;
  private proofsSent = 0;
  /** Test hook bookkeeping: proofs handed to mutateProof, and windows it chose to drop. */
  private mutations = 0;
  private readonly abandoned = new Set<string>();
  /** Windows whose proof (or proof_failed) was sent and whose result has not arrived yet. */
  private readonly sent = new Set<string>();
  /** The last proof sent for the outstanding challenge (re-sent after a reconnect). */
  private lastChallengeProof: ClientFrame | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  private disposed = false;

  constructor(
    private readonly session: GameSession,
    private readonly o: ProofClientOptions,
  ) {
    this.off = session.onMessage((m) => this.handle(m));
    // created right after match_found (browser: once the match is known): pick it up
    if (session.match) this.handle(session.match);
  }

  /** UI subscription: called after every status change. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.off();
    this.o.prover.dispose();
    this.jobs.clear();
    this.listeners.clear();
  }

  /** Diagnostics (tests / dev console). */
  debugState(): Record<string, unknown> {
    const mine: Record<string, number> = {};
    for (const w of this.windows.values())
      if (w.playerIndex === this.me) mine[w.status] = (mine[w.status] ?? 0) + 1;
    return {
      me: this.me,
      auditing: this.auditing,
      auditDone: this.auditDone,
      busy: this.busy,
      challenge: this.challenge,
      queue: this.auditQueue.length,
      jobs: this.jobs.size,
      auditTotal: this.auditTotal,
      auditProven: this.auditProven,
      mine,
    };
  }

  /** Spot-checks for player p: challenges decided valid / challenges decided. */
  spotChecks(p: PlayerIndex): { passed: number; decided: number; pending: number } {
    let passed = 0;
    let decided = 0;
    let pending = 0;
    for (const w of this.windows.values()) {
      if (w.playerIndex !== p || !w.challenged) continue;
      if (w.status === 'committed' || w.status === 'pending') pending++;
      else {
        decided++;
        if (w.status === 'valid') passed++;
      }
    }
    return { passed, decided, pending };
  }

  /** The last `n` windows of player p across the match, oldest first (HUD strip). */
  recent(p: PlayerIndex, n: number): WindowView[] {
    return [...this.windows.values()]
      .filter((w) => w.playerIndex === p)
      .sort((a, b) => a.roundNo - b.roundNo || a.windowIndex - b.windowIndex)
      .slice(-n);
  }

  /**
   * The socket was re-established: proofs sent on the old socket may be lost. Windows the server
   * still has as committed are proven again (during play the `resume` message covers the
   * outstanding challenge; this matters for the audit, which gets no resume).
   */
  onReconnected(): void {
    for (const k of this.sent) {
      if (this.windows.get(k)?.status !== 'committed') continue;
      this.sent.delete(k);
      if (this.auditing && k !== this.challenge) this.enqueueAudit(k);
    }
    this.pump();
  }

  /** Call after every GameSession.update(): commits windows that became final. */
  poll(): void {
    void this.freeze();
  }

  // ---------------------------------------------------------------- server messages

  private handle(m: ServerMessage): void {
    if (this.disposed) return;
    const g = this.session;
    switch (m.t) {
      case 'match_found':
        this.matchId = m.matchId;
        this.me = m.playerIndex;
        this.recorder = new WindowRecorder(m.matchField, m.playerIndex, m.windowTicks, this.o.salt);
        this.nextPrev = m.prevSnapshot;
        this.o.store?.putMatch({
          matchId: m.matchId,
          playerIndex: m.playerIndex,
          scheme: m.scheme,
          variant: m.variant,
          windowTicks: m.windowTicks,
          auditUntil: null,
        });
        break;
      case 'start':
        this.recorder?.startRound(m.roundNo, this.nextPrev ?? [0, 0, 0, 0]);
        this.roundRecords = { roundNo: m.roundNo, records: g.records };
        break;
      case 'state':
        if (m.phase === 'live') void this.freeze();
        break;
      case 'round_end':
        this.nextPrev = m.prevSnapshot;
        this.recorder?.endRound(m.roundNo, m.endTick);
        void this.freeze();
        break;
      case 'challenge':
        this.view(m.playerIndex, m.roundNo, m.windowIndex).challenged = true;
        if (m.playerIndex === this.me && !this.o.hooks?.silent) {
          this.challenge = key(m.playerIndex, m.roundNo, m.windowIndex);
          this.lastChallengeProof = null;
          this.pump();
        }
        this.emit();
        break;
      case 'proof_result': {
        if (m.matchId !== this.matchId) break;
        const w = this.view(m.playerIndex, m.roundNo, m.windowIndex);
        const was = w.status;
        w.status = m.status;
        w.verifyMs = m.verifyMs;
        const k = key(m.playerIndex, m.roundNo, m.windowIndex);
        if (m.playerIndex === this.me) {
          if (m.status === 'committed' && this.auditing && was !== 'committed') {
            this.auditTotal++;
            this.enqueueAudit(k);
          }
          if (m.status !== 'committed') {
            // decided: its private input is no longer needed anywhere
            if (m.status !== 'unaudited')
              this.o.store?.deleteJob(this.matchId, m.roundNo, m.windowIndex);
            if (this.challenge === k) this.challenge = null;
            if (this.auditing && was === 'committed') this.auditProven++;
          }
        }
        this.emit();
        this.pump();
        break;
      }
      case 'match_end':
        this.auditing = true;
        this.o.store?.setAuditUntil(this.matchId, Date.now() + m.auditTimeoutMs);
        for (const [k, w] of this.windows) {
          if (w.playerIndex !== this.me || w.status !== 'committed') continue;
          this.auditTotal++; // the outstanding challenge counts too (proven first)
          if (k !== this.challenge) this.enqueueAudit(k);
        }
        // the final window may still be in flight: committed results arriving later are queued
        this.emit();
        this.pump();
        break;
      case 'audit_end':
        if (m.matchId !== this.matchId) break;
        this.auditing = false;
        this.auditDone = true;
        this.auditStatus = m.auditStatus;
        this.overturned = m.overturned;
        this.auditQueue.length = 0;
        this.challenge = null;
        this.jobs.clear(); // private inputs are no longer needed
        this.o.store?.deleteMatch(this.matchId);
        this.emit();
        break;
      case 'resume': {
        // re-send commits the server does not hold (if still in time), and the outstanding proof
        if (m.chainStatus === 'broken') this.recorder?.stopRound(m.roundNo);
        else {
          const held = new Set(m.committed);
          for (const j of this.jobs.values()) {
            if (j.roundNo === m.roundNo && !held.has(j.windowIndex)) this.sendCommit(j);
          }
        }
        if (m.challenge) {
          const k = key(this.me, m.challenge.roundNo, m.challenge.windowIndex);
          if (this.challenge === k && this.lastChallengeProof && !this.busy) {
            this.o.send(this.lastChallengeProof);
          } else if (!this.o.hooks?.silent) {
            this.challenge = k;
            this.pump();
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- commits

  private async freeze(): Promise<void> {
    const rec = this.recorder;
    const rr = this.roundRecords;
    if (this.freezing || !rec || !rr || rr.roundNo !== rec.currentRound) return;
    this.freezing = true;
    try {
      const g = this.session;
      const sameRound = g.roundNo === rr.roundNo;
      const jobs = await rec.freezeReady(
        rr.records,
        sameRound ? g.serverTick : Number.MAX_SAFE_INTEGER,
        sameRound ? g.tick : Number.MAX_SAFE_INTEGER,
      );
      for (const j of jobs) {
        const k = key(this.me, j.roundNo, j.windowIndex);
        this.jobs.set(k, j);
        this.o.store?.putJob(this.matchId, j);
        this.view(this.me, j.roundNo, j.windowIndex);
        this.o.log?.write({
          type: 'window',
          roundNo: j.roundNo,
          windowIndex: j.windowIndex,
          saltIn: j.ctx.saltIn,
          saltOut: j.ctx.saltOut,
          commitOut: j.commitOut,
        });
        if (!this.o.hooks?.skipCommit?.(j.roundNo, j.windowIndex)) this.sendCommit(j);
      }
      if (jobs.length) this.emit();
    } finally {
      this.freezing = false;
    }
  }

  private sendCommit(j: WindowJob): void {
    this.o.send({
      t: 'window_commit',
      roundNo: j.roundNo,
      windowIndex: j.windowIndex,
      commitOut: j.commitOut,
    });
  }

  // ---------------------------------------------------------------- proving

  private enqueueAudit(k: string): void {
    if (this.o.hooks?.silent || this.auditQueue.includes(k) || k === this.challenge) return;
    this.auditQueue.push(k);
    this.auditQueue.sort((a, b) => {
      const [, ra, ka] = a.split(':').map(Number) as [number, number, number];
      const [, rb, kb] = b.split(':').map(Number) as [number, number, number];
      return ra - rb || ka - kb;
    });
  }

  /** Next window to prove: the outstanding challenge first, then the audit queue. */
  private nextJob(): string | null {
    if (
      this.challenge &&
      !this.abandoned.has(this.challenge) &&
      !this.sent.has(this.challenge) &&
      this.windows.get(this.challenge)?.status === 'committed'
    ) {
      return this.challenge;
    }
    while (this.auditQueue.length) {
      const k = this.auditQueue[0] as string;
      if (this.windows.get(k)?.status === 'committed' && !this.sent.has(k)) return k;
      this.auditQueue.shift(); // decided (or already sent) meanwhile
    }
    return null;
  }

  private pump(): void {
    if (this.busy || this.disposed) return;
    const k = this.nextJob();
    if (!k) return;
    if (k !== this.challenge) this.auditQueue.shift();
    this.busy = true;
    void this.proveOne(k).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private async proveOne(k: string): Promise<void> {
    const [, roundNo, windowIndex] = k.split(':').map(Number) as [number, number, number];
    const job = this.jobs.get(k);
    const w = this.windows.get(k);
    if (w) w.proving = true;
    this.emit();
    let msg: ClientFrame;
    if (!job) {
      msg = {
        t: 'proof_failed',
        matchId: this.matchId,
        roundNo,
        windowIndex,
        reason: 'window not recorded on this client',
      };
    } else {
      const r = await this.o.prover.prove(job);
      if (this.disposed) return;
      if (r.ok) {
        this.lastProveMs = r.proveMs;
        this.lastWitnessMs = r.witnessMs;
        if (w) w.proveMs = Math.round(r.proveMs);
        const proof: WindowProofMessage = {
          t: 'window_proof',
          matchId: this.matchId,
          roundNo,
          windowIndex,
          scheme: this.o.scheme,
          proof: r.proof as WindowProofMessage['proof'],
          publicSignals: r.publicSignals,
          proveMs: Math.round(r.proveMs),
        };
        const mutated = this.o.hooks?.mutateProof
          ? this.o.hooks.mutateProof(proof, this.mutations++)
          : proof;
        if (!mutated) {
          this.abandoned.add(k); // a withheld proof: never retried
          if (w) w.proving = false;
          return;
        }
        msg = mutated;
      } else {
        // FR-20: no witness satisfies the circuit (a rule was broken) — say so
        msg = {
          t: 'proof_failed',
          matchId: this.matchId,
          roundNo,
          windowIndex,
          reason: r.reason.slice(0, 200),
        };
      }
    }
    // stay under the server's window_proof rate limit (fast provers, e.g. the N=4 test variant)
    const wait = this.lastSentAt + MIN_PROOF_GAP_MS - this.o.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (this.disposed) return;
    this.lastSentAt = this.o.now();
    this.proofsSent++;
    if (k === this.challenge) this.lastChallengeProof = msg;
    this.sent.add(k); // never prove it again while its result is on the way
    this.o.send(msg);
    if (w) w.proving = false;
    this.emit();
  }

  // ---------------------------------------------------------------- views

  private view(p: PlayerIndex, roundNo: number, windowIndex: number): WindowView {
    const k = key(p, roundNo, windowIndex);
    let w = this.windows.get(k);
    if (!w) {
      w = {
        playerIndex: p,
        roundNo,
        windowIndex,
        status: 'pending',
        challenged: false,
        proving: false,
        proveMs: null,
        verifyMs: null,
      };
      this.windows.set(k, w);
    }
    return w;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const isFailedStatus = (s: string): boolean => FAILURES.has(s);
