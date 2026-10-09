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

## F9. Window recording & proving
- WindowRecorder collects N ticks; once the server's `state` for the window's last tick arrives (or `round_end` with `endTick` inside the window) it builds the circuit input (ARCHITECTURE.md §5.2), generates a fresh `saltOut` with `crypto.getRandomValues` reduced mod p.
- If witness generation/proving throws, the client sends `proof_failed` (→ `unprovable`) and shows a local "proof could not be generated" note.
- After any non-valid result in a round the client stops proving the rest of that round (the server marks those windows `chain_broken`).
- Proof Worker: one proof at a time; queue max 2; if the queue would exceed 2, the oldest unproven window is dropped (it will time out) and a warning is logged.
- Reports `witnessMs`, `proveMs` to the HUD and in the `window_proof` message.
- A partial window at round end is padded (API_SPEC.md §5).
- **AC:** with N=60 on the baseline laptop, frame time p95 < 20 ms while proving; no window skipped in a clean 3-minute match (if prove time < window duration).

## F10. Server verification
- Order: chain_broken → schema → bind → digest → commitIn → `verify` in worker pool (2 s timeout). Decided in window order. `proof_failed` → `unprovable` immediately.
- Results persisted per window; `proof_result` broadcast to both players.
- Timeout sweep runs every tick: any window k without a result by end of window k+2 → `timeout`.
- First non-valid window in a round → all later windows of that round `chain_broken`.
- **AC:** each mismatch type is produced by a dedicated integration test; verify p95 < 50 ms.

## F11. Enforcement modes
- `observe`: results shown and stored; match continues.
- `strict`: first non-valid result → `match_end` (`forfeit_proof`), opponent wins.
- **AC:** strict mode ends the match within 1 tick of the failing result.

## F12. Proof strip HUD
- Two strips (own + opponent), last 10 windows, newest right, statuses ✓ valid, ✕ any failure (`invalid`, `mismatch_*`, `malformed`, `unprovable`), ◌ pending, – `timeout`, ⛓ `chain_broken` (UI_UX_SPEC §2).
- Tooltip: window index, status, prove ms (own only), verify ms.
- **AC:** status visible within 100 ms of `proof_result`; readable by symbol without color.

## F13. Dev cheat panel
- Only in builds with `VITE_DEV_CHEATS=true`; server must also have `DEV_CHEATS=true`.
- Cheats and their effect on proofs:

| Cheat | What it does | Expected result |
|---|---|---|
| Speedhack | `MAX_SPEED × 2` | No proof (speed constraint) → `unprovable` (honest client) / `timeout` (silent cheater) |
| Rapid-fire | Ignores cooldown | No proof (weapon constraint) → `unprovable` / `timeout` |
| Infinite ammo | Never decrements ammo | No proof (ammo transition) → `unprovable` / `timeout` |
| Snap-aim | Sets angle straight at opponent each tick | No proof when turn > `MAX_TURN` → `unprovable` / `timeout` |
| Smooth-aim | Turns toward opponent at ≤ `MAX_TURN` | **Valid** proofs — demonstrates the limitation |

- Toggle state broadcast via `cheat_flag`; both players see a `CHEAT` tag.
- **AC:** each rule-breaking cheat yields a non-valid result within 3 windows; smooth-aim yields valid results.

## F14. Results screen
- Data from `GET /api/matches/:id`; timeline of all windows; per-player stats; cheat events with "windows to detect".
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
