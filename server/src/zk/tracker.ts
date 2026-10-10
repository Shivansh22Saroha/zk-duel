/**
 * ProofTracker (ARCHITECTURE §4, API_SPEC §5): per match, for both players —
 *  - one slot per window: server digest, the CLAIMED commitOut from window_commit, status;
 *  - commit deadline (one window of play after the window ended) → missing_commit + chain_broken;
 *  - challenge scheduler: one outstanding challenge per player, drawn with crypto randomness
 *    among the player's ended, digest-final, still-`committed` windows of the current round;
 *  - verification pipeline against the claimed commitments, in any window order;
 *  - post-match audit: accepts proofs for committed windows until AUDIT_TIMEOUT_MIN, then closes
 *    (unaudited, audit_status, overturned, research metrics).
 * Pure logic + injected clock/verifier/store/random — unit-tested with fakes.
 */
import { randomInt } from 'node:crypto';
import { TICK_RATE, type PlayerIndex, type Scheme } from '@zkduel/shared/constants';
import {
  FAILURE_STATUSES,
  type AuditStatus,
  type ProofFailedMessage,
  type ProofStatus,
  type ServerMessage,
  type WindowProofMessage,
} from '@zkduel/shared/protocol';
import { bindOf, namePublicSignals, type PublicSignalName } from '@zkduel/shared/zkInput';
import type { Verifier } from './verifierPool';

export interface WindowRow {
  matchId: string;
  playerIndex: PlayerIndex;
  roundNo: number;
  windowIndex: number;
  startTick: number;
  status: ProofStatus;
  digest: string | null;
  challenged: boolean;
  challengedAt: number | null;
  decidedPhase: 'live' | 'audit' | null;
  failReason: string | null;
  commitIn: string | null;
  commitOut: string | null;
  proveMs: number | null;
  verifyMs: number | null;
  proofBytes: number | null;
  receivedAt: number | null;
  proofJson: string | null;
}

export interface PlayerAuditMetrics {
  windows: number;
  windowsCommitted: number;
  challenges: number;
  challengesPassed: number;
  challengeRate: number | null;
  auditMs: number | null;
  counts: { valid: number; failed: number; unaudited: number; chainBroken: number };
}

export interface AuditSummary {
  matchId: string;
  auditStatus: AuditStatus | null;
  overturned: boolean;
  endedAt: number;
  players: [PlayerAuditMetrics, PlayerAuditMetrics];
}

export interface ProofStore {
  upsertWindow(row: WindowRow): void;
  setAuditing(matchId: string): void;
  finishAudit(s: AuditSummary): void;
}

export interface TrackerOptions {
  matchId: string;
  matchField: string;
  initialCommit: string;
  scheme: Scheme;
  windowTicks: number;
  enforcement: 'observe' | 'strict';
  publicSignalOrder: readonly PublicSignalName[];
  proofDeadlineMs: number;
  auditTimeoutMs: number;
  storeProofs: boolean;
}

export interface TrackerDeps {
  verifier: Verifier;
  store: ProofStore;
  /** Wall clock in ms (server: performance.now; persisted timestamps use `epoch`). */
  now: () => number;
  epoch: () => number;
  send: (p: PlayerIndex, m: ServerMessage) => void;
  /** strict mode: a live failure of player p. */
  onLiveFailure: (
    p: PlayerIndex,
    roundNo: number,
    windowIndex: number,
    status: ProofStatus,
  ) => void;
  onAuditClosed: (s: AuditSummary) => void;
  /** Uniform integer in [0, n) — crypto.randomInt by default (unpredictable to clients). */
  random?: (n: number) => number;
}

interface Slot {
  p: PlayerIndex;
  roundNo: number;
  k: number;
  endedAt: number | null;
  digest: string | null;
  commitOut: string | null;
  /** null = not yet decided (window not ended, or ended and waiting for its commit). */
  status: ProofStatus | null;
  challenged: boolean;
  challengedAt: number | null;
  verifying: boolean;
  decidedPhase: 'live' | 'audit' | null;
  decidedAt: number | null;
  failReason: string | null;
  proveMs: number | null;
  verifyMs: number | null;
  proofBytes: number | null;
  receivedAt: number | null;
  proofJson: string | null;
}

