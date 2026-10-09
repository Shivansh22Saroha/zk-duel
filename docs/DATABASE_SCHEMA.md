# DATABASE SCHEMA — ZK-Duel

**Engine:** SQLite 3 via `better-sqlite3` (WAL mode, `foreign_keys = ON`)
**File:** `server/data/zkduel.db` (path from `DB_PATH`)
**Migrations:** plain SQL in `server/src/db/migrations/NNN_name.sql`, applied in order, tracked in `schema_migrations`.

Design rule: **no hidden state is ever stored**. Ammo, cooldown, reload timers and salts never reach the server in plaintext, so they cannot appear here. Commitments (hashes) are stored.

## 1. Entity diagram

```
players 1───* match_players *───1 matches
                    │                 │
                    │                 ├──* rounds
                    │                 └──* cheat_events
                    └──* proof_windows
benchmark_runs 1───* benchmark_results
sessions *───1 players
```

## 2. Tables

### `players`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `display_name` | TEXT | NOT NULL, CHECK length 3–16 |
| `created_at` | INTEGER | NOT NULL, unix ms |
| `last_seen_at` | INTEGER | NOT NULL |

Display names are **not unique** (guests). Index: `idx_players_last_seen (last_seen_at)`.

### `sessions`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK (JWT `jti`) |
| `player_id` | TEXT | NOT NULL, FK → players.id ON DELETE CASCADE |
| `created_at` | INTEGER | NOT NULL |
| `expires_at` | INTEGER | NOT NULL |
| `revoked` | INTEGER | NOT NULL DEFAULT 0, CHECK IN (0,1) |

Index: `idx_sessions_player (player_id)`.

### `matches`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `match_field` | TEXT | NOT NULL — first 31 bytes of SHA-256(match ID UUID string) as a big-endian integer (decimal string, always < p), used in the proof `bind` |
| `mode` | TEXT | NOT NULL, CHECK IN ('queue','private','bench') |
| `enforcement` | TEXT | NOT NULL, CHECK IN ('observe','strict') |
| `scheme` | TEXT | NOT NULL, CHECK IN ('groth16','plonk') |
| `window_ticks` | INTEGER | NOT NULL, CHECK IN (4,30,60,120) — 4 is the test variant |
| `circuit_hash` | TEXT | NOT NULL — sha256 of the zkey used |
| `status` | TEXT | NOT NULL, CHECK IN ('active','finished','aborted') |
| `winner_index` | INTEGER | NULL, CHECK IN (0,1) |
| `end_reason` | TEXT | NULL, CHECK IN ('rounds','forfeit_proof','forfeit','disconnect','abort') — `forfeit` = player sent the WS `forfeit` message |
| `room_code` | TEXT | NULL |
| `started_at` | INTEGER | NOT NULL |
| `ended_at` | INTEGER | NULL |
| `total_ticks` | INTEGER | NOT NULL DEFAULT 0 — match-absolute, computed server-side |

Indexes: `idx_matches_started (started_at DESC)`, `idx_matches_status (status)`.

### `match_players`
| Column | Type | Constraints |
|---|---|---|
| `match_id` | TEXT | FK → matches.id ON DELETE CASCADE |
| `player_index` | INTEGER | CHECK IN (0,1) |
| `player_id` | TEXT | NOT NULL, FK → players.id |
| `rounds_won` | INTEGER | NOT NULL DEFAULT 0 |
| `hits` | INTEGER | NOT NULL DEFAULT 0 |
| `shots` | INTEGER | NOT NULL DEFAULT 0 |
| `user_agent` | TEXT | NULL — for benchmark device context |

PK `(match_id, player_index)`. Unique `(match_id, player_id)`. Index `idx_mp_player (player_id)`.

### `rounds`
| Column | Type | Constraints |
|---|---|---|
| `match_id` | TEXT | FK → matches.id ON DELETE CASCADE |
| `round_no` | INTEGER | CHECK ≥ 1 |
| `start_tick` | INTEGER | NOT NULL — match-absolute |
| `end_tick` | INTEGER | NULL — match-absolute |
| `winner_index` | INTEGER | NULL, CHECK IN (0,1) |

PK `(match_id, round_no)`. (The protocol and sim use round-relative ticks; only these columns and `matches.total_ticks` are match-absolute.)

### `proof_windows`
One row per player per window. The core research table.

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT |
| `match_id` | TEXT | NOT NULL, FK → matches.id ON DELETE CASCADE |
| `player_index` | INTEGER | NOT NULL, CHECK IN (0,1) |
| `round_no` | INTEGER | NOT NULL, CHECK ≥ 1 |
| `window_index` | INTEGER | NOT NULL, CHECK ≥ 0 — restarts at 0 each round |
| `start_tick` | INTEGER | NOT NULL — round-relative (= window_index × N) |
| `status` | TEXT | NOT NULL, CHECK IN ('valid','invalid','mismatch_digest','mismatch_commit','mismatch_bind','timeout','malformed','unprovable','chain_broken') |
| `digest` | TEXT | NOT NULL — server-computed digest (decimal string), stored when the window ends |
| `fail_reason` | TEXT | NULL — client-reported `proof_failed.reason` (informational) |
| `commit_in` | TEXT | NULL |
| `commit_out` | TEXT | NULL |
| `prove_ms` | INTEGER | NULL — client-reported, informational only |
| `verify_ms` | REAL | NULL — server-measured |
| `proof_bytes` | INTEGER | NULL |
| `received_at` | INTEGER | NULL |
| `proof_json` | TEXT | NULL — stored only when `STORE_PROOFS=true` |

