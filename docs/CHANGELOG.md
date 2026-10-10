# CHANGELOG — ZK-Duel

All notable changes are recorded here. Format based on *Keep a Changelog*; versions follow SemVer. Circuit releases are tagged separately (`circuits-vX.Y.Z`) because any circuit change invalidates old proofs and benchmark comparability.

Every entry that changes the circuit must state: new constraint count per variant, and whether `publicSignalOrder` changed.

---

## [Unreleased]

### Planned (see TODO.md)
- Phase 3: commit / challenge / audit (design change below).

### Phase 3 — Commit, challenge & audit — 2026-10-10
#### Added
- **Shared:** `window_commit`, `challenge`, `audit_end` messages; `matchId` on `window_proof`/`proof_failed`/`proof_result`; `phase` on `proof_result`; `resume.committed` + `resume.challenge`; `match_found.variant`; `match_end.auditTimeoutMs`; statuses `committed`, `missing_commit`, `unaudited`; `FAILURE_STATUSES`; `ClientFrame` type. Constants `PROOF_DEADLINE_MS` (15 000), `AUDIT_TIMEOUT_MIN` (30), `RATE_LIMIT_COMMITS_PER_S` (20, new: N=4 commits 15/s). `poseidonSync` (after `poseidonReady`) for the per-tick digest. Tick-log `window` line (salts + commitment, client logs only).
- **Server (`server/src/zk/`):** `DigestBuilder` (hashes tick t only when t ≤ processed tick and its value is final: arrived, skipped, or past the late bound; round-end padding; mid-round cut-off), `ProofTracker` (commit store, commit deadline → `missing_commit` + `chain_broken`, challenge scheduler with `crypto.randomInt`, pipeline bind → digest → commitIn → commitOut → verify against the claimed commitments, strict-mode forfeit, disconnect chain break, resume info, audit close + `overturned` + metrics), `VerifierPool` (worker_threads, timeout, worker replacement), variant loader (`info.json` + vkey; `/api/circuit/info` and `/api/health` list built variants). `MatchRoom`: `ready` checks the zkey hash, room stays registered until its audit closes (players are freed at `match_end`), late snapshots accepted into the ended round's final window during the pause/after the match, reconnect → `resume` + `state`. Gateway: `window_commit` (own rate budget, routed to the live room or the latest auditing room), `window_proof` header-first (malformed bodies attributed → `malformed` + strike), routing by `matchId`. Migration `002_proofs` (`proof_windows`, `matches.audit_status/overturned/audit_ended_at`, `match_players` metric columns). `GET /api/matches/:id` adds audit + per-player stats/metrics; new `GET /api/matches/:id/windows`.
- **Client (`client/src/zk/`):** artefact loader (download progress, SHA-256 via `crypto.subtle`, Cache API keyed by hash), `WindowRecorder` (freeze on state/round_end, truncate + pad, salts, commitments), `ProofClient` (commits, challenge-first queue then audit, resume/reconnect handling, per-window status for both players), Proof Worker (builds the input in the worker; warm-up proof during the countdown), `WorkerProver`. `GameSession`: explicit `ready` with the zkey hash, hold-fill up to `endTick` when lagging at round end, dev/test `tamper` hook. UI: proof strips (hollow / ◌ / ✓ / ✕ / ⛓) + "Spot-checks: x/y passed" + tooltips, last prove time, strict-forfeit banner; queue screen shows "Loading proving key… n%"; results screen: audit banner with live "Auditing… x/y windows", final status, `OVERTURNED` stamp, per-player status counts, spot-checks, r, detection latency (Phase 4), audit duration, prove/verify times, full window timeline; leaving during the audit asks first. Auto-reconnect (0.5/1/2 s backoff up to `RECONNECT_TIMEOUT_MS`).
- **Tooling:** `npm run perf:match` (two visible Chrome windows play through spot-checks + audit; `--stop-after` for a fixed length), `npm run perf:prove` + `/bench.html` (Step 1), `server/scripts/zk-node-bench.ts` (Node prove + pool verify on an idle machine). Bots: `NodeProver` (worker_threads, artefacts read once, thread cap), `BotClient` proving / tamper / drop + reconnect.
- **Tests:** unit — 7 DigestBuilder (= JS reference/circuit digest incl. gaps, late values, ticks past endTick, padding, cut-off), 13 ProofTracker (deadlines, chain_broken, challenge eligibility, uniformity χ² over 4 000 draws, every pipeline status, strict, disconnect/resume, audit close/overturned), 4 WindowRecorder (= `sliceLogWindows`, server digest = client input digest at round end, salts < p), MatchRoom ready-hash + audit close, protocol schemas; integration (real sockets, real N=4 proofs) — clean match → `audited_clean` + frame inspector, speed and hidden-ammo cheaters → never clean, every mismatch/invalid/malformed/timeout, `missing_commit` → `chain_broken`, strict forfeit, reconnect + resume; circuit — `ammoSafety.test.ts`.

