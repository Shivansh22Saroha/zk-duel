-- 005_bench: benchmark runs and samples (docs/DATABASE_SCHEMA.md §2, Phase 5).
-- Additions to the documented columns (owner request, Phase 5): input_log_sha256 (identical inputs
-- across Node and browser runs) and peak_mem_mb per sample (where measurable).

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('node','browser')),
  device_label TEXT NOT NULL,
  user_agent TEXT,
  cpu_threads INTEGER,
  input_log TEXT NOT NULL,
  input_log_sha256 TEXT,
  seed INTEGER NOT NULL,
  git_commit TEXT,
  notes TEXT
);

CREATE TABLE benchmark_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL CHECK (scheme IN ('groth16','plonk')),
  window_ticks INTEGER NOT NULL CHECK (window_ticks IN (4,30,60,120)),
  constraints INTEGER NOT NULL,
  sample_no INTEGER NOT NULL,
  witness_ms REAL NOT NULL,
  prove_ms REAL NOT NULL,
  verify_ms REAL NOT NULL,
  proof_bytes INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0,1)),
  peak_mem_mb REAL,
  UNIQUE (run_id, scheme, window_ticks, sample_no)
);
CREATE INDEX idx_br_run_variant ON benchmark_results (run_id, scheme, window_ticks);