Unique `(match_id, player_index, round_no, window_index)`.
Indexes: `idx_pw_match (match_id, player_index, round_no, window_index)`, `idx_pw_status (status)`.

### `cheat_events`
| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT |
| `match_id` | TEXT | NOT NULL, FK → matches.id ON DELETE CASCADE |
| `player_index` | INTEGER | NOT NULL, CHECK IN (0,1) |
| `cheat` | TEXT | NOT NULL, CHECK IN ('speedhack','rapid_fire','snap_aim','smooth_aim','infinite_ammo') |
| `enabled` | INTEGER | NOT NULL, CHECK IN (0,1) |
| `round_no` | INTEGER | NOT NULL |
| `tick` | INTEGER | NOT NULL |
| `window_index` | INTEGER | NOT NULL |

Index: `idx_cheat_match (match_id)`. Used to compute detection latency = first non-valid window − activation window.

### `benchmark_runs`
| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `created_at` | INTEGER | NOT NULL |
| `environment` | TEXT | NOT NULL, CHECK IN ('node','browser') |
| `device_label` | TEXT | NOT NULL — e.g. "Laptop i5-1235U 16GB" |
| `user_agent` | TEXT | NULL |
| `cpu_threads` | INTEGER | NULL |
| `input_log` | TEXT | NOT NULL — filename of replayed log |
| `seed` | INTEGER | NOT NULL |
| `git_commit` | TEXT | NULL |
| `notes` | TEXT | NULL |

### `benchmark_results`
| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT |
| `run_id` | TEXT | NOT NULL, FK → benchmark_runs.id ON DELETE CASCADE |
| `scheme` | TEXT | NOT NULL, CHECK IN ('groth16','plonk') |
| `window_ticks` | INTEGER | NOT NULL, CHECK IN (4,30,60,120) |
| `constraints` | INTEGER | NOT NULL |
| `sample_no` | INTEGER | NOT NULL |
| `witness_ms` | REAL | NOT NULL |
| `prove_ms` | REAL | NOT NULL |
| `verify_ms` | REAL | NOT NULL |
| `proof_bytes` | INTEGER | NOT NULL |
| `valid` | INTEGER | NOT NULL, CHECK IN (0,1) |

Unique `(run_id, scheme, window_ticks, sample_no)`. Index `idx_br_run_variant (run_id, scheme, window_ticks)`.

### `schema_migrations`
| Column | Type |
|---|---|
| `version` | INTEGER PK |
| `applied_at` | INTEGER |

## 3. Initial migration (abridged)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 3 AND 16),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE proof_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_index INTEGER NOT NULL CHECK (player_index IN (0,1)),
  round_no INTEGER NOT NULL CHECK (round_no >= 1),
  window_index INTEGER NOT NULL CHECK (window_index >= 0),
  start_tick INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid','invalid','mismatch_digest',
    'mismatch_commit','mismatch_bind','timeout','malformed','unprovable','chain_broken')),
  digest TEXT NOT NULL,
  fail_reason TEXT,
  commit_in TEXT, commit_out TEXT,
  prove_ms INTEGER, verify_ms REAL, proof_bytes INTEGER,
  received_at INTEGER, proof_json TEXT,
  UNIQUE (match_id, player_index, round_no, window_index)
);
-- remaining tables follow §2 exactly
```

## 4. Retention

- `proof_json` off by default (proofs are ~800 B Groth16, larger for PLONK; only stored for audits).
- Raw per-tick snapshots are **not** persisted by default (memory only: the current window's snapshots; after each window only its digest and last snapshot are kept). `LOG_SNAPSHOTS=true` writes them to `server/data/logs/<matchId>.jsonl` for benchmark input logs.
- Sessions older than 7 days are pruned at boot.

## 5. Useful queries

```sql
-- Detection latency per cheat activation
SELECT c.cheat, MIN(p.window_index) - c.window_index AS windows_to_detect
FROM cheat_events c
JOIN proof_windows p ON p.match_id = c.match_id
  AND p.player_index = c.player_index AND p.round_no = c.round_no
  AND p.window_index >= c.window_index AND p.status <> 'valid'
WHERE c.enabled = 1
GROUP BY c.id;

-- Prove-time percentiles per variant (compute p95 in app code)
SELECT scheme, window_ticks, COUNT(*), AVG(prove_ms), AVG(verify_ms), AVG(proof_bytes)
FROM benchmark_results WHERE run_id = ? GROUP BY scheme, window_ticks;
```
