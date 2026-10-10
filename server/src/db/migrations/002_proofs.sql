-- 002_proofs: Phase 3 — commit every window, prove on challenge, audit after the match
-- (docs/DATABASE_SCHEMA.md §2). Commitments and digests are hashes; no hidden state is stored.

CREATE TABLE proof_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_index INTEGER NOT NULL CHECK (player_index IN (0,1)),
  round_no INTEGER NOT NULL CHECK (round_no >= 1),
  window_index INTEGER NOT NULL CHECK (window_index >= 0),
  start_tick INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed','valid','invalid','mismatch_digest',
    'mismatch_commit','mismatch_bind','missing_commit','timeout','malformed','unprovable',
    'chain_broken','unaudited')),
  digest TEXT,
  challenged INTEGER NOT NULL DEFAULT 0 CHECK (challenged IN (0,1)),
  challenged_at INTEGER,
  decided_phase TEXT CHECK (decided_phase IN ('live','audit')),
  fail_reason TEXT,
  commit_in TEXT,
  commit_out TEXT,
  prove_ms INTEGER,
  verify_ms REAL,
  proof_bytes INTEGER,
  received_at INTEGER,
  proof_json TEXT,
  UNIQUE (match_id, player_index, round_no, window_index)
);
CREATE INDEX idx_pw_match ON proof_windows (match_id, player_index, round_no, window_index);
CREATE INDEX idx_pw_status ON proof_windows (status);

ALTER TABLE matches ADD COLUMN audit_status TEXT
  CHECK (audit_status IN ('auditing','audited_clean','audited_failed','audit_incomplete'));
ALTER TABLE matches ADD COLUMN overturned INTEGER NOT NULL DEFAULT 0 CHECK (overturned IN (0,1));
ALTER TABLE matches ADD COLUMN audit_ended_at INTEGER;

ALTER TABLE match_players ADD COLUMN windows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN windows_committed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN challenges INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN challenges_passed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN challenge_rate REAL;
ALTER TABLE match_players ADD COLUMN detection_latency_windows INTEGER;
ALTER TABLE match_players ADD COLUMN audit_ms INTEGER;
