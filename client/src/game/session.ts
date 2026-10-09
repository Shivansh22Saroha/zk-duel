/**
 * DOM-free client game session: owns the local fixed-step sim, the per-tick recorder
 * (public + private TickRecord — the WindowRecorder shape) and the protocol handling.
 * The browser (requestAnimationFrame) and the Node bots drive it through `update(now)`.
 *
 * Only `input_snapshot {tick, x, y, angle, fired}` ever leaves the session per tick; hidden
 * state goes exclusively to the optional local TickLogSink.
 */
import { MAX_HP, STALL_TICKS, TICK_RATE, type PlayerIndex } from '@zkduel/shared/constants';
import type { ClientMessage, ServerMessage } from '@zkduel/shared/protocol';
import {
  holdTick,
  spawnState,
  stepPlayer,
  toRecord,
  type PlayerState,
  type PublicSnap,
  type TickInput,
  type TickRecord,
} from '@zkduel/shared/sim';
import type { TickLogLine } from '@zkduel/shared/ticklog';

export const MS_PER_TICK = 1000 / TICK_RATE;
/** Phase 1 placeholder for `ready.artefactSha256` (no proving key exists until Phase 3). */
export const NO_ARTEFACT_SHA256 = '0'.repeat(64);

type MatchFound = Extract<ServerMessage, { t: 'match_found' }>;
type MatchEnd = Extract<ServerMessage, { t: 'match_end' }>;
type RoundEnd = Extract<ServerMessage, { t: 'round_end' }>;
type StateMsg = Extract<ServerMessage, { t: 'state' }>;

export interface Transport {
  send(msg: ClientMessage): void;
}

export interface InputContext {
  tick: number;
  playerIndex: PlayerIndex;
  self: PlayerState;
  /** Latest server-reported opponent snapshot, if any. */
  opponent: PublicSnap | null;
}

export interface InputSource {
  sample(ctx: InputContext): TickInput;
}

export interface TickLogSink {
  write(line: TickLogLine): void;
}

export type SessionPhase = 'idle' | 'matched' | 'countdown' | 'live' | 'pause' | 'ended';

export interface SessionOptions {
  now: () => number;
  constantsHash: string;
  log?: TickLogSink;
  /** Send `ready` automatically on match_found (Phase 1: nothing to load). */
  autoReady?: boolean;
}

export interface OpponentSample {
  tick: number;
  at: number;
  snap: PublicSnap;
}

export class GameSession {
  phase: SessionPhase = 'idle';
  match: MatchFound | null = null;
  playerIndex: PlayerIndex = 0;
  roundNo = 0;
  /** Last simulated tick of the current round (−1 before the first). */
  tick = -1;
  self: PlayerState = spawnState(0);
  /** State before the last step, for render interpolation. */
  prevSelf: PlayerState = spawnState(0);
  lastStepAt = 0;
  hp: [number, number] = [MAX_HP, MAX_HP];
  score: [number, number] = [0, 0];
  countdown = 0;
  lastRoundEnd: RoundEnd | null = null;
  result: MatchEnd | null = null;
  opponentStatus: 'connected' | 'reconnecting' | 'stalled' = 'connected';
  /** Last server states (both players) for rendering. */
  lastState: StateMsg | null = null;
  readonly opponentBuffer: OpponentSample[] = [];

  /** Metrics. */
  ticksSent = 0;
  ticksFilled = 0;
  /** Server echoed a different value for our own snapshot (excluding locally filled ticks). */
  desyncTicks = 0;
  checkedTicks = 0;

  /** Current round's records (public + private), in tick order. */
  records: TickRecord[] = [];
  private sentByTick = new Map<number, PublicSnap>();
  private roundStartAt = 0;
  private nextPrev: [number, number, number, number] | null = null;
  private nextCommit = '';
  private listeners = new Set<(m: ServerMessage) => void>();

  constructor(
    private readonly transport: Transport,
    private readonly input: InputSource,
    private readonly opts: SessionOptions,
  ) {}

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get opponentIndex(): PlayerIndex {
    return this.playerIndex === 0 ? 1 : 0;
  }

  // ---------------------------------------------------------------- server messages

