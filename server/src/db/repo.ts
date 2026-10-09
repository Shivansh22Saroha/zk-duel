/** Repository functions. Writes happen at lifecycle events (match/round start/end), never per tick. */
import type { PlayerIndex } from '@zkduel/shared/constants';
import type { EndReason } from '@zkduel/shared/protocol';
import type { DB } from './index';

const SESSION_RETENTION_MS = 7 * 24 * 3600 * 1000; // DATABASE_SCHEMA §4: prune sessions older than 7 days

export class Repo {
  constructor(private readonly db: DB) {}

  // ---------------------------------------------------------------- players & sessions
  createPlayer(id: string, displayName: string, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO players (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, displayName, now, now);
  }

  touchPlayer(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  getPlayer(id: string): { id: string; displayName: string } | undefined {
    return this.db
      .prepare('SELECT id, display_name AS displayName FROM players WHERE id = ?')
      .get(id) as { id: string; displayName: string } | undefined;
  }

  createSession(jti: string, playerId: string, expiresAt: number, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO sessions (id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(jti, playerId, now, expiresAt);
  }

  getSession(jti: string): { playerId: string; expiresAt: number; revoked: number } | undefined {
    return this.db
      .prepare(
        'SELECT player_id AS playerId, expires_at AS expiresAt, revoked FROM sessions WHERE id = ?',
      )
      .get(jti) as { playerId: string; expiresAt: number; revoked: number } | undefined;
  }

  revokeSession(jti: string): void {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(jti);
  }

  pruneSessions(now = Date.now()): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE created_at < ?')
      .run(now - SESSION_RETENTION_MS).changes;
  }

  // ---------------------------------------------------------------- matches
  createMatch(m: {
    id: string;
    matchField: string;
    mode: 'queue' | 'private' | 'bench';
    enforcement: 'observe' | 'strict';
    scheme: string;
    windowTicks: number;
    circuitHash: string;
    roomCode: string | null;
    players: [string, string];
    now?: number;
  }): void {
    const now = m.now ?? Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO matches (id, match_field, mode, enforcement, scheme, window_ticks, circuit_hash,
             status, room_code, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          m.id,
          m.matchField,
          m.mode,
          m.enforcement,
          m.scheme,
          m.windowTicks,
          m.circuitHash,
          m.roomCode,
          now,
        );
      const ins = this.db.prepare(
        'INSERT INTO match_players (match_id, player_index, player_id) VALUES (?, ?, ?)',
      );
      ins.run(m.id, 0, m.players[0]);
      ins.run(m.id, 1, m.players[1]);
    })();
  }

  startRound(matchId: string, roundNo: number, startTickAbs: number): void {
    this.db
      .prepare('INSERT INTO rounds (match_id, round_no, start_tick) VALUES (?, ?, ?)')
      .run(matchId, roundNo, startTickAbs);
  }

  endRound(matchId: string, roundNo: number, endTickAbs: number, winner: PlayerIndex): void {
    this.db
      .prepare(
        'UPDATE rounds SET end_tick = ?, winner_index = ? WHERE match_id = ? AND round_no = ?',
      )
      .run(endTickAbs, winner, matchId, roundNo);
  }

  finishMatch(f: {
    matchId: string;
    status: 'finished' | 'aborted';
    winner: PlayerIndex | null;
    reason: EndReason;
    totalTicks: number;
    stats: [
      { roundsWon: number; hits: number; shots: number },
      { roundsWon: number; hits: number; shots: number },
    ];
    now?: number;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE matches SET status = ?, winner_index = ?, end_reason = ?, ended_at = ?, total_ticks = ? WHERE id = ?',
        )
        .run(f.status, f.winner, f.reason, f.now ?? Date.now(), f.totalTicks, f.matchId);
      const up = this.db.prepare(
        'UPDATE match_players SET rounds_won = ?, hits = ?, shots = ? WHERE match_id = ? AND player_index = ?',
      );
      f.stats.forEach((s, i) => up.run(s.roundsWon, s.hits, s.shots, f.matchId, i));
    })();
  }

  /** Full match summary for GET /api/matches/:id (Phase 1 fields; proof stats arrive in Phase 3). */
  getMatchSummary(matchId: string): MatchSummary | undefined {
    const m = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as
      MatchRow | undefined;
    if (!m) return undefined;
    const players = this.db
      .prepare(
        `SELECT mp.player_index AS playerIndex, mp.player_id AS playerId, p.display_name AS displayName,
                mp.rounds_won AS roundsWon, mp.hits, mp.shots
           FROM match_players mp JOIN players p ON p.id = mp.player_id
          WHERE mp.match_id = ? ORDER BY mp.player_index`,
      )
      .all(matchId) as MatchSummary['players'];
    const rounds = this.db
      .prepare(
        `SELECT round_no AS roundNo, start_tick AS startTick, end_tick AS endTick, winner_index AS winnerIndex
           FROM rounds WHERE match_id = ? ORDER BY round_no`,
      )
      .all(matchId) as MatchSummary['rounds'];
    return {
      id: m.id,
      mode: m.mode,
      enforcement: m.enforcement,
      scheme: m.scheme,
      windowTicks: m.window_ticks,
      status: m.status,
      winnerIndex: m.winner_index,
      endReason: m.end_reason,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      totalTicks: m.total_ticks,
      players,
      rounds,
    };
  }
}

interface MatchRow {
  id: string;
  mode: string;
  enforcement: string;
  scheme: string;
  window_ticks: number;
  status: string;
  winner_index: number | null;
  end_reason: string | null;
  started_at: number;
  ended_at: number | null;
  total_ticks: number;
}

export interface MatchSummary {
  id: string;
  mode: string;
  enforcement: string;
  scheme: string;
  windowTicks: number;
  status: string;
  winnerIndex: number | null;
  endReason: string | null;
  startedAt: number;
  endedAt: number | null;
  totalTicks: number;
  players: {
    playerIndex: number;
    playerId: string;
    displayName: string;
    roundsWon: number;
    hits: number;
    shots: number;
  }[];
  rounds: {
    roundNo: number;
    startTick: number;
    endTick: number | null;
    winnerIndex: number | null;
  }[];
}
