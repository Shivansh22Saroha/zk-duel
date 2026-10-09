-- 001_init: Phase 1 tables (docs/DATABASE_SCHEMA.md §2).
-- proof_windows (Phase 3), cheat_events (Phase 4) and benchmark tables (Phase 5) come later.
-- No hidden state is ever stored.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 3 AND 16),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_players_last_seen ON players (last_seen_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);
CREATE INDEX idx_sessions_player ON sessions (player_id);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  match_field TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('queue','private','bench')),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('observe','strict')),
  scheme TEXT NOT NULL CHECK (scheme IN ('groth16','plonk')),
  window_ticks INTEGER NOT NULL CHECK (window_ticks IN (4,30,60,120)),
  circuit_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','finished','aborted')),
  winner_index INTEGER CHECK (winner_index IN (0,1)),
  end_reason TEXT CHECK (end_reason IN ('rounds','forfeit_proof','forfeit','disconnect','abort')),
  room_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  total_ticks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_matches_started ON matches (started_at DESC);
CREATE INDEX idx_matches_status ON matches (status);

CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_index INTEGER NOT NULL CHECK (player_index IN (0,1)),
  player_id TEXT NOT NULL REFERENCES players(id),
  rounds_won INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  shots INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  PRIMARY KEY (match_id, player_index),
  UNIQUE (match_id, player_id)
);
CREATE INDEX idx_mp_player ON match_players (player_id);

CREATE TABLE rounds (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL CHECK (round_no >= 1),
  start_tick INTEGER NOT NULL,
  end_tick INTEGER,
  winner_index INTEGER CHECK (winner_index IN (0,1)),
  PRIMARY KEY (match_id, round_no)
);
