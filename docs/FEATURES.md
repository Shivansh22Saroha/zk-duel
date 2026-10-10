# FEATURES — ZK-Duel

Feature-by-feature behaviour. Constants refer to `shared/constants.ts` (PRD §5). Each feature lists its acceptance criteria (AC).

---

## F1. Guest session
- Name entry → `POST /api/auth/guest` → token stored in `sessionStorage` (cleared when the tab closes).
- Re-opening the site in the same tab reuses a valid token.
- **AC:** invalid names never reach the server; a revoked token gets `TOKEN_EXPIRED` and the user is returned to name entry.

## F2. Matchmaking queue
- FIFO; the first two `queue_join` players are paired.
- Queue matches always use the server's `DEFAULT_ENFORCEMENT` (`queue_join` has no enforcement field).
- A player cannot be in the queue and a match at once (`ALREADY_IN_MATCH`).
- **AC:** two players clicking Find Match within 1 s are paired in < 500 ms; cancelling removes the player immediately.

## F3. Private rooms
- Create returns a 6-char code (alphabet without 0/O/1/I). Codes expire after 10 min unused.
- Creator chooses enforcement (`observe`/`strict`). Window size and scheme come from server config.
- Both the creator and the joiner enter the room with WS `room_join` and the code.
- **AC:** joining a full or expired room shows the matching error; codes are case-insensitive on entry.

## F4. Artefact loading & integrity
- On `match_found` (or earlier, on queue join) the client fetches `window.wasm` and `window_final.zkey` for the match's variant, with download progress.
- SHA-256 via `crypto.subtle.digest` compared with `zkeySha256` from `/api/circuit/info`.
- Artefacts cached with the Cache API keyed by hash; a second match needs no download.
- **AC:** a modified zkey is rejected before `ready`; the cached path loads in < 1 s.

## F5. Deterministic simulation
- Fixed 60 Hz step, integer state, rules from `shared/sim.ts` only.
- Movement: WASD sets a desired direction; per-axis step is exactly `MAX_SPEED` in that direction (diagonal ≈ 5.66 units/tick is accepted), then clamped to arena bounds `[R, W−R]`/`[R, H−R]`.
- Aim: mouse delta × sensitivity → target angle; per-tick change clamped to `MAX_TURN` along the shortest arc; stored mod 3600.
- Firing: left mouse held = attempt fire each tick; allowed only when `ammo>0 ∧ cooldown==0 ∧ reloadTimer==0`. Weapon state follows the transition table W1–W5 in ARCHITECTURE.md §3 (next shot exactly 12 ticks later; fire beats a same-tick reload press; presses during a reload are ignored).
- Auto-reload when ammo hits 0; manual reload with R when `ammo < MAG_SIZE`.
- Ticks are round-relative (tick 0 = first tick of each round).
- **AC:** replaying the same input log twice produces identical state hashes; every honest window satisfies the circuit (property test).

## F6. Snapshot streaming
- Client sends `input_snapshot` every tick with public fields only.
- Server keeps only the current window's snapshots per player; at window end it stores that window's digest and keeps the last snapshot as the next window's seed.
- A missing snapshot is held (previous snapshot, `fired=0`) for at most `STALL_TICKS`; then the player is `stalled`. Windows inside a disconnect gap time out (and break the chain for the rest of the round).
- Integer but out-of-range values are accepted into the digest as sent and counted as a strike; wrong types are rejected.
- **AC:** no hidden field ever appears in a WS frame (asserted in an integration test that inspects every frame).

## F7. Server-authoritative hits
- On `fired=1` at tick t: ray from `(x,y)` at `angle` (converted with a precomputed integer sin/cos table scaled by 1024), length 1200, vs opponent circle at their tick-t snapshot.
- One hit max per shot; damage `DAMAGE`; HP ≤ 0 ends the round.
- Simultaneous lethal hits in the same tick → both survive at 1 HP (deterministic tie rule).
- **AC:** unit tests for ray-circle at edges, angle wrap (0/3599), and tie rule.

