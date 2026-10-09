/**
 * One match: ready → countdown → rounds (live ↔ pause) → finished.
 *
 * Tick processing is driven by snapshot arrival: tick t is processed once both players'
 * snapshots for t are in, or once the leading player is STALL_TICKS ahead — then the missing
 * snapshot is "held" (previous snapshot, fired = 0) and that player is `stalled`. The wall
 * clock (onWall, 60 Hz) only drives countdown, pauses, the future-tick bound and timeouts.
 */
import { performance } from 'node:perf_hooks';
import {
  ANGLE_UNITS,
  ARENA_H,
  ARENA_W,
  COUNTDOWN_SECONDS,
  DAMAGE,
  MAX_HP,
  READY_TIMEOUT_MS,
  RECONNECT_TIMEOUT_MS,
  ROUND_PAUSE_TICKS,
  ROUNDS_TO_WIN,
  SPAWNS,
  STALL_TICKS,
  TICK_RATE,
  type PlayerIndex,
  type Scheme,
} from '@zkduel/shared/constants';
import type { EndReason, ServerMessage } from '@zkduel/shared/protocol';
import { spawnSnapshot, toTuple, type PublicSnap } from '@zkduel/shared/sim';
import type { Repo } from '../db/repo';
import type { SnapshotLog } from '../log/snapshotLog';
import { shotHits } from './hit';
import { tickTiming } from './stats';

export interface PlayerLink {
  send(msg: ServerMessage): void;
}

export interface Seat {
  playerId: string;
  displayName: string;
  link: PlayerLink | null;
  ready: boolean;
  disconnectedAt: number | null;
}

export type RoomPhase = 'waiting_ready' | 'countdown' | 'live' | 'pause' | 'finished';

export interface RoomOptions {
  id: string;
  matchField: string;
  initialCommit: string;
  mode: 'queue' | 'private';
  enforcement: 'observe' | 'strict';
  scheme: Scheme;
  windowTicks: number;
  constantsHash: string;
  /** Snapshots may lag the server tick by at most proofGraceWindows × windowTicks. */
  proofGraceWindows: number;
}

export interface RoomDeps {
  repo: Repo;
  log: SnapshotLog;
  /** Monotonic ms clock. */
  now: () => number;
  onFinished: (room: MatchRoom) => void;
}

/** Result of offering a snapshot to the room. */
export type SnapshotVerdict = 'ok' | 'drop' | 'strike_future' | 'strike_late' | 'strike_range';

const MS_PER_TICK = 1000 / TICK_RATE;
const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

export class MatchRoom {
  phase: RoomPhase = 'waiting_ready';
  roundNo = 0;
  readonly score: [number, number] = [0, 0];
  readonly hp: [number, number] = [MAX_HP, MAX_HP];
  readonly shots: [number, number] = [0, 0];
  readonly hits: [number, number] = [0, 0];

  private readonly createdAt: number;
  private countdownStart = 0;
  private lastCountdownSent = -1;
  private roundStartWall = 0;
  private pauseUntil = 0;
  private lastEndTick = 0;
  /** Match-absolute tick at which the current round started. */
  private roundStartAbs = 0;

  private snaps: [Map<number, PublicSnap>, Map<number, PublicSnap>] = [new Map(), new Map()];
  private lastRecv: [number, number] = [-1, -1];
  private lastRecvAt: [number, number] = [0, 0];
  private processed = -1;
  private lastSnap: [PublicSnap, PublicSnap] = [spawnSnapshot(0), spawnSnapshot(1)];
  private stalled: [boolean, boolean] = [false, false];

  constructor(
    readonly opts: RoomOptions,
    readonly seats: [Seat, Seat],
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.now();
  }

  get id(): string {
    return this.opts.id;
  }

  /** Oldest acceptable snapshot age, in ticks behind the server's wall tick. */
  get lateLimitTicks(): number {
    return this.opts.proofGraceWindows * this.opts.windowTicks;
  }

  /** Current processed tick of the live round (−1 before the first). */
  get processedTick(): number {
    return this.processed;
  }

