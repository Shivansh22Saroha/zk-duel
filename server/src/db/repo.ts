/** Repository functions. Writes happen at lifecycle and window events, never per tick. */
import type { PlayerIndex } from '@zkduel/shared/constants';
import type { EndReason } from '@zkduel/shared/protocol';
import { FAILURE_STATUSES } from '@zkduel/shared/protocol';
import type { AuditSummary, ProofStore, WindowRow } from '../zk/tracker';
import type { DB } from './index';

const SESSION_RETENTION_MS = 7 * 24 * 3600 * 1000; // DATABASE_SCHEMA §4: prune sessions older than 7 days

export class Repo implements ProofStore {
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

  // ---------------------------------------------------------------- proof windows & audit (Phase 3)
  upsertWindow(r: WindowRow): void {
    this.db
      .prepare(
        `INSERT INTO proof_windows (match_id, player_index, round_no, window_index, start_tick, status,
           digest, challenged, challenged_at, decided_phase, fail_reason, commit_in, commit_out,
           prove_ms, verify_ms, proof_bytes, received_at, proof_json, decided_at)
         VALUES (@matchId, @playerIndex, @roundNo, @windowIndex, @startTick, @status, @digest,
           @challenged, @challengedAt, @decidedPhase, @failReason, @commitIn, @commitOut, @proveMs,
           @verifyMs, @proofBytes, @receivedAt, @proofJson, @decidedAt)
         ON CONFLICT (match_id, player_index, round_no, window_index) DO UPDATE SET
           status = excluded.status, digest = excluded.digest, challenged = excluded.challenged,
           challenged_at = excluded.challenged_at, decided_phase = excluded.decided_phase,
           fail_reason = excluded.fail_reason, commit_in = excluded.commit_in,
           commit_out = excluded.commit_out, prove_ms = excluded.prove_ms,
           verify_ms = excluded.verify_ms, proof_bytes = excluded.proof_bytes,
           received_at = excluded.received_at, proof_json = excluded.proof_json,
           decided_at = excluded.decided_at`,
      )
      .run({ ...r, challenged: r.challenged ? 1 : 0 });
  }

