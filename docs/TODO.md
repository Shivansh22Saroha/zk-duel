# TODO — ZK-Duel

Ordered by phase. Do each phase fully (tests passing) before starting the next. Week numbers count from Monday 2026-10-12. Final evaluation: December 2026.

Legend: `[ ]` open · `[~]` in progress · `[x]` done · **P0** must-have · **P1** should-have · **P2** stretch

---

## Phase 0 — Repo setup (Week 1, first 2 days) — P0
- [x] npm workspaces: `client`, `server`, `shared`, `circuits`, `bench`
- [x] TypeScript strict config, ESLint, Prettier
- [x] `shared/constants.ts` with every PRD §5 constant
- [x] `shared/protocol.ts` zod schemas for all WS messages and REST bodies
- [x] Install circom 2.2.x, snarkjs, circomlib; verify `circom --version`
- [x] Download and checksum the ptau file (power chosen per variant from real constraint counts in Phase 2/5; Phase 0 fetches the file needed for the test + N=60 builds)
- [x] GitHub Actions `ci.yml` skeleton (lint, typecheck, test)
- [x] Record pinned versions in CHANGELOG.md

## Phase 1 — Playable game, no ZK (Weeks 1–2) — P0
- [x] `shared/sim.ts`: movement, aim, weapon rules + unit tests
- [x] Integer sin/cos table (scale 1024) for rays and aim line
- [x] Client: fixed-step loop, input (pointer lock), renderer, interpolation
- [x] Server: Fastify + ws, guest auth, queue, `MatchRoom` tick loop
- [x] Server hit detection + rounds + match end
- [x] SQLite migrations: players, sessions, matches, match_players, rounds
- [x] Landing, queue, match HUD (no proof strip yet), results screens
- [x] `LOG_SNAPSHOTS` to produce input logs for later testing (server: public only; client-side logs with private state via `npm run bots` / `VITE_LOG_TICKS`)
- [~] **Exit check:** automated bot-driven matches (≥ 10 full matches over real sockets) with no desync ✅ — manual playtest by the owner pending

## Phase 2 — Circuit (Weeks 3–4) — P0
- [x] `circuits/window.circom` with templates: `DigestChain`, `BoundsCheck`, `SpeedCheck`, `TurnCheck`, `WeaponStep`, `Commit`, `Bind` (each in `circuits/src/`, tested on its own)
- [x] Build script templating constants from `shared/constants.ts` into `main_<N>.circom`
- [x] Test circuit N=4; positive + negative tests for every rule (TESTING.md §3)
- [x] Property tests with fast-check
- [x] circomspect clean (in CI: `npm run circuits:lint`)
- [x] Full N=60 Groth16 build; record constraint count (32,748)
- [x] JS reference (`shared/poseidon.ts`, `shared/zkInput.ts`) matches circuit outputs
- [x] **Exit check:** proofs generated offline from Phase 1 logs all verify (26/26 windows, 4 logs); mutated logs fail exactly at the cheating window (speed, rapid-fire, infinite ammo)
- [x] **Decision before Phase 3:** owner chose (a) measure browser proving, then (d) "commit every window, prove on challenge, audit after the match" (CHANGELOG "Phase 3 design change")

## Phase 3 — Commit, challenge & audit (Weeks 5–6) — P0
Design changed before coding (CHANGELOG "Phase 3 design change"): commit every window, prove on challenge, audit after the match.
- [x] Ammo-safety check: "ammo ≠ MAG" safe on every state reachable from `initialCommit` (`circuits/test/ammoSafety.test.ts`)
- [x] Step 1: browser proving measured (groth16_60 + groth16_30, 10 real windows each, thread sweep, frame time) → `PROOF_DEADLINE_MS`
- [x] Docs updated for the design change (ARCHITECTURE §4/§5, API_SPEC, PRD, FEATURES F9–F12, DATABASE_SCHEMA, SECURITY, UI_UX, USER_FLOWS, TESTING, ENVIRONMENT)
- [x] Client artefact loader + SHA-256 check + Cache API; server checks `ready.artefactSha256`
- [x] WindowRecorder + partial-window padding + `window_commit`; private inputs kept until the audit ends
- [x] Proof Worker (snarkjs in Web Worker) + Proof Queue (challenge first, audit after the match)
- [x] Server `DigestBuilder`, commit store, challenge scheduler (crypto randomness), `VerifierPool` (worker_threads) — re-measure verify p95 there
- [x] Digest finalisation waits for late honest snapshots: window k's digest is finalised only when the snapshot for its last tick has arrived **or** the grace deadline (end of window k + PROOF_GRACE_WINDOWS) passes, so a late honest snapshot never causes `mismatch_digest` (ARCHITECTURE §4). Late snapshots older than PROOF_GRACE_WINDOWS × WINDOW_TICKS are already rejected with a strike (Phase 1 follow-up)
- [x] Status pipeline: malformed → bind → digest → commitIn → commitOut → verify; `proof_failed` → unprovable; challenge timeout; `missing_commit` → chain_broken
- [x] Post-match audit (`AUDIT_TIMEOUT_MIN`): `unaudited`, `audit_status`, `overturned`, `audit_end`
- [x] Research metrics per match: challenge count, challenge rate r, audit duration (detection latency: column now, filled once `cheat_events` exist in Phase 4)
- [x] `proof_windows` table (migration 002) + `proof_result` / `challenge` / `audit_end` messages
- [x] Proof strip HUD (hollow / ◌ / ✓ / ✕ / ⛓) + "Spot-checks: 7/7 passed" + tooltips; results screen audit progress + status + metrics
- [x] Enforcement modes (observe/strict: forfeit on a failed challenge)
- [x] Reconnect flow with `resume` (outstanding challenge + held commits; chain broken for the rest of the round, fresh chain next round)
- [~] **Exit check:** clean 3-minute match — all challenges valid, full audit `audited_clean`; frame time p95 < 20 ms while proving; scripted cheater never `audited_clean`; frame inspector clean

