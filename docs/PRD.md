# PRD — ZK-Duel

**Product:** ZK-Duel — a 1v1 browser shooter with zero-knowledge rule-compliance proofs
**Owner:** Shivansh Saroha
**Context:** CSC301 Seminar, The NorthCap University, Jul–Dec 2026
**Status:** Draft v1.0 (2026-10-09)

---

## 1. Purpose

The seminar identified four research gaps (no concrete ZKP protocol for esports fairness claims; no real-time latency feasibility study; no hybrid ZKP + existing-defence architecture; no ZKP-oriented dataset). ZK-Duel exists to produce **measured evidence** for Objectives 3 and 4:

- **Objective 3:** Compare zk-SNARK schemes (Groth16, PLONK) on proof time, verify time, proof size and constraint count against real-time tick budgets.
- **Objective 4:** Prototype a hybrid model — ZKP for auditable rule claims, server-side checks for everything ZKP can't cover.

The game must be small, stable and fun enough to play a real match. Every feature serves the research.

## 2. Goals

| ID | Goal | Measured by |
|---|---|---|
| G1 | A playable, stable 1v1 match over a LAN or localhost | 10 consecutive matches finish without desync or crash |
| G2 | Each client commits to every window of N ticks and proves rule compliance for every window — challenged windows live, all others in the post-match audit | Clean match: 100% of windows committed, every challenge `valid`, audit ends `audited_clean` (≥ 99% of windows proven within `AUDIT_TIMEOUT_MIN`) |
| G3 | Proving does not block gameplay | Client frame time stays < 20 ms p95 while proving |
| G4 | Every rule-breaking cheat is caught (smooth-aim is expected to pass) | A match with a rule-breaking cheat is never `audited_clean`: the cheating window fails its challenge live (probability ≈ 1 − (1 − r)^m for m cheating windows at challenge rate r — measured and reported) or fails in the post-match audit |
| G5 | Reproducible benchmarks | Benchmark run exports CSV for 3 window sizes × 2 schemes × ≥ 20 samples |
| G6 | Hidden state stays hidden | Opponent and server never receive ammo, cooldown, reload timer or salt in plaintext |

## 3. Non-goals

- Matchmaking at scale, ranked ladders, cosmetics, chat, accounts with passwords, mobile touch controls.
- Production anti-cheat. No kernel components, no anti-tamper, no obfuscation.
- Proving every single tick in real time (expected to be infeasible — this is a finding, not a failure).
- Proving that inputs came from a human (impossible with ZKPs alone — see SECURITY.md §7).
- 3D gameplay, physics engines, sound design beyond simple SFX. (Phase 4.5 adds a **3D renderer** — presentation only: the game stays 2D and integer, see UI_UX_SPEC §3.3.)

## 4. Users

| User | Need |
|---|---|
| **Player** (classmate, examiner) | Join a match quickly, play, see the proof status live |
| **Researcher** (Shivansh) | Run benchmarks, toggle cheats, export data for the report and viva |
| **Examiner / Mentor** | Watch a live demo where a cheat is turned on and the proof fails |

