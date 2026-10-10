-- 004_phase4: result verdict, cheat events, detection metrics, detection experiment rows.

-- What the audit says about the recorded result (the result itself is never rewritten):
--   verified    winner's own audit clean
--   overturned  winner's audit failed            (matches.overturned = 1 as before)
--   unverified  winner's audit incomplete (unaudited / chain_broken windows), e.g. the winner closed
--               the tab during the audit
--   NULL        no winner, or no windows at all
ALTER TABLE matches ADD COLUMN result_verdict TEXT
  CHECK (result_verdict IN ('verified','overturned','unverified'));

-- docs/DATABASE_SCHEMA.md §2 (+ created_at for latency in seconds)
CREATE TABLE cheat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_index INTEGER NOT NULL CHECK (player_index IN (0,1)),
  cheat TEXT NOT NULL CHECK (cheat IN ('speedhack','rapid_fire','snap_aim','smooth_aim','infinite_ammo')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  round_no INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  window_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cheat_match ON cheat_events (match_id);

-- epoch ms when a window's result was decided (live detection latency in seconds)
ALTER TABLE proof_windows ADD COLUMN decided_at INTEGER;
ALTER TABLE match_players ADD COLUMN detection_latency_ms INTEGER;

-- Detection experiment (Phase 4): one row per experiment match.
CREATE TABLE detection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('node','browser')),
  cheat TEXT NOT NULL CHECK (cheat IN ('speedhack','rapid_fire','snap_aim','smooth_aim','infinite_ammo')),
  window_ticks INTEGER NOT NULL,
  m_nominal INTEGER NOT NULL,           -- windows the cheat was switched on for
  m_effective INTEGER NOT NULL,         -- windows that actually contain a rule violation
  windows INTEGER NOT NULL,             -- cheater's windows in the match
  challenges INTEGER NOT NULL,
  challenge_rate REAL,                  -- r achieved (cheater)
  predicted_live REAL,                  -- 1 − (1 − r)^m_effective
  caught_live INTEGER NOT NULL CHECK (caught_live IN (0,1)),
  latency_windows INTEGER,              -- activation window → first failed challenge
  latency_ms INTEGER,
  caught_audit INTEGER NOT NULL CHECK (caught_audit IN (0,1)),
  final_status TEXT,                    -- matches.audit_status
  cheater_status TEXT,                  -- cheater's own audit status
  device_label TEXT,
  notes TEXT
);
CREATE INDEX idx_detection_cheat ON detection_runs (cheat, m_nominal);
