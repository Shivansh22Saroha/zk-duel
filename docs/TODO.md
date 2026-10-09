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
- [ ] `shared/sim.ts`: movement, aim, weapon rules + unit tests
- [ ] Integer sin/cos table (scale 1024) for rays and aim line
- [ ] Client: fixed-step loop, input (pointer lock), renderer, interpolation
- [ ] Server: Fastify + ws, guest auth, queue, `MatchRoom` tick loop
- [ ] Server hit detection + rounds + match end
- [ ] SQLite migrations: players, sessions, matches, match_players, rounds
- [ ] Landing, queue, match HUD (no proof strip yet), results screens
- [ ] `LOG_SNAPSHOTS` to produce input logs for later testing
- [ ] **Exit check:** automated bot-driven matches (≥ 10 full matches over real sockets) with no desync, plus a manual playtest by the owner before approval

## Phase 2 — Circuit (Weeks 3–4) — P0
- [ ] `circuits/window.circom` with templates: `DigestChain`, `MoveCheck`, `TurnCheck`, `WeaponStep`, `Commit`
- [ ] Build script templating constants from `shared/constants.ts` into `main_<N>.circom`
- [ ] Test circuit N=4; positive + negative tests for every rule (TESTING.md §3)
- [ ] Property tests with fast-check
- [ ] circomspect clean
- [ ] Full N=60 Groth16 build; record constraint count
- [ ] JS reference (`shared/poseidon.ts`, digest + commitment) matches circuit outputs
- [ ] **Exit check:** proofs generated offline from Phase 1 logs all verify; mutated logs all fail

## Phase 3 — Live proving & verification (Weeks 5–6) — P0
- [ ] Client artefact loader + SHA-256 check + Cache API
- [ ] WindowRecorder + partial-window padding
- [ ] Proof Worker (snarkjs in Web Worker), queue cap 2
- [ ] Server `DigestBuilder`, commitment chain store, `VerifierPool` (worker_threads)
- [ ] Status pipeline: chain_broken → malformed → bind → digest → commit → verify; `proof_failed` → unprovable; timeout sweep; window-order decisions
- [ ] `proof_windows` table + `proof_result` messages
- [ ] Proof strip HUD + tooltips
- [ ] Enforcement modes (observe/strict)
- [ ] Reconnect flow with `resume` message (chain broken for the rest of the round, fresh chain next round)
- [ ] **Exit check:** clean 3-minute match, 100% `valid`, frame time p95 < 20 ms

## Phase 4 — Cheats & demo (Week 6) — P0
- [ ] Cheat module behind `VITE_DEV_CHEATS` / `DEV_CHEATS`
- [ ] Speedhack, rapid-fire, infinite ammo, snap-aim, smooth-aim
- [ ] `cheat_events` table, `cheat_flag` broadcast, `CHEAT` tag in UI
- [ ] Private rooms with enforcement choice
- [ ] **Exit check:** E2E-2 and E2E-3 pass

## Phase 5 — Benchmarks (Week 7) — P0
- [ ] Build all 6 variants (groth16/plonk × 30/60/120)
- [ ] `bench/run.ts` (Node) + `/bench` browser runner
- [ ] `benchmark_runs` / `benchmark_results` tables + upload endpoint
- [ ] Dashboard charts with real-time reference lines + CSV export
- [ ] Run on baseline laptop (≥ 20 samples per variant) and one stronger machine
- [ ] **Exit check:** CSV + charts ready for the report

## Phase 6 — Write-up & polish (Week 8) — P0
- [ ] Results section for the seminar report: tables, charts, detection-latency stats
- [ ] Limitations section (smooth-aim / input provenance, single-party phase-2 setup, no walls in circuit)
- [ ] Update final PPT with live-demo screenshots and benchmark charts
- [ ] Demo checklist (TESTING.md §9) run twice
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
- [ ] Browser Groth16 proving time for ~50k constraints is unmeasured. A bigger window does not help (prove and play time both scale with N). If proving is slower than real time, report the real prove/play ratio as a finding (proofs lag play → near-real-time / post-match audit)
- [ ] snarkjs worker threads may hurt frame time; measure and, if needed, cap thread usage and report the setting
- [ ] PLONK zkey and proof sizes may be large; check download size before using PLONK for live play (benchmark-only is acceptable)
- [ ] Confirm current official ptau download URL and checksum at setup

## Bugs
_None yet — log here with steps to reproduce, expected vs actual, and the affected variant._