interface Challenge {
  slot: Slot;
  deadline: number;
}

const FAILURES: ReadonlySet<ProofStatus> = new Set(FAILURE_STATUSES);
export const isFailure = (s: ProofStatus | null): boolean => s !== null && FAILURES.has(s);

const keyOf = (p: number, r: number, k: number): string => `${p}:${r}:${k}`;

export class ProofTracker {
  private readonly slots = new Map<string, Slot>();
  private readonly outstanding: [Challenge | null, Challenge | null] = [null, null];
  /** Round → first window index from which the chain is broken, per player. */
  private readonly brokenFrom: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  private readonly challengesIssued: [number, number] = [0, 0];
  private auditing = false;
  private winner: PlayerIndex | null = null;
  private auditStart = 0;
  private auditDeadline = 0;
  private closed = false;
  private readonly windowMs: number;
  private readonly random: (n: number) => number;

  constructor(
    private readonly o: TrackerOptions,
    private readonly d: TrackerDeps,
  ) {
    this.windowMs = (o.windowTicks * 1000) / TICK_RATE;
    this.random = d.random ?? ((n) => randomInt(n));
  }

  /** Diagnostics (tests). */
  debugState(): Record<string, unknown> {
    const by: Record<string, number> = {};
    for (const s of this.slots.values()) {
      const k = `p${s.p}:${s.status ?? (s.endedAt === null ? 'open' : 'awaiting_commit')}${s.verifying ? '+verifying' : ''}${s.digest === null ? '+nodigest' : ''}`;
      by[k] = (by[k] ?? 0) + 1;
    }
    return {
      auditing: this.auditing,
      closed: this.closed,
      outstanding: this.outstanding.map((c) => (c ? `${c.slot.roundNo}:${c.slot.k}` : null)),
      slots: by,
    };
  }