## 5. Core game rules (fixed numbers — source of truth `shared/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `TICK_RATE` | 60 | Simulation ticks per second |
| `ARENA_W` × `ARENA_H` | 1000 × 600 | Arena size in integer units |
| `PLAYER_RADIUS` | 12 | Collision radius |
| `MAX_SPEED` | 4 | Max |Δx| and max |Δy| per tick |
| `ANGLE_UNITS` | 3600 | Angle in tenths of a degree, 0–3599 |
| `MAX_TURN` | 150 | Max shortest-arc angle change per tick (15° → 900°/s) |
| `MAG_SIZE` | 10 | Rounds per magazine |
| `FIRE_COOLDOWN` | 12 | Ticks between shots (5 shots/s) |
| `RELOAD_TICKS` | 90 | Reload duration (1.5 s) |
| `MAX_HP` | 100 | Health |
| `DAMAGE` | 25 | Damage per hit (4 hits to kill) |
| `ROUNDS_TO_WIN` | 3 | Best of 5 rounds |
| `WINDOW_TICKS` | 60 | Default proof window (bench: 30, 60, 120) |
| `PROOF_GRACE_WINDOWS` | 2 | Late snapshots accepted up to 2 windows behind; window k's digest is final at the latest at the end of window k+2 |
| `PROOF_DEADLINE_MS` | 15000 | A challenged window's proof must arrive within this time (server env override) |
| `AUDIT_TIMEOUT_MIN` | 60 | Post-match audit proofs accepted for this long (server env override) |
| `SPAWNS` | P0 `(150,300)` angle 0; P1 `(850,300)` angle 1800 | Fixed round spawns (also each round's `prevSnapshot`, with `fired=0`) |
| `RAY_LENGTH` | 1200 | Hit-scan ray length |
| `TRIG_SCALE` | 1024 | Integer sin/cos table scale |
| `ROUND_PAUSE_TICKS` | 90 | Pause between rounds (1.5 s) |
| `STALL_TICKS` | 6 | Max ticks a missing snapshot is held before the player is `stalled` |
| `RECONNECT_TIMEOUT_MS` | 10000 | Disconnect longer than this forfeits |

All positions and angles are **integers**. No floats inside game state. Rendering may interpolate with floats, but state never does.

## 6. Functional requirements

### 6.1 Session & lobby
- **FR-1** Player enters a display name (3–16 chars, `[A-Za-z0-9_]`) and receives a guest session token. No password.
- **FR-2** Player presses *Find Match*; the server pairs the first two waiting players (FIFO queue).
- **FR-3** Player can cancel the queue.
- **FR-4** A *Private Room* option creates a 6-character room code another player can join.

### 6.2 Match
- **FR-5** Server sends `match_found` with match ID, player index (0/1), spawn points and the public initial-state commitment.
- **FR-6** Countdown 3-2-1, then the match starts at tick 0.
- **FR-7** Controls: WASD move (each held axis steps exactly `MAX_SPEED` units per tick, so a diagonal move is ≈ 5.66 units/tick — accepted as the rule), mouse aim, left-click fire, R reload.
- **FR-8** Each tick the client sends a **public snapshot** `{tick, x, y, angle, fired}` to the server.
- **FR-9** Server is authoritative for hits: on `fired=1` it ray-casts from the shooter's snapshot position along its angle against the opponent's circle; on hit it applies `DAMAGE`.
- **FR-10** Server broadcasts the merged state to both clients each tick.
- **FR-11** Round ends at HP 0; next round respawns both at fixed spawns. Match ends at `ROUNDS_TO_WIN` or on forfeit/disconnect.
- **FR-12** Ammo, cooldown and reload timer are tracked **only on the client** and are never sent in plaintext.

### 6.3 Proofs
(Phase 3 design change — "commit every window, prove on challenge, audit after the match"; ARCHITECTURE.md §4.)
- **FR-13** At the end of every window the client sends `window_commit` with a commitment to its hidden state after the window (fresh random salt). The client keeps every window's private input until the match's audit ends. A commit missing by the end of the next window is `missing_commit` and breaks the chain for the rest of the round.
- **FR-14** During play the server challenges one ended, committed, unproven window at a time per player, chosen uniformly at random with crypto randomness (unpredictable to the client). The client's proof worker proves the challenged window (Groth16, ARCHITECTURE.md §5) while play continues and sends `window_proof` (or `proof_failed`) before `PROOF_DEADLINE_MS`.
- **FR-15** The server recomputes the public snapshot digest from snapshots it received, checks it matches the proof's public signal, checks `commitIn`/`commitOut` against the commitments the client claimed for windows k−1 and k (round's `initialCommit` for k = 0), and verifies the proof.
- **FR-16** Result per window (full list and order in API_SPEC.md §5): `committed` (claimed, not yet proven), `valid`, `malformed`, `mismatch_bind`, `mismatch_digest`, `mismatch_commit`, `missing_commit`, `invalid`, `unprovable` (client reported that no proof could be generated), `timeout` (challenge deadline passed), `chain_broken` (an earlier window's commit is missing, or a disconnect gap — the window cannot be verified), `unaudited` (never proven by the end of the audit).
- **FR-16a** After `match_end` the client proves every remaining committed window (one at a time) — the post-match **audit**; the server accepts audit proofs for `AUDIT_TIMEOUT_MIN`. Match audit status: `audited_clean`, `audited_failed` or `audit_incomplete`. An audit failure of the winner marks the result `overturned` without rewriting the recorded result.
- **FR-17** Enforcement mode per match: `observe` (log only) or `strict` (the first failed challenge or `missing_commit` forfeits the match live). Default `observe` for benchmarking, `strict` for demos.
- **FR-18** HUD shows a strip of the last 10 windows for both players (committed = hollow cell, challenged/proving = ◌, valid = ✓, failed = ✕, chain_broken = ⛓) and a live "Spot-checks: 7/7 passed" counter per player.

### 6.4 Cheats (dev only)
- **FR-19** When `DEV_CHEATS=true`, F9 opens a cheat panel with toggles: speedhack (×2 speed), rapid-fire (cooldown 0), snap-aimbot (instant turn to opponent), infinite ammo, smooth-aimbot (turns toward opponent at `MAX_TURN`).
- **FR-20** Cheats modify the *client's real state*, so the prover honestly runs over cheating data, not faked data. Because the rules are circuit constraints, witness generation fails and no proof exists for the cheating window: when that window is challenged (or audited) the honest dev client sends `proof_failed` and the server records `unprovable`. A cheater who stays silent instead gets `timeout` (challenge) or `unaudited` (audit) — the match is never `audited_clean`; that is the actual security guarantee.
- **FR-21** Each cheat activation is recorded in `cheat_events` with the window it started in.

### 6.5 Results & benchmarks
- **FR-22** Results screen: winner, rounds, per-player window counts by status, mean/p95 proof time, mean verify time; live audit progress ("Auditing… 23/150 windows"), final audit status and `overturned` banner; research metrics (challenge count, challenge rate r, live detection latency, audit duration).
- **FR-23** Benchmark mode (`/bench` page and CLI) runs fixed recorded inputs through each circuit variant and stores results.
- **FR-24** Benchmark dashboard shows charts (proof time vs window size, per scheme) and exports CSV.

## 7. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Server tick loop: 60 Hz with < 2 ms processing per tick for one match |
| NFR-2 | Client render: 60 fps target, < 20 ms p95 frame time while proving |
| NFR-3 | LAN round-trip latency budget: playable up to 80 ms RTT |
| NFR-4 | Proof verification: < 50 ms per proof on the server |
| NFR-5 | Works in latest Chrome and Firefox; no install beyond the browser |
| NFR-6 | All game constants defined once in `shared/constants.ts` and compiled into the circuit as parameters |
| NFR-7 | All benchmark numbers reproducible from a stored seed + input log |

## 8. Success criteria for the seminar

1. Live demo: clean match → every spot-check green, audit `audited_clean`; toggle speedhack → caught by a spot-check during play or by the audit (never `audited_clean`), with the measured live detection probability.
2. A chart of proof time vs window size for Groth16 and PLONK, with the 60 Hz budget line drawn.
3. A clear statement of the smallest window that can be proven within the next window's play time on a mid-range laptop.
4. Smooth-aimbot demo passing, with the explanation of why (the input-provenance limit).

## 9. Assumptions & open questions

- Browser proving speed is unknown until measured; estimate ~40–60k constraints for a 60-tick window. A bigger window does **not** fix a slow prover (prove time and play time both scale with N). If proving is slower than real time, that is a finding: proofs lag behind play, the result is framed as near-real-time / post-match audit, and the real prove/play ratio is reported.
- Walls/obstacles are excluded from the circuit in v1 (bounds check only). Obstacles are a stretch goal (TODO.md).
- Trusted setup for Groth16 uses a public Powers-of-Tau file plus a local phase-2 contribution — acceptable for a prototype, documented in SECURITY.md.

## 10. Milestones

| Week (from 2026-10-12) | Milestone |
|---|---|
| 1–2 | Playable game, no ZK, snapshots logged to SQLite |
| 3–4 | `window.circom` passes tests on logged data |
| 5–6 | Worker proving, server verify, HUD strip, cheat panel |
| 7–8 | Benchmarks, charts, report write-up |