#### Fixed (found by tests during the phase)
- **Every challenge was proven twice**: after sending a proof the window stayed `committed` until the result arrived, so the queue proved it again. Windows with a proof in flight are now skipped (`onReconnected()` re-queues them if the socket died).
- DigestBuilder would have hashed a tick a client sent past `endTick` before the server processed `endTick` (now: only ticks ≤ the processed tick are hashed).
- snarkjs/ffjavascript could not run inside a `worker_thread` at all: its `web-worker` shim treats every worker thread as its own child. Workers now present themselves as main thread before loading snarkjs. Capping the verifier's ffjavascript pool to 1 thread doubled verify time (p50 26 → 65 ms) — not capped.
- A worker exiting without an `error` event, or an exception in the async pipeline, could leave a window "verifying" forever and block the audit until its timeout.
- Test hook: a withheld proof was retried forever (all later challenges timed out).
- Integration files now run sequentially (`fileParallelism: false`) and failed matches close their bots: leftover provers were loading the CPU for later tests.

#### Measured (Intel Core 5 210H, 8C/12T, Node 22.23.3, Chrome 155)
- **Integration, real proofs, N=4 test circuit (bots in Node):** clean match → 95/95 windows valid per player, challenges 4/4 passed, r = 0.042, audit 117 s, **`audited_clean`**; frame inspector 1,146 client frames (190 `window_commit`, 196 `window_proof`), wire keys only `angle, artefactSha256, clientVersion, commitOut, constantsHash, curve, fired, matchId, pi_a, pi_b, pi_c, proof, protocol, proveMs, publicSignals, roundNo, scheme, t, tick, token, windowIndex, x, y` — no hidden key. Speed cheat (one tick, window 7) → `unprovable`, caught by the **audit** (not challenged live; r ≈ 0.05), `audited_failed` + `OVERTURNED` (the cheater won). Hidden ammo refill (window 7) → same. Mutated answers → exactly `mismatch_bind, mismatch_digest, mismatch_commit (in), mismatch_commit (out), invalid, malformed, timeout`, then `valid`. Missing commit r1w5 → `missing_commit`, 45 later round-1 windows `chain_broken`, round 2 all valid. Strict → `forfeit_proof` in the same step as the result. Reconnect: resume `{chainStatus: broken, committed: 10 windows, challenge: w0 with 2.6 s left}`, w10+ `chain_broken`, next round valid, `audit_incomplete`.
- **Verify (VerifierPool, worker_threads, one worker, idle machine):** p50 26.1 / p95 32.8 ms (groth16_4, 100 verifies) — NFR-4 met. Under integration load (two bot provers in the same process): p50 34 / p95 48 ms (190 verifies); worst run p95 72 ms (two test files in parallel, since disabled). In the browser matches the server shared the laptop with two proving browsers: verify mean 34–148 ms per player — NFR-4 **not** met under that load.
- **Node proving (bot worker, idle):** groth16_4 prove p50 656 ms (12 threads) / 1,530 ms (2 threads); groth16_60 witness 326 ms, prove p50 4,371 / p95 4,651 ms — ≈ 2.8× slower than Chrome on the same laptop.
- **Browser match (two visible Chrome windows, one laptop, both clients proving):** see the Phase 3 report — results with the laptop **on battery (13 %, "Silent" power plan)** for at least the last run: Chrome capped rendering at 30 Hz (frame interval p50 33.3 / p95 33.5 ms, per-frame work p95 1.7 ms) and proving slowed (challenge prove mean 5.6 s, p95 6.4 s; the earlier run 6.8–8.3 s). Clean match of 66 s of play (64 windows per player): **9/9 spot-checks passed per player, r = 0.141, audit 321–323 s, every window valid → `audited_clean`**; warm-up proof 8.2–8.4 s. First run (10 s deadline, no warm-up, 41 s match): frame interval p95 17.0 ms, both players' first challenge `timeout` (cold first proof > 10 s) → `audited_failed` — led to the deadline revert + warm-up. A 6.7-minute run (395 windows/player) had every challenge valid; its audit (≈ 6 s per window with two browsers proving) was interrupted at 13.6 min with 209 windows left per player by my own code edit (Vite reloaded the pages) — no final status for it.

#### Exit check status — NOT complete
- ✅ Integration: scripted cheaters never `audited_clean` (speed + hidden ammo); frame inspector clean (no hidden state; `window_commit` = `{t, roundNo, windowIndex, commitOut}`, `window_proof` = proof + public signals).
- ⚠️ Clean browser match: `audited_clean` with all challenges valid achieved, but over **66 s**, not 3 minutes (natural match end; the fixed-length option `--stop-after 180` was added after that run and is untested).
- ❌/unmeasured: **frame time p95 < 20 ms while proving** — the valid-power run gave 17.0 ms (but that run failed the clean check); the clean run was capped at 30 Hz by battery saver (33.5 ms). Must be re-run on AC power.