  indexOf(playerId: string): PlayerIndex | null {
    if (this.seats[0].playerId === playerId) return 0;
    if (this.seats[1].playerId === playerId) return 1;
    return null;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.deps.log.write({
      type: 'header',
      version: 1,
      source: 'server',
      matchId: this.id,
      matchField: this.opts.matchField,
      windowTicks: this.opts.windowTicks,
      constantsHash: this.opts.constantsHash,
      createdAt: Date.now(),
    });
    for (const p of [0, 1] as const) {
      this.send(p, {
        t: 'match_found',
        matchId: this.id,
        matchField: this.opts.matchField,
        playerIndex: p,
        opponentName: this.seats[other(p)].displayName,
        scheme: this.opts.scheme,
        windowTicks: this.opts.windowTicks as 4 | 30 | 60 | 120,
        enforcement: this.opts.enforcement,
        spawns: [
          { x: SPAWNS[0].x, y: SPAWNS[0].y, angle: SPAWNS[0].angle },
          { x: SPAWNS[1].x, y: SPAWNS[1].y, angle: SPAWNS[1].angle },
        ],
        initialCommit: this.opts.initialCommit,
        prevSnapshot: toTuple(spawnSnapshot(p)),
      });
    }
  }

  /**
   * Phase 1: `artefactSha256` is not checked yet (no proving key exists). Phase 3 compares it
   * with the active variant's zkeySha256.
   */
  onReady(p: PlayerIndex): void {
    this.seats[p].ready = true;
    if (this.phase === 'waiting_ready' && this.seats[0].ready && this.seats[1].ready) {
      this.phase = 'countdown';
      this.countdownStart = this.deps.now();
      this.lastCountdownSent = COUNTDOWN_SECONDS;
      this.broadcast({ t: 'countdown', secondsLeft: COUNTDOWN_SECONDS });
    }
  }

  onForfeit(p: PlayerIndex): void {
    this.finish('forfeit', other(p));
  }

  onDisconnect(p: PlayerIndex): void {
    if (this.phase === 'finished') return;
    this.seats[p].link = null;
    this.seats[p].disconnectedAt = this.deps.now();
    this.send(other(p), { t: 'opponent_status', status: 'reconnecting' });
  }

  // ---------------------------------------------------------------- snapshots

  onSnapshot(
    p: PlayerIndex,
    m: { tick: number; x: number; y: number; angle: number; fired: number },
  ): SnapshotVerdict {
    if (this.phase !== 'live') return 'drop'; // e.g. ticks the client ran past round end
    if (m.tick <= this.lastRecv[p]) return 'drop'; // duplicate / out of order
    const wall = this.wallTick();
    if (m.tick > wall + STALL_TICKS) return 'strike_future';
    // Late ticks are accepted (honest data at high RTT) up to the proof grace period; older → strike.
    if (m.tick < wall - this.lateLimitTicks) return 'strike_late';

    const snap: PublicSnap = { x: m.x, y: m.y, angle: m.angle, fired: m.fired };
    const inRange =
      m.x >= 0 &&
      m.x <= ARENA_W &&
      m.y >= 0 &&
      m.y <= ARENA_H &&
      m.angle >= 0 &&
      m.angle < ANGLE_UNITS &&
      (m.fired === 0 || m.fired === 1);
    // Out-of-range integers are kept as sent (they must reach the digest); a strike is counted.
    if (m.tick > this.processed) this.snaps[p].set(m.tick, snap);
    this.lastRecv[p] = m.tick;
    this.lastRecvAt[p] = this.deps.now();
    this.deps.log.write({
      type: 'tick',
      roundNo: this.roundNo,
      tick: m.tick,
      playerIndex: p,
      ...snap,
    });
    this.tryProcess();
    return inRange ? 'ok' : 'strike_range';
  }

  /** Round-relative tick by the server wall clock. */
  wallTick(): number {
    return Math.floor((this.deps.now() - this.roundStartWall) / MS_PER_TICK);
  }