  handle(m: ServerMessage): void {
    const now = this.opts.now();
    switch (m.t) {
      case 'match_found':
        this.match = m;
        this.playerIndex = m.playerIndex;
        this.phase = 'matched';
        this.score = [0, 0];
        this.result = null;
        this.self = spawnState(m.playerIndex);
        this.prevSelf = this.self;
        this.nextPrev = m.prevSnapshot;
        this.nextCommit = m.initialCommit;
        this.opts.log?.write({
          type: 'header',
          version: 1,
          source: 'client',
          matchId: m.matchId,
          matchField: m.matchField,
          playerIndex: m.playerIndex,
          windowTicks: m.windowTicks,
          constantsHash: this.opts.constantsHash,
          createdAt: Date.now(),
        });
        if (this.opts.autoReady !== false)
          this.transport.send({ t: 'ready', artefactSha256: NO_ARTEFACT_SHA256 });
        break;
      case 'countdown':
        this.phase = 'countdown';
        this.countdown = m.secondsLeft;
        break;
      case 'start':
        this.roundNo = m.roundNo;
        this.phase = 'live';
        this.tick = -1;
        this.self = spawnState(this.playerIndex);
        this.prevSelf = this.self;
        this.records = [];
        this.sentByTick.clear();
        this.opponentBuffer.length = 0;
        this.hp = [MAX_HP, MAX_HP];
        this.roundStartAt = now;
        this.lastStepAt = now;
        this.opts.log?.write({
          type: 'round_start',
          roundNo: m.roundNo,
          prevSnapshot: this.nextPrev ?? [this.self.pub.x, this.self.pub.y, this.self.pub.angle, 0],
          initialCommit: this.nextCommit,
        });
        break;
      case 'state':
        this.onState(m, now);
        break;
      case 'round_end':
        this.phase = 'pause';
        this.score = [m.score[0], m.score[1]];
        this.lastRoundEnd = m;
        this.nextPrev = m.prevSnapshot;
        this.nextCommit = m.initialCommit;
        this.opts.log?.write({
          type: 'round_end',
          roundNo: m.roundNo,
          endTick: m.endTick,
          winnerIndex: m.winnerIndex,
        });
        break;
      case 'match_end':
        this.phase = 'ended';
        this.result = m;
        this.score = [m.score[0], m.score[1]];
        this.opts.log?.write({
          type: 'match_end',
          winnerIndex: m.winnerIndex,
          reason: m.reason,
          score: [m.score[0], m.score[1]],
        });
        break;
      case 'opponent_status':
        this.opponentStatus = m.status;
        break;
      default:
        break;
    }
    for (const fn of this.listeners) fn(m);
  }

  private onState(m: StateMsg, now: number): void {
    this.lastState = m;
    if (m.roundNo !== this.roundNo) return;
    this.hp = [m.players[0].hp, m.players[1].hp];
    if (m.phase !== 'live') return;
    const o = m.players[this.opponentIndex];
    this.opponentBuffer.push({
      tick: m.tick,
      at: now,
      snap: { x: o.x, y: o.y, angle: o.angle, fired: o.fired },
    });
    if (this.opponentBuffer.length > 32) this.opponentBuffer.shift();
    const mine = m.players[this.playerIndex];
    const sent = this.sentByTick.get(m.tick);
    if (sent) {
      this.checkedTicks++;
      if (
        sent.x !== mine.x ||
        sent.y !== mine.y ||
        sent.angle !== mine.angle ||
        sent.fired !== mine.fired
      ) {
        this.desyncTicks++;
      }
      this.sentByTick.delete(m.tick);
    }
  }

  // ---------------------------------------------------------------- local sim

  /** Advance the local sim up to the current wall-clock tick. Returns ticks stepped. */
  update(now: number): number {
    if (this.phase !== 'live') return 0;
    const target = Math.floor((now - this.roundStartAt) / MS_PER_TICK);
    let steps = 0;
    // Fell more than STALL_TICKS behind (e.g. background tab): fill locally exactly like the
    // server does (hold, fired = 0) and do not send those ticks.
    if (target - this.tick > STALL_TICKS) {
      while (this.tick < target - 1) {
        this.advance(holdTick(this.self), 0, false, now);
        steps++;
      }
    }
    while (this.tick < target) {
      const r = stepPlayer(this.self, this.input.sample(this.inputContext()));
      this.advance(r.state, r.reloadPress, true, now);
      steps++;
    }
    return steps;
  }

  private inputContext() {
    const last = this.opponentBuffer[this.opponentBuffer.length - 1];
    return {
      tick: this.tick + 1,
      playerIndex: this.playerIndex,
      self: this.self,
      opponent: last?.snap ?? null,
    };
  }

  private advance(next: PlayerState, reloadPress: number, send: boolean, now: number): void {
    this.tick++;
    this.prevSelf = this.self;
    this.self = next;
    this.lastStepAt = now;
    const rec = toRecord(this.tick, next, reloadPress);
    this.records.push(rec);
    this.opts.log?.write({
      type: 'tick',
      roundNo: this.roundNo,
      ...rec,
      ...(send ? {} : { filled: true }),
    });
    if (send) {
      const { x, y, angle, fired } = next.pub;
      this.sentByTick.set(this.tick, { x, y, angle, fired });
      this.transport.send({ t: 'input_snapshot', tick: this.tick, x, y, angle, fired });
      this.ticksSent++;
    } else {
      this.ticksFilled++;
    }
  }

  /** Render interpolation factor for the local player in [0, 1]. */
  alpha(now: number): number {
    return Math.min(1, Math.max(0, (now - this.lastStepAt) / MS_PER_TICK));
  }
}