## F8. Rounds & match
- Best of 5 (`ROUNDS_TO_WIN = 3`). Fixed spawns: P0 `(150, 300)` angle 0; P1 `(850, 300)` angle 1800.
- New round: tick counter, window counter, hidden state and commitment chain reset; `round_end` carries `endTick`, the new public `initialCommit` and the new `prevSnapshot` (spawn, `fired=0`).
- The window containing `endTick` is truncated and padded identically by client and server (ARCHITECTURE.md §4).
- `ROUND_PAUSE_TICKS` (1.5 s) pause between rounds (server keeps sending `state` with `phase:'pause'`, but no input is applied and no windows are counted); then `start` for the next round.
- **AC:** window indices restart at 0 each round; a proof from round 1 can't be accepted in round 2 because `bind = Poseidon(matchField, playerIndex, roundNo, windowIndex)`.

## F9. Window recording, commitments & proving
(Phase 3 design change — commit every window, prove on challenge, audit after the match; ARCHITECTURE.md §4.)
- **Commit every window.** WindowRecorder freezes window k once the server's `state` for its last tick has arrived and the local sim has reached it (or on `round_end` with `endTick` inside it — truncated + padded, API_SPEC §5), draws a fresh `saltOut` (`crypto.getRandomValues`, 248 bits), computes `commitOut_k` = Poseidon4 of the window's last hidden state and sends `window_commit{roundNo, windowIndex, commitOut}`. Nothing else about the window leaves the client.
- **Keep everything until the audit ends.** Every window's full private input (records, `prev`, hidden state in, salts) stays in memory until the match's audit ends (and in the dev tick log when `VITE_LOG_TICKS=true`), and in IndexedDB until the server decided that window — a page reload during the audit resumes it automatically while the audit is open.
- **Proof Queue.** The challenged window first (at most one is outstanding), then — after `match_end` — every window still `committed`, in window order. Proof Worker: one proof at a time; builds the circuit input, computes the witness, proves; reports `witnessMs`, `proveMs` to the HUD and in `window_proof`.
- If witness generation/proving throws, the client sends `proof_failed` (→ `unprovable`) and shows a local "proof could not be generated" note.
- After `resume.chainStatus = 'broken'` the client stops committing for the rest of that round; it resumes at the next round.
- **AC:** with N=60 on the baseline laptop, frame time p95 < 20 ms while proving; in a clean 3-minute match every window is committed, every challenge `valid`, and the audit ends `audited_clean`; no hidden state in any `window_commit`/`window_proof` frame.

## F10. Server verification, challenges & audit
- **Commits:** stored as the claimed `commitOut_k` (status `committed`). Missing by the end of the next window → `missing_commit`, rest of the round `chain_broken`.
- **Challenges:** whenever a player has no outstanding challenge, the server draws one of that player's ended, digest-final, still-`committed` windows of the current round uniformly at random (`crypto.randomInt`) and broadcasts `challenge{playerIndex, roundNo, windowIndex, deadlineMs}` (`PROOF_DEADLINE_MS`, env-tunable, default 15 000). Deadline passed → `timeout`.
- **Verification order:** malformed → bind → digest → commitIn (claimed k−1 / `initialCommit`) → commitOut (claimed k) → `verify` in the worker pool (`VERIFY_TIMEOUT_MS` timeout). Any window order. `proof_failed` → `unprovable` immediately.
- Results persisted per window; `proof_result` broadcast to both players (also for `committed`).
- **Audit:** after `match_end`, audit proofs for that match are accepted for `AUDIT_TIMEOUT_MIN` (env, default 60). Closes early when nothing is left `committed`. Never-proven windows → `unaudited`. `matches.audit_status` = `audited_clean` / `audited_failed` / `audit_incomplete`; winner's audit failure → `overturned` (history not rewritten). `audit_end` broadcast.
- **Research metrics per match and player:** windows committed, challenge count, challenges passed, challenge rate r, live detection latency (windows from cheat activation to the first failed challenge — needs `cheat_events`, Phase 4), audit duration.
- **AC:** each mismatch type is produced by a dedicated integration test; verify p95 < 50 ms in the worker pool; a scripted cheater's match is never `audited_clean`.

## F11. Enforcement modes
- `observe`: results shown and stored; match continues.
- `strict`: the first live failure (failed challenge or `missing_commit`) → `match_end` (`forfeit_proof`), opponent wins. Audit failures after the match set `overturned` instead.
- **AC:** strict mode ends the match within 1 tick of the failing result.