  private tryProcess(): void {
    while (this.phase === 'live') {
      const t = this.processed + 1;
      const lead = Math.max(this.lastRecv[0], this.lastRecv[1]);
      if (lead < t) return;
      const ok = ([0, 1] as const).every((p) => this.snaps[p].has(t) || lead - t >= STALL_TICKS);
      if (!ok) return;
      this.processTick(t);
    }
  }

  private processTick(t: number): void {
    const t0 = performance.now();
    const cur = ([0, 1] as const).map((p) => {
      const s = this.snaps[p].get(t);
      if (s) {
        this.snaps[p].delete(t);
        this.lastSnap[p] = s;
        this.setStalled(p, false);
        return s;
      }
      const held: PublicSnap = { ...this.lastSnap[p], fired: 0 };
      this.lastSnap[p] = held;
      this.setStalled(p, true);
      this.deps.log.write({
        type: 'tick',
        roundNo: this.roundNo,
        tick: t,
        playerIndex: p,
        ...held,
        held: true,
      });
      return held;
    }) as [PublicSnap, PublicSnap];

    const hits: { shooter: PlayerIndex; target: PlayerIndex; tick: number }[] = [];
    for (const p of [0, 1] as const) {
      if (cur[p].fired !== 1) continue;
      this.shots[p]++;
      if (shotHits(cur[p], cur[other(p)])) hits.push({ shooter: p, target: other(p), tick: t });
    }
    for (const h of hits) {
      this.hp[h.target] -= DAMAGE;
      this.hits[h.shooter]++;
    }
    let winner: PlayerIndex | null = null;
    if (this.hp[0] <= 0 && this.hp[1] <= 0) {
      // Simultaneous lethal hits in the same tick: both survive at 1 HP (FEATURES F7).
      this.hp[0] = 1;
      this.hp[1] = 1;
    } else if (this.hp[0] <= 0) {
      this.hp[0] = 0;
      winner = 1;
    } else if (this.hp[1] <= 0) {
      this.hp[1] = 0;
      winner = 0;
    }
    this.processed = t;
    this.broadcast({
      t: 'state',
      roundNo: this.roundNo,
      phase: 'live',
      tick: t,
      players: [
        { ...cur[0], hp: this.hp[0] },
        { ...cur[1], hp: this.hp[1] },
      ],
      hits,
    });
    tickTiming.record(performance.now() - t0);
    if (winner !== null) this.endRound(t, winner);
  }

  private setStalled(p: PlayerIndex, v: boolean): void {
    if (this.stalled[p] === v) return;
    this.stalled[p] = v;
    if (this.seats[p].disconnectedAt === null) {
      this.send(other(p), { t: 'opponent_status', status: v ? 'stalled' : 'connected' });
    }
  }

  // ---------------------------------------------------------------- rounds

  private startRound(r: number): void {
    const now = this.deps.now();
    this.roundNo = r;
    this.phase = 'live';
    this.hp[0] = MAX_HP;
    this.hp[1] = MAX_HP;
    this.snaps = [new Map(), new Map()];
    this.lastRecv = [-1, -1];
    this.lastRecvAt = [now, now];
    this.processed = -1;
    this.lastSnap = [spawnSnapshot(0), spawnSnapshot(1)];
    this.stalled = [false, false];
    this.roundStartWall = now;
    this.deps.repo.startRound(this.id, r, this.roundStartAbs);
    this.deps.log.write({
      type: 'round_start',
      roundNo: r,
      prevSnapshot: [toTuple(spawnSnapshot(0)), toTuple(spawnSnapshot(1))],
      initialCommit: this.opts.initialCommit,
    });
    this.broadcast({ t: 'start', roundNo: r, startTick: 0, serverTime: Date.now() });
  }