## Phase 4 — Cheats & demo (Week 6) — P0
- [ ] Cheat module behind `VITE_DEV_CHEATS` / `DEV_CHEATS`
- [ ] Speedhack, rapid-fire, infinite ammo, snap-aim, smooth-aim
- [ ] `cheat_events` table, `cheat_flag` broadcast, `CHEAT` tag in UI
- [ ] Private rooms with enforcement choice
- [ ] **Exit check:** E2E-2 and E2E-3 pass

## Phase 5 — Benchmarks (Week 7) — P0
- [ ] Build all 6 variants (groth16/plonk × 30/60/120)
- [ ] `bench/run.ts` (Node) + `/bench` browser runner (extends the Phase 3 dev page `client/bench.html`)
- [ ] Benchmark export includes the per-match research metrics (challenge count, rate r, detection latency, audit duration)
- [ ] `benchmark_runs` / `benchmark_results` tables + upload endpoint
- [ ] Dashboard charts with real-time reference lines + CSV export
- [ ] Run on baseline laptop (≥ 20 samples per variant) and one stronger machine
- [ ] **Exit check:** CSV + charts ready for the report

## Phase 6 — Write-up & polish (Week 8) — P0
- [ ] Results section for the seminar report: tables, charts, detection-latency stats
- [ ] Limitations section (smooth-aim / input provenance, single-party phase-2 setup, no walls in circuit)
- [ ] Update final PPT with live-demo screenshots and benchmark charts
- [ ] Demo checklist (TESTING.md §9) run twice
- [ ] 3D renderer (Three.js), 2D rules unchanged — a new `GameRenderer` implementation behind the seam in `client/src/game/view.ts` (draws `RenderFrame`); sim, input and networking untouched
- [ ] CHANGELOG entry for v1.0.0

---

## Stretch goals — P2
- [ ] Rectangular obstacles checked in-circuit (point-outside-rect constraints)
- [ ] Recursive / aggregated proofs (one proof per round instead of per window)
- [ ] Compare a third proving system (Noir/Barretenberg or Halo2) for Objective 3
- [ ] Multi-party phase-2 ceremony among classmates for the Groth16 zkey
- [ ] Server-side "hybrid" detector: simple statistical aim-smoothness heuristic layered over ZKP results (Objective 4 demo)
- [ ] Fog-of-war: hide opponent position when out of line of sight, proving visibility honestly
- [ ] Rapidsnark native prover comparison (Node benchmarks only)

## P1 — after Phase 4
- [ ] Match history: `GET /api/matches`, "My matches" list (F16, Flow 8)

## Known risks / open questions
- [x] Browser Groth16 proving time measured (Phase 3 Step 1): N=60 prove p50 1.58 s (1.6× real time), N=30 1.01 s (2.0×) in Chrome on the dev laptop → commit/challenge/audit design
- [x] snarkjs worker threads vs frame time: no effect measured (12 threads = hardwareConcurrency; capping only slows proving) — default kept
- [ ] PLONK zkey and proof sizes may be large; check download size before using PLONK for live play (benchmark-only is acceptable)
- [ ] Confirm current official ptau download URL and checksum at setup

## Bugs
- Phase 3 exit check pending on AC power: last browser runs were on battery (Chrome capped at 30 Hz). Re-run `npm run perf:match -- --acc 1800 --stop-after 180` plugged in.