## F12. Proof strip HUD
- Two strips (own + opponent), last 10 windows, newest right: hollow cell = `committed`, ◌ = challenged / proving, ✓ = `valid`, ✕ = any failure (`invalid`, `mismatch_*`, `missing_commit`, `malformed`, `unprovable`, `timeout`), ⛓ = `chain_broken` (UI_UX_SPEC §2).
- Live "Spot-checks: 7/7 passed" per player (challenges decided valid / challenges decided).
- Tooltip: window index, status, prove ms (own only), verify ms.
- **AC:** status visible within 100 ms of `proof_result`; readable by symbol without color.

## F13. Dev cheat panel
- Only in builds with `VITE_DEV_CHEATS=true`; server must also have `DEV_CHEATS=true`.
- Cheats and their effect on proofs:

| Cheat | What it does | Expected result |
|---|---|---|
| Speedhack | `MAX_SPEED × 2` | Cheating windows have no proof (speed constraint) → `unprovable` when challenged/audited (honest dev client) / `timeout` or `unaudited` (silent cheater) |
| Rapid-fire | Ignores cooldown | No proof (weapon constraint) → `unprovable` / `timeout` / `unaudited` |
| Infinite ammo | Never decrements ammo | No proof (ammo transition) → `unprovable` / `timeout` / `unaudited` |
| Snap-aim | Sets angle straight at opponent each tick | No proof when turn > `MAX_TURN` → `unprovable` / `timeout` / `unaudited` |
| Smooth-aim | Turns toward opponent at ≤ `MAX_TURN` | **Valid** proofs — demonstrates the limitation |

- Cheats rewrite the player's real state after the honest tick (`client/src/game/cheats.ts`, shared with the experiment bots); the client still commits every window honestly — a cheated window simply has no witness when it is challenged or audited (`proof_failed` → `unprovable`). Snap-aim snaps to the exact angle every tick (illegal whenever the needed turn exceeds `MAX_TURN`); smooth-aim turns toward the opponent at ≤ `MAX_TURN`.
- F9 opens the drawer; the module and drawer are dynamically imported behind the compile-time `VITE_DEV_CHEATS` flag, so builds without it contain no cheat code.
- Toggle state broadcast via `cheat_flag`; both players see a `CHEAT: …` tag under the name. Each toggle is a `cheat_events` row (window index, time).
- **Detection experiment** (`npm run exp:detect`, `npm run exp:browser`): see CHANGELOG Phase 4 — cheats × cheat duration m, live catch rate vs 1 − (1 − r)^m, audit catch, latency.
- **AC:** a match with a rule-breaking cheat is never `audited_clean` (caught by a challenge live or by the audit; the live detection latency is reported); smooth-aim yields valid results.

## F14. Results screen
- Data from `GET /api/matches/:id`; timeline of all windows; per-player stats; cheat events with "windows to detect"; audit progress ("Auditing… 23/150 windows") while the audit runs, then the audit status, an `OVERTURNED` stamp when the winner failed and an `UNVERIFIED` stamp when the winner's audit did not finish (result stands); research metrics (challenge count, rate r, detection latency, audit duration).
- **AC:** numbers match the DB exactly; download produces valid JSON with no hidden state.

## F15. Benchmark mode
- Variants: `{groth16, plonk} × {30, 60, 120}` (6 total).
- Fixed input log + seed → identical witnesses across runs.
- Per sample: witness ms, prove ms, verify ms, proof bytes, valid flag. Default 20 samples, plus 2 warm-up proofs per variant that are run but not stored.
- Dashboard charts + CSV export.
- **AC:** a run of 6 variants × 20 samples completes and uploads without manual steps; CSV opens in Excel.

## F16. Match history (P1 — after Phase 4)
- "My matches" list (last 20), paginate with `before`.
- **AC:** only the current player's matches are listed.

## F17. Health & circuit info
- `/api/health` for uptime checks; `/api/circuit/info` for the active variant, every constant in `shared/constants.ts`, and `constantsHash`.
- **AC:** client refuses to play on constant mismatch.