#### Deviations / decisions to confirm
- `RATE_LIMIT_COMMITS_PER_S = 20` (new constant; `window_commit` has its own budget — at N=4 a client commits 15 windows/s).
- `window_commit` has no `matchId` (as specified); after `match_end` it is routed to the player's most recent room still auditing.
- Live late snapshots of a round that arrive after the **next** round started are lost (the protocol's snapshots carry no round number); honest RTT is far below the 1.5 s pause.
- Each challenge proof is retried after a reconnect only if the server still lists it (`resume.challenge`); audit proofs lost on a dead socket are re-proven on reconnect.
- `witnessMs` reported by the live client now includes building the circuit input (digest chain) in the worker.
- Dev-only URL params (`vite dev` builds only): `?bot=<seed>&acc=<jitter>&threads=<n>&stopAfter=<s>`.
- At N=4 the commit deadline is one window = 67 ms (as specified); integration tests on a loaded machine are timing-sensitive because of it.
- Research metric "live detection latency" column exists but stays NULL until `cheat_events` (Phase 4); benchmark export of the metrics is Phase 5.

### Phase 3 design change — commit every window, prove on challenge, audit after the match — 2026-10-10
Decided by the owner after the Phase 2 performance preview (options (a) then (d)). Recorded before any Phase 3 code. Docs changed: ARCHITECTURE §1/§2/§4/§5.3/§6/§7/§9, API_SPEC §3/§4/§5, PRD G2/G4/§5/FR-13–FR-18/FR-20/FR-22/§8, FEATURES F9–F14, DATABASE_SCHEMA, SECURITY §6/§7 (A3, A7, new A15–A17, new §7.3), UI_UX §2/§3.3/§3.4, USER_FLOWS 3–6, TESTING §2/§4/§5, ENVIRONMENT, TODO.

1. **Commit every window.** At the end of each window the client sends `window_commit{roundNo, windowIndex, commitOut}`; the server stores it as the claimed commitment (`committed`). Missing by the end of the next window → `missing_commit`, rest of the round `chain_broken`.
2. **Challenges.** One outstanding challenge per player; drawn uniformly with `crypto.randomInt` among the player's ended, digest-final, still-`committed` windows of the current round; `challenge{playerIndex, roundNo, windowIndex, deadlineMs}` with `deadlineMs = PROOF_DEADLINE_MS`.
3. **Proving a challenged window** against the claimed commitments: `commitIn` = claimed `commitOut_{k−1}` (or `initialCommit`), `commitOut` = claimed `commitOut_k`; a different `commitOut` → `mismatch_commit`. Every window's private input stays in client memory (and the dev tick log) until the audit ends.
4. **Statuses:** `committed`, `valid`, `invalid`, `mismatch_bind`, `mismatch_digest`, `mismatch_commit`, `missing_commit`, `unprovable`, `timeout` (challenge deadline), `chain_broken`, `malformed`, plus `unaudited` (audit closed). DB CHECK updated.
5. **Post-match audit:** the client proves every remaining committed window; the server accepts audit proofs for `AUDIT_TIMEOUT_MIN`; `matches.audit_status` = `audited_clean` / `audited_failed` / `audit_incomplete`.
6. **Enforcement:** `strict` forfeits on the first live failure; an audit failure sets `overturned` without rewriting history.
7. **HUD:** hollow = committed, ◌ = challenged/proving, ✓, ✕, ⛓; "Spot-checks: 7/7 passed".
8. **Research metrics per match:** challenge count, challenge rate r, live detection latency, audit duration (results screen; benchmark export in Phase 5).
9. **SECURITY §7.3:** why challenges must be unpredictable, why commit-every-window prevents rewriting history, live detection probability 1 − (1 − r)^m, the audit is the full guarantee.

**Decisions taken while writing the design down (please confirm):**
- `PROOF_DEADLINE_MS` default **15 000 ms** (owner's value). After Step 1 I first lowered it to 10 000 (≈ 6× the single-client prove p95); the first browser exit-check run then showed that two clients proving on one laptop need 8–9 s per challenge and that the cold first proof exceeded 10 s → both players' first challenge timed out. Reverted to 15 000, and the worker now runs one warm-up proof during the countdown. `AUDIT_TIMEOUT_MIN` = 30. Both live in `shared/constants.ts` (rule 1) with server env overrides.
- **Only `missing_commit` breaks the chain.** A failed window does not: claimed commitments are immutable, so no rewind is possible, and later windows are still checked against the claims. (Before: the first non-valid result broke the chain.)
- **`strict` forfeits on a failed challenge *or* a `missing_commit`** (both are live failures).
- **`overturned` = the winner's audit failed.** A loser who cheated makes the match `audited_failed` but the result is not "overturned". Literal alternative: any audit failure → overturned.
- **`window_proof` / `proof_failed` gain `matchId`** so audit proofs after `match_end` (and after a reconnect) are routed unambiguously, even if the player is already in the lobby.
- **`challenge` is broadcast** (with `playerIndex`) so the opponent's strip shows ◌ too; `proof_result` gains `phase: 'live' | 'audit'` and is also sent for `committed`; new `audit_end`; `resume` gains `committed[]` and `challenge`; `match_end` gains `auditTimeoutMs`; `match_found` gains `variant`.
- **Disconnects:** windows from the first tick the server did not receive become `chain_broken` (not a failure — they contain held values the client never played), so a reconnect makes that round `audit_incomplete` at best. A cheater can use this to turn "failed" into "incomplete" for one round (SECURITY A16).
- **G4 / FR-20 / §8 reworded:** "non-valid within 3 windows" is no longer a property of the system; the guarantee is "never `audited_clean`", with the live detection probability measured.
- **Residual predictability (SECURITY A15):** the first window of a round can be the only candidate (certain challenge); windows late in a round face fewer draws. Implemented as specified; documented and measured, not fixed.

#### Step 1 — browser proving measured (before the redesign was coded)
Chrome 154 (Playwright, headed, tab visible), Intel Core 5 210H (8C/12T), `client/bench.html` → Proof Worker, 10 real windows from the Phase 1 fixture logs + 1 warm-up per setting, synthetic arena rendering on the main thread. All public signals equal the JS reference.

| Variant | snarkjs threads | witness p50/p95 | prove p50/p95 | prove ÷ play | frame interval while proving p50/p95/max |
|---|---|---|---|---|---|
| groth16_60 | 12 (default = hardwareConcurrency) | 75 / 128 ms | 1,579 / 1,732 ms | 1.6× | 6.9 / 7.1 / 8 ms |
| groth16_60 | 8 | 68 / 96 | 1,555 / 1,739 | 1.6× | 6.9 / 7.1 / 9 |
| groth16_60 | 4 | 76 / 146 | 2,019 / 2,189 | 2.0× | 6.9 / 7.1 / 9 |
| groth16_60 | 2 | 73 / 97 | 3,098 / 3,164 | 3.1× | 6.9 / 7.1 / 9 |
| groth16_60 | single | 73 / 131 | 5,628 / 6,572 | 5.6× | 6.9 / 7.1 / 8 |
| groth16_30 | 12 (default) | 52 / 79 | 1,014 / 1,081 | 2.0× | 6.9 / 7.1 / 8 |
| groth16_30 | 8 | 47 / 65 | 1,010 / 1,085 | 2.0× | 6.9 / 7.1 / 8 |
| groth16_30 | 4 | 50 / 83 | 1,347 / 1,429 | 2.7× | 6.9 / 7.1 / 8 |
| groth16_30 | 2 | 44 / 69 | 2,092 / 2,225 | 4.2× | 6.9 / 7.1 / 8 |
| groth16_30 | single | 41 / 53 | 3,574 / 3,958 | 7.1× | 6.9 / 7.1 / 8 |

- Idle frame interval p95 was 7.0–7.1 ms in every run: proving in the worker does not affect main-thread frame time at any thread setting, so threads are **not** capped (capping only slows proving).
- Browser proving is ≈ 3× faster than the Phase 2 Node preview (4.8 s at N=60), but still slower than real time (1.6× at N=60) — proving every window live remains infeasible on this laptop.
- New variant **groth16_30**: 16,968 constraints, ptau power 15, zkeySha256 `c2f21eb60a3baf8d10ba6e8a55f8b4b94f227f0b092d398ce87fd4d3829144fc`, zkey 18.84 MiB; `publicSignalOrder` `[commitOut, bind, digest, commitIn]` (unchanged). Circuit unchanged → groth16_4/60 constraint counts unchanged.
- Tooling: `client/bench.html` + `src/bench/proveBench.ts` (dev page), `npm run perf:prove` (Playwright driver); Vite dev middleware serves `/zk/<variant>/{window.wasm,window_final.zkey,info.json}` and `/__dev/fixtures/`; Vite aliases `circomlibjs` to its `poseidon_wasm.js` (the package index pulls in blake-hash/Buffer, which breaks in browsers).

#### "ammo < MAG" as "ammo ≠ MAG" — checked, safe, no circuit change
`circuits/test/ammoSafety.test.ts` (5 tests): `WeaponStep`'s equations transcribed literally in F_p; BFS from (MAG, 0, 0) gives **1,571 reachable hidden states**, closed under the circuit relation and bounded (ammo ∈ [0, 10], cooldown ∈ [0, 11], reloadT ∈ [0, 90]); on all of them the circuit relation equals `stepWeapon` ("<") for all 4 inputs; the compiled template agrees with the transcription on every reachable (state, input); window 0 opening `initialCommit` forces (MAG, 0, 0). So "≠" is safe for every window whose `commitIn` traces back to `initialCommit` through verified windows. The test also shows why that hypothesis matters under spot-checks: a window whose `commitIn` is only *claimed* can start from ammo = 1000 and still verify — only the window that produced the claim (or the audit) exposes it. A range check would not change that (a cheater would claim a legal-looking refilled magazine instead), so the circuit was not rebuilt.

### Phase 2 — Circuit (offline) — 2026-10-09
#### Added
- `circuits/src/*.circom` templates (`InRange`, `BoundsCheck`, `SpeedCheck`, `TurnCheck`, `WeaponStep`, `DigestChain`, `Commit`, `Bind`) and `circuits/window.circom` (`Window`). `circuits/scripts/gen-main.ts` generates `main_<N>.circom` from `shared/constants.ts` (no game numbers in .circom sources).
- `shared/zkInput.ts`: JS reference — circuit input object, expected `bind`/`digest`/`commitIn`/`commitOut`, log → window slicing (truncate + pad, hidden-state and salt chaining, per-round reset), `randomSalt()` (248 bits), `namePublicSignals()` (order from info.json).
- `circuits/scripts/build.ts` (`npm run circuits:build`), `prove-log.ts` (`npm run circuits:prove-log`), `mutate-log.ts` (`npm run circuits:mutate-log`); `npm run circuits:lint` (circomspect on main_4 + main_60, CI gate).
- Tests: 19 template tests, 17 Window(N=4) tests (all real-log windows, TESTING §3 table, malicious helper witness, 150 random legal sequences, 1,000 random mutations), 5 offline tests (3 cheats on real logs at N=4, N=60 smoke over every real window, groth16_60 prove/verify + publicSignalOrder), zkInput unit tests. Fixture logs: `circuits/test/fixtures/` (2 Phase 1 bot matches through the real server, both players).

#### Circuit
- **groth16_4**: 3,292 constraints; ptau power 12 (`powersOfTau28_hez_final_12.ptau`, sha256 `dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17`); zkeySha256 `0ae419920ef42b1d3f9e0e39df76e4759bf163d47ce0928842e46ccb66a793ee`; zkey 3.78 MiB.
- **groth16_60**: 32,748 constraints (~537/tick), 493 private inputs, 31,502 wires; ptau power 15 (`powersOfTau28_hez_final_15.ptau`, sha256 `3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f`); zkeySha256 `d49f56bb0795e0be41e2209ead25b719a3c1cdd1bea6c31cc5749d31ca45b93f`; zkey 34.83 MiB; wasm 2.9 MB; proof ≈ 724 B.
- **publicSignalOrder** (both): `[commitOut, bind, digest, commitIn]` — detected from a real proof at build time. First circuit release, so no previous order to compare.
- Setup: single local phase-2 contribution (SECURITY A8). Both ptau files blake2b-verified against the snarkjs README.
- The power-16 ptau downloaded in Phase 0 is not used (15 suffices for N=60).

#### Results
- Real logs, N=60, Node: **26/26 windows** of 4 logs prove + verify, and named public signals equal the JS values for every window.
- Mutated logs (from `match-bffb33a1-p1`): speed (tick 136) → only window 2 has no witness (`SpeedCheck`/`Num2Bits`); rapid-fire (tick 203) → only window 3 (`WeaponStep` cooldown legality); infinite ammo (tick 202) → only window 3 (`WeaponStep` ammo transition). All other windows still verify.
- Mutation property (N=4, 1,000 runs): 935 rejected by both circuit and sim, 65 accepted by both, **0 disagreements**.
- circomspect 0.9.0: no findings (gate verified to exit 1 on a planted under-constrained signal).

#### Performance preview (Node, not the official benchmark) — Intel Core 5 210H (8C/12T), 15.6 GB, Node 22.23.3, snarkjs 0.7.6, groth16_60, 26 windows
- witness p50 303 ms / p95 352 ms; **prove p50 4,840 ms / p95 6,067 ms** (min 1,911, max 7,125); verify p50 36 ms / p95 54 ms; proof ≈ 724 B; zkey 34.8 MiB.
- Prove time is ≈ 4.8× the window's 1 s of play → proving every window live is not feasible in Node on this laptop (browser is usually slower). See the Phase 3 decision in TODO.
- Verify p95 (54 ms) is slightly above NFR-4 (< 50 ms); measured in the same process right after proving — to be re-measured in the server's verifier pool in Phase 3.

#### Deviations from the docs
- `turnD` is computed in-circuit (`<==` from the helper `k`) instead of being a prover input; `k` is the only hand-written `<--`. No selector witness for the min(): two exclusive comparators must sum to 1.
- `Window` lives in `circuits/window.circom` (per ARCHITECTURE), the sub-templates in `circuits/src/`.
- "ammo < MAG" in W4 is implemented as "ammo ≠ MAG" (identical on reachable states — documented in the template).
- Circuits compiled with `--O2` (removes all linear constraints: N=4 7,432 → 3,292).
- TESTING §3 mutation property clarified: an ignored `reloadPress` is a legitimate no-op witness.

### Phase 1 follow-ups — 2026-10-09
- **Late snapshots bounded:** accepted up to `PROOF_GRACE_WINDOWS × WINDOW_TICKS` ticks behind the server's wall tick; older → rejected + strike (`strike_late`). Boundary unit test (exactly at the bound → ok, one past → strike). SECURITY §4 updated.
- **Phase 3 rule written down** (ARCHITECTURE §4, TODO Phase 3): a window's digest is finalised only when its last tick's snapshot has arrived or the grace deadline has passed, so a late honest snapshot never causes `mismatch_digest`.
- **Integration stress:** `npm run test:int` ×10 in a row — 10/10 passed (150/150 tests), 24–57 s per run; full output in `server/data/test-reports/int-stress.txt`.
- **Renderer seam for the future 3D renderer:** `client/src/game/view.ts` — `FrameBuilder.build(now)` → `RenderFrame` (plain, already interpolated) → `GameRenderer.draw(frame)`. Canvas 2D renderer reimplemented behind it (`createRenderer`); tracers/flash bookkeeping moved out of the renderer. ESLint `no-restricted-imports` forbids renderer files from importing sim, protocol, session, input, bot, net or api. TODO Phase 6: "3D renderer (Three.js), 2D rules unchanged".
- Accepted by owner: client-written private logs (deviation 1) and dev-only `?bot=` (deviation 6).

### Phase 1 — Playable game, no ZK — 2026-10-09
#### Added
- `shared/sim.ts`: integer rules exactly per ARCHITECTURE §3 (movement, aim, weapon table W1–W5), `checkTick`/`checkSequence` (JS mirror of the circuit's per-tick constraints), `holdTick` (gap fill / padding), `truncateAndPad` + public variant (round-end window), `TickRecord` = WindowRecorder shape (public + private per tick), FNV state hash.
- `shared/trig.ts` integer sin/cos table (scale 1024; test proves no entry sits on a rounding boundary → engine-independent). `shared/poseidon.ts` (circomlibjs; matches the reference vector Poseidon([1,2])), `shared/matchField.ts`, `shared/ticklog.ts` (JSONL log format), `shared/rng.ts`.
- Server: Fastify 5 + helmet CSP + CORS + rate limits; zod-validated env; SQLite migration `001_init` (players, sessions, matches incl. `end_reason 'forfeit'`, match_players, rounds); guest JWT auth with revocable `jti`; REST `/api/health`, `/api/auth/guest`, `/api/auth/logout`, `/api/circuit/info` (all constants + `constantsHash`), `/api/matches/:id` (participants only).
- WS gateway: Origin check, hello-within-5 s, strikes → 4400, rate limits → 4429, one socket per player → 4409, `VERSION_MISMATCH` on constants-hash mismatch, maxPayload 64 KB.
- `MatchRoom`: snapshot-driven tick processing (both snapshots in, or leader ≥ `STALL_TICKS` ahead → hold, `stalled`), integer ray-vs-circle hits, simultaneous-lethal tie rule, rounds with `endTick` + `prevSnapshot` + `initialCommit` in `round_end`, `ROUND_PAUSE_TICKS` pause, best-of-5, forfeit, disconnect/silence > 10 s → forfeit, ready timeout → abort. Fixed-step 60 Hz wall loop (performance.now accumulator). Server snapshot logs (`LOG_SNAPSHOTS`).
- Client (vanilla TS + Canvas): DOM-free `GameSession` (local sim, recorder, local gap fill identical to the server's hold, desync counter) shared with the Node bots; keyboard + pointer-lock input with queued turn (never loses mouse input to the MAX_TURN clamp); renderer (5:3 letterbox, grid, aim line, tracers, hit flash); landing, queue, match HUD, results screens; settings overlay (sensitivity, forfeit); debug overlay; dev-only tick-log download.
- Tooling: `npm run dev`, `dev:lan`, `db:migrate`, `bots`, `perf:frame` (Playwright + installed Chrome), `test:int`.
- Tests: 144 unit (sim every W-row, trig, poseidon, matchField, protocol, hit detection, JWT, MatchRoom with fake clock, client interp/frame stats) + 15 integration (10 concurrent bot best-of-5 matches; handshake/auth/origin/strikes/rate limits/fuzz/queue/REST/CSP).

#### Measured
- 10 concurrent bot matches (20 bot clients + server in one process): all ended by rounds, 0 desync ticks, client logs pass `checkSequence` for every round, server log values = client values for every tick, 0 hidden keys in 15,950 client→server frames (wire keys: `angle, artefactSha256, clientVersion, constantsHash, fired, t, tick, token, x, y`).
- Server tick processing (same run): p50 0.14 ms, p95 0.36 ms, p99 0.54 ms, max 2.3 ms (n = 7,944). Across all runs today p99 ranged 0.54–0.80 ms; max ranged 2.3–6.6 ms (single outliers, likely GC). NFR-1 (< 2 ms) holds at p99, not for every single tick.
- Client frame time, real Chrome 154, two bot-driven pages, 1366×768: headed — frame interval p50 7.0 ms, p95 13.8 ms, max 48.8 ms (≈ 135 fps, display-limited), per-frame work p50 0.3 ms, p95 1.0–1.3 ms; headless — interval p95 7.2 ms, work p95 1.4 ms.

#### Fixed (found by tests during the phase)
- `totalTicks` double-counted the final round when a match ended by rounds.
- Debug overlay sorted 3,600 samples per frame (work p50 3.8 ms → 0.3 ms after throttling to 4 Hz).
- `FrameStats` ignored a frame timestamp of 0.
- Poseidon is now built at server boot; a cold build inside the first `match_found` caused one intermittent integration-test timeout under load.

#### Deviations / decisions to confirm
- `LOG_SNAPSHOTS` cannot contain private state (the server never sees it). Server logs stay public-only; logs with private state are written client-side (bots → `server/data/logs/clients/`, browser → `VITE_LOG_TICKS` download). New env var `VITE_LOG_TICKS`.
- `VITE_API_URL` / `VITE_WS_URL` empty by default → derived from the page's host (LAN works without edits).
- `ready.artefactSha256` is not checked yet (no zkey until Phase 3); clients send 64 zeros; matches store `circuit_hash = 'none'`.
- Snapshot tick bound: only ticks from the future (> server tick + `STALL_TICKS`) are rejected (strike). Late ticks are accepted, so the SECURITY §4 "±6" lower bound is not enforced: rejecting late snapshots would drop honest data at RTT > 100 ms.
- Reconnect into a running match is Phase 3; in Phase 1 a dropped player forfeits after 10 s.
- Dev-only `?bot=<seed>` URL parameter (only in `vite dev` builds) lets a browser tab play itself, for frame-time measurement.
- `room_join` replies `FORBIDDEN` until Phase 4; `window_proof`/`proof_failed` are accepted and ignored until Phase 3.

### Phase 0 — Repo setup — 2026-10-09
#### Added
- npm workspaces `shared`, `client`, `server`, `circuits`, `bench`; ESM; `.npmrc` with `save-exact` + `engine-strict`; `.node-version` = 22.
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) via `tsconfig.base.json`; ESLint 9 flat config + typescript-eslint `strict`; Prettier 3 (LF line endings, `.gitattributes` forces LF).
- `shared/constants.ts`: every PRD §5 constant plus the six added ones, protocol limits (rate limits, strikes, timeouts, name/room-code rules) and the aggregated `CONSTANTS` object that `/api/circuit/info` returns.
- `shared/canonical.ts`: canonical JSON + `constantsHash` (WebCrypto SHA-256, identical in Node and browsers).
- `shared/field.ts`: BN254 scalar modulus p **and base-field modulus q**. Proof curve coordinates are F_q elements, slightly larger than p, so they are range-checked against q; public signals and PLONK evaluations against p. (SECURITY §4 said "< p" for all field elements; applying that to proof coordinates would wrongly reject valid proofs.)
- `shared/protocol.ts`: zod schemas for every WS message (both directions, incl. `proof_failed`, `resume`), Groth16 + PLONK proof shapes (`.strict()`), REST bodies (guest auth, rooms, bench upload), error formats. `window_proof` has a separate header schema so a malformed body can still be attributed to a window (→ `malformed`).
- `circuits/build.config.json`: variants + Hermez ptau table (powers 8–20; URLs and blake2b-512 hashes generated from the snarkjs README, not retyped).
- `circuits/scripts/ptau.ts` (`npm run circuits:ptau -- --power N`): download, verify blake2b against the README, record SHA-256. `circuits/scripts/check-tools.ts` (`npm run circuits:check`).
- `.github/workflows/ci.yml` skeleton: toolchain check, lint, format, typecheck, unit + circuit tests, integration tests, circomspect (once `window.circom` exists), `npm audit --omit=dev --audit-level=high`.
- Tests: 76 unit tests (constants, canonical JSON/hash, field bounds, protocol accept/reject cases).

#### Security
- npm `overrides`: `ws` → 8.22.0 (circomlibjs → ethers pulled ws 8.18.0, high: GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p) and `underscore` → 1.13.8 (snarkjs → bfj → jsonpath pulled 1.13.6, high: GHSA-qpx9-hpmf-5gmw). Same majors.
- Remaining: 15 **low** advisories, all `elliptic` via circomlibjs → ethers 5 (unused at runtime by us; no fix available). `npm audit --omit=dev --audit-level=high` is clean.

#### Notes
- Version lines that moved past the docs' minimum: Vite 8 (docs: "6.x or later"), Vitest 5 (docs: "2.x+"). zod kept on 3.x, ESLint on 9.x, pino 9.x, dotenv 16.x, TypeScript 5.x as TECH_STACK specifies, although newer majors exist.
- Ptau power 16 downloaded and verified for now; the final per-variant power is chosen from real constraint counts in Phase 2/5.
- CI workflow has not run yet — there is no remote. It is syntax-only until pushed.

### Spec fixes (pre-Phase 0) — 2026-10-09
Decided by the owner after the Step 2 doc review. Each item lists the docs changed.
1. **Snapshot buffer → per-window digests.** Server finalises and stores each window's digest at window end, keeps only digests + the last snapshot (next window's seed). Timeout/unprovable/chain_broken rows use the stored digest. The digest uses the snapshot actually sent for each tick; a window finalises when its last tick's snapshot arrives or the player stalls. *(ARCHITECTURE §4/§6, FEATURES F6, SECURITY §6, DATABASE §2/§4, TESTING §2)*
2. **Round end.** `round_end` gains `endTick`; client truncates its last window to `endTick` and pads exactly like the server (last snapshot, `fired=0`; hidden state rolled forward with `fired=0, reloadPress=0`). The client starts proving window k only after the server's `state` for its last tick (or a `round_end` inside it) arrives, so it never proves ticks the server discards. *(ARCHITECTURE §4, API §4/§5, FEATURES F8/F9, USER_FLOWS 3)*
3. **Commit chain: no rewinds.** First non-valid window in a round → later windows of that round get new status `chain_broken`; chain resets every round from the public `initialCommit`. Results are decided in window order. *(ARCHITECTURE §4, API §5, SECURITY A3, FEATURES F10, DATABASE, TESTING §2/§4)*
4. **`proof_failed` message → `unprovable` status.** Honest client reports witness failure; server records `unprovable` immediately. `timeout` remains the real guarantee. PRD FR-20 reworded. *(PRD, API §4/§5, FEATURES F9/F13, USER_FLOWS 3/4, SECURITY A7, DATABASE `fail_reason`)*
5. **Weapon transition table W1–W5** written into ARCHITECTURE §3: firing sets `cooldown' = FIRE_COOLDOWN − 1` (next shot exactly 12 ticks later, 5 shots/s); fire beats a same-tick reload press; presses during a reload are ignored; cooldown range is now `0..FIRE_COOLDOWN−1`. *(ARCHITECTURE §3/§5.3, FEATURES F5, TESTING §2)*
6. **Round start.** Every round's `prev` snapshot = the player's spawn with `fired=0`; `prevSnapshot` is now in `round_end` as well as `match_found`. *(ARCHITECTURE §3/§5.4, API §4)*
7. **Ticks are round-relative** in protocol and sim; DB `rounds.start_tick/end_tick` and `matches.total_ticks` are match-absolute (server-computed). `start` and `state` gain `roundNo`; `state` gains `phase`; `round_end.nextRoundTick` replaced by `pauseTicks`. *(ARCHITECTURE §3, API §4, DATABASE, FEATURES F5/F8)*
8. **DB:** `window_ticks` CHECK now `IN (4,30,60,120)` (test variant). *(DATABASE)*
9. **Removed the "switch to N=120" fallback**: a slow prover is reported as a finding with the real prove/play ratio (near-real-time / post-match audit framing). *(PRD §9, TODO risks)*
10. **Ptau power per variant** from the real constraint count (PLONK needs more than R1CS count); smallest Hermez file that fits; recorded in `info.json` (`ptauPower`, `ptauFile`, `ptauSha256`). *(ARCHITECTURE §5.5, TECH_STACK §5, ENVIRONMENT §3, TODO)*
11. **Out-of-range snapshots:** integers are accepted into the digest as sent and counted as a strike (proof then fails on bounds); only wrong types are rejected. Added: hit detection clamps such values before ray-casting; schema bounds integers to |v| < 2^31. *(SECURITY §4, API §4, ARCHITECTURE §6, FEATURES F6, TESTING §2)*
12. **Movement:** per-axis step of exactly `MAX_SPEED`; diagonal ≈ 5.66 accepted. PRD FR-7 reworded. *(PRD, FEATURES F5)*
13. **Protocol:** creator also sends `room_join`; rematch dropped; match history moved to P1 after Phase 4; new server message `resume{roundNo, nextWindowIndex, chainStatus}`; `constantsHash` = SHA-256 of canonical JSON of all constants; `queue_join` has no enforcement; WS error codes enumerated incl. `FORBIDDEN`, `VERSION_MISMATCH`; `/api/circuit/info` returns every constant + `constantsHash`. *(API, FEATURES F2/F3/F16/F17, USER_FLOWS 2/5/6/8, UI_UX §3.4, TODO)*
14. **`matchField`** = first 31 bytes of SHA-256(matchId UUID string) as big-endian integer (< p). *(ARCHITECTURE §5.2, DATABASE)*
15. **PRD FR-16** now lists the full status set (incl. `unprovable`, `chain_broken`); UI symbols: ✕ for all failures, – timeout, ⛓ chain_broken. *(PRD, UI_UX §2/§3.4, FEATURES F12)*
16. **README stays in the root**, with Windows cmd commands and `docs/` links; the other 14 specs live in `docs/`. *(README, DEPLOYMENT §2, ENVIRONMENT secret generation)*
17. **Phase 1 exit check:** automated bot-driven matches over real sockets + owner's manual playtest. *(TODO)*
18. **New limitation A14 — partially inferable hidden state** (public shot counts reveal approximate ammo/cooldown; reload timing and salts stay hidden). *(SECURITY §7)*
19. **Frame time vs snarkjs threads:** measure while proving; cap threads if needed and report the setting. *(TODO risks)*
20. **Constants added to PRD §5** (to live in `shared/constants.ts`): `SPAWNS`, `RAY_LENGTH` 1200, `TRIG_SCALE` 1024, `ROUND_PAUSE_TICKS` 90, `STALL_TICKS` 6, `RECONNECT_TIMEOUT_MS` 10000. *(PRD §5)*

---

## [0.0.1] — 2026-10-09 — Specification

### Added
- Project specification set: README, PRD, ARCHITECTURE, UI_UX_SPEC, DATABASE_SCHEMA, API_SPEC, SECURITY, TECH_STACK, USER_FLOWS, FEATURES, ENVIRONMENT, TESTING, DEPLOYMENT, CHANGELOG, TODO.
- Game rule constants fixed (`TICK_RATE` 60, `MAX_SPEED` 4, `MAX_TURN` 150, `MAG_SIZE` 10, `FIRE_COOLDOWN` 12, `RELOAD_TICKS` 90).
- Circuit design: per-window proof with public inputs `bind`, `digest`, `commitIn` and public output `commitOut`.
- Decision: Groth16 primary, PLONK for comparison; window sizes 30/60/120 for benchmarks.
- Decision: server-authoritative hits; client-proven movement, aim and hidden weapon state.

### Context
- Builds on the mid-term seminar work (literature review of 26 sources, four research gaps, four objectives) for *Zero-Knowledge Proofs for Verifiable Fair-Play in Competitive Gaming and Esports*.

---

## Entry template

```
## [x.y.z] — YYYY-MM-DD

### Added
### Changed
### Fixed
### Circuit
- Variant groth16_60: constraints 51,234 → 49,880; publicSignalOrder unchanged
### Benchmarks
- Run <id> on <device>: groth16_60 prove p50 612 ms, p95 740 ms
```

## Exact dependency versions (pinned 2026-10-09, Phase 0)

| Package | Pinned version |
|---|---|
| node | 22.23.3 (npm 10.9.9, via fnm 1.39.0) |
| circom | 2.2.3 (built from tag `v2.2.3`, rustc 1.99.0 MSVC) |
| circomspect | 0.9.0 |
| snarkjs | 0.7.6 |
| circomlib | 2.0.5 |
| circomlibjs | 0.1.7 |
| circom_tester | 0.0.24 |
| vite | 8.3.4 |
| fastify | 5.12.5 (`@fastify/helmet` 13.1.2, `/cors` 11.3.1, `/rate-limit` 11.2.1, `/static` 10.1.5) |
| ws | 8.22.0 (also forced via `overrides`) |
| better-sqlite3 | 13.0.3 (bundled SQLite 3.53.4) |
| zod | 3.25.76 |
| jsonwebtoken / pino / dotenv | 9.0.3 / 9.14.0 / 16.6.1 |
| chart.js | 4.5.1 |
| typescript / tsx | 5.9.3 / 4.23.15 |
| eslint / typescript-eslint / prettier | 9.39.5 / 8.71.1 / 3.9.9 |
| vitest / @vitest/coverage-v8 / fast-check | 5.0.3 / 5.0.3 / 4.10.2 |
| @playwright/test | 1.64.0 (browsers not yet installed) |
| ptau file + sha256 | `powersOfTau28_hez_final_16.ptau` (75,580,568 B) — blake2b-512 `6a6277a2…efec125` (matches snarkjs README), sha256 `1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922` |