  addCheatEvent(e: {
    matchId: string;
    playerIndex: PlayerIndex;
    cheat: string;
    enabled: boolean;
    roundNo: number;
    tick: number;
    windowIndex: number;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cheat_events (match_id, player_index, cheat, enabled, round_no, tick, window_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.matchId,
        e.playerIndex,
        e.cheat,
        e.enabled ? 1 : 0,
        e.roundNo,
        e.tick,
        e.windowIndex,
        e.createdAt,
      );
  }

  getCheatEvents(matchId: string): CheatEventRow[] {
    return (
      this.db
        .prepare(
          `SELECT player_index AS playerIndex, cheat, enabled, round_no AS roundNo, tick,
                  window_index AS windowIndex, created_at AS createdAt
             FROM cheat_events WHERE match_id = ? ORDER BY id`,
        )
        .all(matchId) as (Omit<CheatEventRow, 'enabled'> & { enabled: number })[]
    ).map((r) => ({ ...r, enabled: r.enabled === 1 }));
  }

  setAuditing(matchId: string): void {
    this.db.prepare("UPDATE matches SET audit_status = 'auditing' WHERE id = ?").run(matchId);
  }

  finishAudit(a: AuditSummary): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE matches SET audit_status = ?, overturned = ?, result_verdict = ?, audit_ended_at = ? WHERE id = ?',
        )
        .run(a.auditStatus, a.overturned ? 1 : 0, a.resultVerdict, a.endedAt, a.matchId);
      const up = this.db.prepare(
        `UPDATE match_players SET windows = ?, windows_committed = ?, challenges = ?,
           challenges_passed = ?, challenge_rate = ?, audit_ms = ?, audit_status = ?,
           detection_latency_windows = ?, detection_latency_ms = ?
         WHERE match_id = ? AND player_index = ?`,
      );
      a.players.forEach((m, i) =>
        up.run(
          m.windows,
          m.windowsCommitted,
          m.challenges,
          m.challengesPassed,
          m.challengeRate,
          m.auditMs,
          m.auditStatus,
          m.detectionLatencyWindows,
          m.detectionLatencyMs,
          a.matchId,
          i,
        ),
      );
    })();
  }

  getWindows(matchId: string, player?: number): WindowListRow[] {
    return this.db
      .prepare(
        `SELECT player_index AS playerIndex, round_no AS roundNo, window_index AS windowIndex,
                start_tick AS startTick, status, challenged, decided_phase AS phase,
                prove_ms AS proveMs, verify_ms AS verifyMs, proof_bytes AS proofBytes
           FROM proof_windows WHERE match_id = ? AND (? IS NULL OR player_index = ?)
          ORDER BY player_index, round_no, window_index`,
      )
      .all(matchId, player ?? null, player ?? null)
      .map((r) => ({
        ...(r as WindowListRow),
        challenged: (r as { challenged: number }).challenged === 1,
      }));
  }

  private windowStats(matchId: string, p: number): WindowStats {
    const rows = this.db
      .prepare(
        'SELECT status, prove_ms AS proveMs, verify_ms AS verifyMs FROM proof_windows WHERE match_id = ? AND player_index = ?',
      )
      .all(matchId, p) as { status: string; proveMs: number | null; verifyMs: number | null }[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const prove = rows
      .map((r) => r.proveMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const verify = rows.map((r) => r.verifyMs).filter((v): v is number => v !== null);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      byStatus,
      failed: (FAILURE_STATUSES as readonly string[]).reduce((n, st) => n + (byStatus[st] ?? 0), 0),
      proveMsMean: mean(prove),
      proveMsP95: prove.length
        ? (prove[Math.min(prove.length - 1, Math.floor(0.95 * prove.length))] as number)
        : null,
      verifyMsMean: mean(verify),
    };
  }

  /** Full match summary for GET /api/matches/:id. */
  getMatchSummary(matchId: string): MatchSummary | undefined {
    const m = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as
      MatchRow | undefined;
    if (!m) return undefined;
    const players = this.db
      .prepare(
        `SELECT mp.player_index AS playerIndex, mp.player_id AS playerId, p.display_name AS displayName,
                mp.rounds_won AS roundsWon, mp.hits, mp.shots, mp.windows,
                mp.windows_committed AS windowsCommitted, mp.challenges,
                mp.challenges_passed AS challengesPassed, mp.challenge_rate AS challengeRate,
                mp.detection_latency_windows AS detectionLatencyWindows, mp.audit_ms AS auditMs,
                mp.audit_status AS auditStatus, mp.detection_latency_ms AS detectionLatencyMs
           FROM match_players mp JOIN players p ON p.id = mp.player_id
          WHERE mp.match_id = ? ORDER BY mp.player_index`,
      )
      .all(matchId) as Omit<MatchSummary['players'][number], 'proofs'>[];
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
      auditStatus: m.audit_status,
      overturned: m.overturned === 1,
      resultVerdict: m.result_verdict,
      auditEndedAt: m.audit_ended_at,
      players: players.map((p) => ({ ...p, proofs: this.windowStats(matchId, p.playerIndex) })),
      cheatEvents: this.getCheatEvents(matchId),
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
  audit_status: MatchSummary['auditStatus'];
  overturned: number;
  result_verdict: MatchSummary['resultVerdict'];
  audit_ended_at: number | null;
}

export interface CheatEventRow {
  playerIndex: number;
  cheat: string;
  enabled: boolean;
  roundNo: number;
  tick: number;
  windowIndex: number;
  createdAt: number;
}

export interface WindowListRow {
  playerIndex: number;
  roundNo: number;
  windowIndex: number;
  startTick: number;
  status: string;
  challenged: boolean;
  phase: 'live' | 'audit' | null;
  proveMs: number | null;
  verifyMs: number | null;
  proofBytes: number | null;
}

export interface WindowStats {
  byStatus: Record<string, number>;
  failed: number;
  proveMsMean: number | null;
  proveMsP95: number | null;
  verifyMsMean: number | null;
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
  auditStatus: 'auditing' | 'audited_clean' | 'audited_failed' | 'audit_incomplete' | null;
  overturned: boolean;
  resultVerdict: 'verified' | 'overturned' | 'unverified' | null;
  auditEndedAt: number | null;
  players: {
    playerIndex: number;
    playerId: string;
    displayName: string;
    roundsWon: number;
    hits: number;
    shots: number;
    windows: number;
    windowsCommitted: number;
    challenges: number;
    challengesPassed: number;
    challengeRate: number | null;
    detectionLatencyWindows: number | null;
    auditMs: number | null;
    auditStatus: 'audited_clean' | 'audited_failed' | 'audit_incomplete' | null;
    detectionLatencyMs: number | null;
    proofs: WindowStats;
  }[];
  cheatEvents: CheatEventRow[];
  rounds: {
    roundNo: number;
    startTick: number;
    endTick: number | null;
    winnerIndex: number | null;
  }[];
}
