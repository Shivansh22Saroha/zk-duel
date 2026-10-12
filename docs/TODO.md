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
- [x] Follow-ups: per-player audit status, AUDIT_TIMEOUT_MIN 60, audit survives reloads (IndexedDB + resume, e2e test), production perf build, Node vs Chrome investigated
- [x] **Exit check:** clean 3-minute match — all challenges valid, full audit `audited_clean`; frame time p95 < 20 ms while proving; scripted cheater never `audited_clean`; frame inspector clean ✅ (CHANGELOG Phase 3; worst case: both players on one laptop)

## Phase 4 — Cheats, private rooms & the detection experiment (Week 6) — P0
- [x] Audit policy gap: winner's audit incomplete → result `unverified` (migration 004, results stamp, docs)
- [x] Cheat module behind `VITE_DEV_CHEATS` / `DEV_CHEATS` (dynamic import; absent from builds without the flag)
- [x] Speedhack, rapid-fire, infinite ammo, snap-aim, smooth-aim (F9 drawer)
- [x] `cheat_events` table, `cheat_flag` broadcast, `CHEAT` tag in UI; live detection latency
- [x] Private rooms with enforcement choice (create/join by code, creator joins too)
- [x] Detection experiment: `npm run exp:detect` (Node matrix: 4 cheats × m ∈ {1,5,20} × 10 + smooth-aim control × 10), `npm run exp:browser` (one live run per cheat), `detection_runs`, `bench/out/detection.csv`
- [x] Tests: E2E-2, E2E-3 (`npm run e2e:cheats`), winner closes the tab during the audit → `unverified` (integration)
- [x] **Exit check:** rule-breaking cheats 124/124 `audited_failed`; smooth-aim 11/11 `audited_clean`; private rooms in two browser windows; frame inspector clean. Live catch vs 1 − (1 − r)^m: matches for m ≥ 5, under-predicts m = 1 (85 % observed vs 55 %; scheduler-aware 81 %) — reported (CHANGELOG Phase 4)

## Phase 4.5 — 3D renderer (before benchmarks) — owner request
- [x] Three.js renderer behind the `GameRenderer` seam; Canvas 2D kept as fallback (`?renderer=2d`, and when WebGL is unavailable)
- [x] Camera modes on V: first-person (yaw, no pitch, crosshair) and angled top-down
- [x] First-person WASD facing-relative (input only; owner request 2026-10-12)
- [x] Arena floor + grid + low walls + lighting; capsule players with aim direction; tracers + hit flash; interpolation unchanged
- [x] HTML overlays unchanged (HUD, strips, cheat drawer, banners); UI_UX colours
- [x] Frame time p50/p95 while proving in both renderers (production build, AC) — CHANGELOG Phase 4.5
- [x] UI_UX_SPEC, TECH_STACK, CHANGELOG updated

## Phase 5 — Benchmarks (Week 7) — P0
- [x] Build all 6 variants (groth16/plonk × 30/60/120)
- [x] `bench/run.ts` (Node) + `/bench` browser runner (extends the Phase 3 dev page `client/bench.html`)
- [x] Benchmark export includes the per-match research metrics (challenge count, rate r, detection latency, audit duration)
- [x] `benchmark_runs` / `benchmark_results` tables + upload endpoint
- [x] Dashboard charts with real-time reference lines + CSV export
- [x] Run on baseline laptop (Groth16 ≥ 20 samples per variant; PLONK fewer, owner decision — `bench/RESULTS.md`)
- [ ] Run on one stronger machine — **deferred to future work (not done)**; noted in RESULTS.md limitations
- [x] **Exit check:** CSV + charts ready for the report

## Phase 6 — Write-up & polish (Week 8) — P0
- [ ] Results section for the seminar report: tables, charts, detection-latency stats
- [ ] Limitations section (smooth-aim / input provenance, single-party phase-2 setup, no walls in circuit)
- [ ] Update final PPT with live-demo screenshots and benchmark charts
- [ ] Demo checklist (TESTING.md §9) run twice
- [x] 3D renderer (Three.js), 2D rules unchanged — done early as Phase 4.5
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
- [x] Browser Groth16 proving time measured (Phase 3 Step 1): N=60 prove p50 1.42 s (1.42× real time), N=30 0.89 s (1.78×) in Chrome on the dev laptop, AC power → commit/challenge/audit design
- [x] snarkjs worker threads vs frame time: no effect measured (12 threads = hardwareConcurrency; capping only slows proving) — default kept
- [ ] PLONK zkey and proof sizes may be large; check download size before using PLONK for live play (benchmark-only is acceptable)
- [ ] Confirm current official ptau download URL and checksum at setup

## Bugs
_None open._