  get isAuditing(): boolean {
    return this.auditing && !this.closed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------- events from the room

  /** Window k of round r has ended on the server (both players). Idempotent. */
  windowEnded(roundNo: number, k: number): void {
    const now = this.d.now();
    for (const p of [0, 1] as const) {
      const s = this.slot(p, roundNo, k);
      if (s.endedAt !== null) continue;
      s.endedAt = now;
      if (this.isBroken(p, roundNo, k)) this.decide(s, 'chain_broken');
    }
  }

  /** DigestBuilder finalised p's digest for window k of round r. */
  digestFinal(p: PlayerIndex, roundNo: number, k: number, digest: string): void {
    const s = this.slot(p, roundNo, k);
    if (s.digest !== null) return;
    s.digest = digest;
    if (s.status !== null) this.persist(s);
  }

  /** window_commit. Returns false when the commit was dropped. */
  commit(p: PlayerIndex, roundNo: number, k: number, commitOut: string): boolean {
    if (this.closed) return false;
    const s = this.slots.get(keyOf(p, roundNo, k));
    if (!s || s.endedAt === null || s.status !== null || s.commitOut !== null) return false;
    s.commitOut = commitOut;
    this.decide(s, 'committed');
    return true;
  }

  /** The player's socket closed during a live round; `firstMissingTick` = lastReceived + 1. */
  disconnect(p: PlayerIndex, roundNo: number, firstMissingTick: number): void {
    this.breakChain(p, roundNo, Math.floor(firstMissingTick / this.o.windowTicks));
  }

  /** Is the chain of p broken at window k of round r? */
  isBroken(p: PlayerIndex, roundNo: number, k: number): boolean {
    const b = this.brokenFrom[p].get(roundNo);
    return b !== undefined && k >= b;
  }

  /** For `resume`: commits held for the round, and the outstanding challenge. */
  resumeInfo(
    p: PlayerIndex,
    roundNo: number,
  ): {
    committed: number[];
    broken: boolean;
    challenge: { roundNo: number; windowIndex: number; deadlineMs: number } | null;
  } {
    const committed: number[] = [];
    for (const s of this.slots.values()) {
      if (s.p === p && s.roundNo === roundNo && s.commitOut !== null) committed.push(s.k);
    }
    committed.sort((a, b) => a - b);
    const c = this.outstanding[p];
    return {
      committed,
      broken: this.brokenFrom[p].has(roundNo),
      challenge: c
        ? {
            roundNo: c.slot.roundNo,
            windowIndex: c.slot.k,
            deadlineMs: Math.max(0, Math.round(c.deadline - this.d.now())),
          }
        : null,
    };
  }

  /** May player p send a proof for this window now? (outstanding challenge, or audit) */
  private acceptsProof(p: PlayerIndex, roundNo: number, k: number): Slot | null {
    if (this.closed) return null;
    const s = this.slots.get(keyOf(p, roundNo, k));
    if (!s || s.status !== 'committed' || s.verifying) return null;
    const c = this.outstanding[p];
    if (c && c.slot === s) return s;
    return this.auditing ? s : null;
  }

  /** A proof whose body failed the schema (header was attributable) → malformed. */
  malformed(p: PlayerIndex, roundNo: number, k: number, reason: string): void {
    const s = this.acceptsProof(p, roundNo, k);
    if (!s) return;
    s.receivedAt = this.d.epoch();
    s.failReason = reason.slice(0, 200);
    this.decide(s, 'malformed');
  }

  proofFailed(p: PlayerIndex, m: ProofFailedMessage): void {
    const s = this.acceptsProof(p, m.roundNo, m.windowIndex);
    if (!s) return;
    s.receivedAt = this.d.epoch();
    s.failReason = m.reason;
    this.decide(s, 'unprovable');
  }

  /** Verification pipeline (API_SPEC §5): malformed → bind → digest → commitIn → commitOut → verify. */
  async proof(p: PlayerIndex, m: WindowProofMessage): Promise<void> {
    const s = this.acceptsProof(p, m.roundNo, m.windowIndex);
    if (!s) return;
    s.verifying = true;
    s.receivedAt = this.d.epoch();
    s.proveMs = Math.round(m.proveMs);
    const json = JSON.stringify(m.proof);
    s.proofBytes = json.length;
    if (this.o.storeProofs) s.proofJson = json;
    const done = (st: ProofStatus) => {
      s.verifying = false;
      // the window may have been decided meanwhile (e.g. a disconnect broke the chain)
      if (s.status === 'committed') this.decide(s, st);
    };
    try {
      if (m.scheme !== this.o.scheme) return done('malformed');
      const sig = namePublicSignals(this.o.publicSignalOrder, m.publicSignals);
      const bind = await bindOf(this.o.matchField, p, s.roundNo, s.k);
      if (sig.bind !== bind) return done('mismatch_bind');
      if (s.digest === null || sig.digest !== s.digest) return done('mismatch_digest');
      if (sig.commitIn !== this.claimedIn(s)) return done('mismatch_commit');
      if (sig.commitOut !== s.commitOut) return done('mismatch_commit');
      const v = await this.d.verifier.verify(m.publicSignals, m.proof);
      s.verifyMs = v.ms;
      if (v.error) s.failReason = v.error;
      done(v.ok ? 'valid' : 'invalid');
    } catch (e) {
      // never leave a window stuck in "verifying" (it would block the audit until its timeout)
      s.failReason = String(e).slice(0, 200);
      done('malformed');
    }
  }

  // ---------------------------------------------------------------- clock (60 Hz)

  /** Deadlines, challenge draws and the audit close. `round` = the current round (null = none). */
  tick(round: number | null): void {
    if (this.closed) return;
    const now = this.d.now();
    for (const s of this.slots.values()) {
      if (s.status === null && s.endedAt !== null && now >= s.endedAt + this.windowMs) {
        this.decide(s, 'missing_commit');
        this.breakChain(s.p, s.roundNo, s.k + 1);
      }
    }
    for (const p of [0, 1] as const) {
      const c = this.outstanding[p];
      if (c && !c.slot.verifying && c.slot.status === 'committed' && now >= c.deadline) {
        this.decide(c.slot, 'timeout');
      }
      if (!this.outstanding[p] && !this.auditing && round !== null) this.challenge(p, round, now);
    }
    if (this.auditing && (now >= this.auditDeadline || this.auditComplete())) this.closeAudit();
  }

  /** match_end: the audit starts now. `winner` decides `overturned` (winner's audit failed). */
  startAudit(winner: PlayerIndex | null): void {
    if (this.auditing || this.closed) return;
    this.winner = winner;
    this.auditing = true;
    this.auditStart = this.d.now();
    this.auditDeadline = this.auditStart + this.o.auditTimeoutMs;
    if (this.slots.size === 0) return this.closeAudit();
    this.d.store.setAuditing(this.o.matchId);
  }

  // ---------------------------------------------------------------- internals

  private slot(p: PlayerIndex, roundNo: number, k: number): Slot {
    const key = keyOf(p, roundNo, k);
    let s = this.slots.get(key);
    if (!s) {
      s = {
        p,
        roundNo,
        k,
        endedAt: null,
        digest: null,
        commitOut: null,
        status: null,
        challenged: false,
        challengedAt: null,
        verifying: false,
        decidedPhase: null,
        decidedAt: null,
        failReason: null,
        proveMs: null,
        verifyMs: null,
        proofBytes: null,
        receivedAt: null,
        proofJson: null,
      };
      this.slots.set(key, s);
    }
    return s;
  }

  /** Claimed commitment entering window k: claimed commitOut of k−1, or the round's initialCommit. */
  private claimedIn(s: Slot): string | null {
    if (s.k === 0) return this.o.initialCommit;
    return this.slots.get(keyOf(s.p, s.roundNo, s.k - 1))?.commitOut ?? null;
  }

  private breakChain(p: PlayerIndex, roundNo: number, fromK: number): void {
    const cur = this.brokenFrom[p].get(roundNo);
    if (cur !== undefined && cur <= fromK) return;
    this.brokenFrom[p].set(roundNo, fromK);
    for (const s of this.slots.values()) {
      if (s.p !== p || s.roundNo !== roundNo || s.k < fromK || s.endedAt === null) continue;
      if (s.status === null || s.status === 'committed') this.decide(s, 'chain_broken');
    }
  }

  private challenge(p: PlayerIndex, round: number, now: number): void {
    const pool: Slot[] = [];
    for (const s of this.slots.values()) {
      if (
        s.p === p &&
        s.roundNo === round &&
        s.status === 'committed' &&
        s.digest !== null &&
        !s.verifying
      ) {
        pool.push(s);
      }
    }
    if (!pool.length) return;
    const s = pool[this.random(pool.length)] as Slot;
    s.challenged = true;
    s.challengedAt = this.d.epoch();
    this.outstanding[p] = { slot: s, deadline: now + this.o.proofDeadlineMs };
    this.challengesIssued[p]++;
    this.persist(s);
    const msg: ServerMessage = {
      t: 'challenge',
      playerIndex: p,
      roundNo: s.roundNo,
      windowIndex: s.k,
      deadlineMs: this.o.proofDeadlineMs,
    };
    this.d.send(0, msg);
    this.d.send(1, msg);
  }

  private decide(s: Slot, status: ProofStatus): void {
    s.status = status;
    if (status !== 'committed') {
      s.decidedPhase = this.auditing ? 'audit' : 'live';
      s.decidedAt = this.d.now();
    }
    const c = this.outstanding[s.p];
    if (c && c.slot === s && status !== 'committed') this.outstanding[s.p] = null;
    this.persist(s);
    const msg: ServerMessage = {
      t: 'proof_result',
      matchId: this.o.matchId,
      playerIndex: s.p,
      roundNo: s.roundNo,
      windowIndex: s.k,
      status,
      verifyMs: s.verifyMs,
      phase: this.auditing ? 'audit' : 'live',
    };
    this.d.send(0, msg);
    this.d.send(1, msg);
    if (!this.auditing && isFailure(status) && this.o.enforcement === 'strict') {
      this.d.onLiveFailure(s.p, s.roundNo, s.k, status);
    }
  }

  private persist(s: Slot): void {
    if (s.status === null) return;
    this.d.store.upsertWindow({
      matchId: this.o.matchId,
      playerIndex: s.p,
      roundNo: s.roundNo,
      windowIndex: s.k,
      startTick: s.k * this.o.windowTicks,
      status: s.status,
      digest: s.digest,
      challenged: s.challenged,
      challengedAt: s.challengedAt,
      decidedPhase: s.decidedPhase,
      failReason: s.failReason,
      commitIn: s.commitOut !== null ? this.claimedIn(s) : null,
      commitOut: s.commitOut,
      proveMs: s.proveMs,
      verifyMs: s.verifyMs,
      proofBytes: s.proofBytes,
      receivedAt: s.receivedAt,
      proofJson: s.proofJson,
    });
  }

  private auditComplete(): boolean {
    if (this.outstanding[0] || this.outstanding[1]) return false;
    for (const s of this.slots.values()) {
      if (s.endedAt === null) continue; // window never ended (match ended mid-window)
      if (s.status === null || s.status === 'committed' || s.verifying) return false;
    }
    return true;
  }

  private closeAudit(): void {
    if (this.closed) return;
    const now = this.d.now();
    for (const s of this.slots.values()) {
      if (s.endedAt === null) continue;
      if (s.status === 'committed' || s.status === null) {
        s.verifying = false;
        this.decide(s, s.status === null ? 'missing_commit' : 'unaudited');
      }
    }
    this.outstanding[0] = null;
    this.outstanding[1] = null;
    this.closed = true;
    const players = ([0, 1] as const).map((p) => this.metrics(p, now)) as [
      PlayerAuditMetrics,
      PlayerAuditMetrics,
    ];
    const any = players.some((m) => m.windows > 0);
    const failed = players.some((m) => m.counts.failed > 0);
    const incomplete = players.some((m) => m.counts.unaudited > 0 || m.counts.chainBroken > 0);
    const summary: AuditSummary = {
      matchId: this.o.matchId,
      auditStatus: !any
        ? null
        : failed
          ? 'audited_failed'
          : incomplete
            ? 'audit_incomplete'
            : 'audited_clean',
      overturned: this.winner !== null && players[this.winner].counts.failed > 0,
      endedAt: this.d.epoch(),
      players,
    };
    this.d.store.finishAudit(summary);
    const counts = ([0, 1] as const).map((p) => players[p].counts) as [
      PlayerAuditMetrics['counts'],
      PlayerAuditMetrics['counts'],
    ];
    if (summary.auditStatus) {
      const msg: ServerMessage = {
        t: 'audit_end',
        matchId: this.o.matchId,
        auditStatus: summary.auditStatus,
        overturned: summary.overturned,
        players: counts,
      };
      this.d.send(0, msg);
      this.d.send(1, msg);
    }
    this.d.onAuditClosed(summary);
  }

  private metrics(p: PlayerIndex, now: number): PlayerAuditMetrics {
    const counts = { valid: 0, failed: 0, unaudited: 0, chainBroken: 0 };
    let windows = 0;
    let windowsCommitted = 0;
    let passed = 0;
    let lastAudit = 0;
    for (const s of this.slots.values()) {
      if (s.p !== p || s.endedAt === null) continue;
      windows++;
      if (s.commitOut !== null) windowsCommitted++;
      if (s.status === 'valid') counts.valid++;
      else if (s.status === 'unaudited') counts.unaudited++;
      else if (s.status === 'chain_broken') counts.chainBroken++;
      else if (isFailure(s.status)) counts.failed++;
      if (s.challenged && s.status === 'valid') passed++;
      if (s.decidedPhase === 'audit' && s.decidedAt !== null && s.status !== 'unaudited') {
        lastAudit = Math.max(lastAudit, s.decidedAt);
      }
    }
    const issued = this.challengesIssued[p];
    return {
      windows,
      windowsCommitted,
      challenges: issued,
      challengesPassed: passed,
      challengeRate: windowsCommitted > 0 ? issued / windowsCommitted : null,
      auditMs: Math.round(
        (counts.unaudited > 0 ? now : Math.max(lastAudit, this.auditStart)) - this.auditStart,
      ),
      counts,
    };
  }
}
