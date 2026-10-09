/**
 * Tick-log format (JSONL) used to test the circuit offline against real matches (Phase 2).
 *
 * Two sources, never mixed:
 *  - `client` logs contain public AND private per-tick state. They are written only on the
 *    player's own machine (Node bots: a file; browser: a dev-only download). They never
 *    travel over the network.
 *  - `server` logs (LOG_SNAPSHOTS=true) contain only what the server actually received:
 *    public snapshots. Phase 2 cross-checks the server digest against them.
 */
import type { PlayerIndex } from './constants';
import type { PublicSnap, TickRecord } from './sim';

export const TICKLOG_VERSION = 1;

export interface TickLogHeader {
  type: 'header';
  version: typeof TICKLOG_VERSION;
  source: 'client' | 'server';
  matchId: string;
  matchField: string;
  /** Present on client logs (the logging player); absent on server logs. */
  playerIndex?: PlayerIndex;
  windowTicks: number;
  constantsHash: string;
  createdAt: number;
}

export interface TickLogRoundStart {
  type: 'round_start';
  roundNo: number;
  /** Server logs: one entry per player index. Client logs: the logging player's. */
  prevSnapshot: [number, number, number, number] | [number, number, number, number][];
  initialCommit: string;
}

/** Client log tick line: public + private (TickRecord). */
export interface TickLogClientTick extends TickRecord {
  type: 'tick';
  roundNo: number;
  /** True when this tick was a local gap fill (not sent to the server). */
  filled?: boolean;
}

/** Server log tick line: what was received from one player, or the held fill. */
export interface TickLogServerTick extends PublicSnap {
  type: 'tick';
  roundNo: number;
  tick: number;
  playerIndex: PlayerIndex;
  /** True when the server filled this tick (snapshot missing when processed). */
  held?: boolean;
}

export interface TickLogRoundEnd {
  type: 'round_end';
  roundNo: number;
  endTick: number;
  winnerIndex: PlayerIndex;
}

export interface TickLogMatchEnd {
  type: 'match_end';
  winnerIndex: PlayerIndex | null;
  reason: string;
  score: [number, number];
}

export type TickLogLine =
  | TickLogHeader
  | TickLogRoundStart
  | TickLogClientTick
  | TickLogServerTick
  | TickLogRoundEnd
  | TickLogMatchEnd;

/** Keys that must never appear in a server-side log or any network frame. */
export const HIDDEN_KEYS = [
  'ammo',
  'cooldown',
  'reloadTimer',
  'reloadPress',
  'salt',
  'saltIn',
  'saltOut',
] as const;