  private endRound(endTick: number, winner: PlayerIndex): void {
    this.score[winner]++;
    this.lastEndTick = endTick;
    this.deps.repo.endRound(this.id, this.roundNo, this.roundStartAbs + endTick, winner);
    this.roundStartAbs += endTick + 1;
    this.deps.log.write({ type: 'round_end', roundNo: this.roundNo, endTick, winnerIndex: winner });
    for (const p of [0, 1] as const) {
      this.send(p, {
        t: 'round_end',
        roundNo: this.roundNo,
        endTick,
        winnerIndex: winner,
        score: [this.score[0], this.score[1]],
        pauseTicks: ROUND_PAUSE_TICKS,
        initialCommit: this.opts.initialCommit,
        prevSnapshot: toTuple(spawnSnapshot(p)),
      });
    }
    // Leave 'live' before finish() so the round's ticks (already added above) aren't counted twice.
    this.phase = 'pause';
    if (this.score[winner] >= ROUNDS_TO_WIN) {
      this.finish('rounds', winner);
    } else {
      this.pauseUntil = this.deps.now() + ROUND_PAUSE_TICKS * MS_PER_TICK;
    }
  }

  finish(reason: EndReason, winner: PlayerIndex | null): void {
    if (this.phase === 'finished') return;
    const wasLive = this.phase === 'live';
    this.phase = 'finished';
    const totalTicks = this.roundStartAbs + (wasLive ? this.processed + 1 : 0);
    this.deps.repo.finishMatch({
      matchId: this.id,
      status: reason === 'abort' ? 'aborted' : 'finished',
      winner,
      reason,
      totalTicks,
      stats: [
        { roundsWon: this.score[0], hits: this.hits[0], shots: this.shots[0] },
        { roundsWon: this.score[1], hits: this.hits[1], shots: this.shots[1] },
      ],
    });
    this.broadcast({
      t: 'match_end',
      winnerIndex: winner,
      reason,
      score: [this.score[0], this.score[1]],
      resultsUrl: `/match/${this.id}/results`,
    });
    this.deps.log.write({
      type: 'match_end',
      winnerIndex: winner,
      reason,
      score: [this.score[0], this.score[1]],
    });
    void this.deps.log.close();
    this.deps.onFinished(this);
  }

  // ---------------------------------------------------------------- wall clock (60 Hz)

  onWall(): void {
    const now = this.deps.now();
    if (this.phase === 'finished') return;

    // Disconnected longer than RECONNECT_TIMEOUT_MS → forfeit (or abort before any round).
    for (const p of [0, 1] as const) {
      const since = this.seats[p].disconnectedAt;
      if (since !== null && now - since >= RECONNECT_TIMEOUT_MS) {
        const o = other(p);
        const otherGone = this.seats[o].disconnectedAt !== null;
        if (this.roundNo === 0 || otherGone) this.finish('abort', null);
        else this.finish('disconnect', o);
        return;
      }
    }

    switch (this.phase) {
      case 'waiting_ready':
        if (now - this.createdAt >= READY_TIMEOUT_MS) this.finish('abort', null);
        return;
      case 'countdown': {
        const left = COUNTDOWN_SECONDS - Math.floor((now - this.countdownStart) / 1000);
        if (left <= 0) this.startRound(1);
        else if (left !== this.lastCountdownSent) {
          this.lastCountdownSent = left;
          this.broadcast({ t: 'countdown', secondsLeft: left });
        }
        return;
      }
      case 'live': {
        // Slow / silent client (connected but not sending): 10 s → forfeit (SECURITY §6).
        const idle = ([0, 1] as const).map((p) => now - this.lastRecvAt[p] >= RECONNECT_TIMEOUT_MS);
        if (idle[0] && idle[1]) this.finish('abort', null);
        else if (idle[0]) this.finish('disconnect', 1);
        else if (idle[1]) this.finish('disconnect', 0);
        return;
      }
      case 'pause':
        this.broadcast({
          t: 'state',
          roundNo: this.roundNo,
          phase: 'pause',
          tick: this.lastEndTick,
          players: [
            { ...this.lastSnap[0], hp: this.hp[0] },
            { ...this.lastSnap[1], hp: this.hp[1] },
          ],
          hits: [],
        });
        if (now >= this.pauseUntil) this.startRound(this.roundNo + 1);
        return;
    }
  }

  // ---------------------------------------------------------------- io

  private send(p: PlayerIndex, msg: ServerMessage): void {
    this.seats[p].link?.send(msg);
  }

  private broadcast(msg: ServerMessage): void {
    this.send(0, msg);
    this.send(1, msg);
  }
}
