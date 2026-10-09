# FEATURES — ZK-Duel

Feature-by-feature behaviour. Constants refer to `shared/constants.ts` (PRD §5). Each feature lists its acceptance criteria (AC).

---

## F1. Guest session
- Name entry → `POST /api/auth/guest` → token stored in `sessionStorage` (cleared when the tab closes).
- Re-opening the site in the same tab reuses a valid token.
- **AC:** invalid names never reach the server; a revoked token gets `TOKEN_EXPIRED` and the user is returned to name entry.

## F2. Matchmaking queue
- FIFO; the first two `queue_join` players are paired.
- Queue enforcement defaults to the server's `DEFAULT_ENFORCEMENT`.
- A player cannot be in the queue and a match at once (`ALREADY_IN_MATCH`).
- **AC:** two players clicking Find Match within 1 s are paired in < 500 ms; cancelling removes the player immediately.

## F3. Private rooms
- Create returns a 6-char code (alphabet without 0/O/1/I). Codes expire after 10 min unused.
- Creator chooses enforcement (`observe`/`strict`). Window size and scheme come from server config.
- **AC:** joining a full or expired room shows the matching error; codes are case-insensitive on entry.

## F4. Artefact loading & integrity
- On `match_found` (or earlier, on queue join) the client fetches `window.wasm` and `window_final.zkey` for the match's variant, with download progress.
- SHA-256 via `crypto.subtle.digest` compared with `zkeySha256` from `/api/circuit/info`.
- Artefacts cached with the Cache API keyed by hash; a second match needs no download.
- **AC:** a modified zkey is rejected before `ready`; the cached path loads in < 1 s.

## F5. Deterministic simulation
- Fixed 60 Hz step, integer state, rules from `shared/sim.ts` only.
- Movement: WASD sets a desired direction; per-axis step is `MAX_SPEED` in that direction, then clamped to arena bounds `[R, W−R]`/`[R, H−R]`.
- Aim: mouse delta × sensitivity → target angle; per-tick change clamped to `MAX_TURN` along the shortest arc; stored mod 3600.
- Firing: left mouse held = attempt fire each tick; allowed only when `ammo>0 ∧ cooldown==0 ∧ reloadTimer==0`.
- Auto-reload when ammo hits 0; manual reload with R when `ammo < MAG_SIZE`.
- **AC:** replaying the same input log twice produces identical state hashes; every honest window satisfies the circuit (property test).

## F6. Snapshot streaming
- Client sends `input_snapshot` every tick with public fields only.
- Server holds a ring buffer of the last `2 × WINDOW_TICKS` snapshots per player.
- Missing ticks are filled by repeating the previous snapshot with `fired=0` (max 6); the client applies the same fill rule when it detects its own send gap after reconnect, so digests still match.
- **AC:** no hidden field ever appears in a WS frame (asserted in an integration test that inspects every frame).

## F7. Server-authoritative hits
- On `fired=1` at tick t: ray from `(x,y)` at `angle` (converted with a precomputed integer sin/cos table scaled by 1024), length 1200, vs opponent circle at their tick-t snapshot.
- One hit max per shot; damage `DAMAGE`; HP ≤ 0 ends the round.
- Simultaneous lethal hits in the same tick → both survive at 1 HP (deterministic tie rule).
- **AC:** unit tests for ray-circle at edges, angle wrap (0/3599), and tie rule.

## F8. Rounds & match
- Best of 5 (`ROUNDS_TO_WIN = 3`). Fixed spawns: P0 `(150, 300)` angle 0; P1 `(850, 300)` angle 1800.
- New round: tick counter, window counter and hidden state reset; new public `initialCommit` sent in `round_end`.
- 1.5 s pause between rounds (server keeps sending `state`, but no input is applied and no windows are counted).
- **AC:** window indices restart at 0 each round; a proof from round 1 can't be accepted in round 2 because `bind = Poseidon(matchField, playerIndex, roundNo, windowIndex)`.

## F9. Window recording & proving
- WindowRecorder collects N ticks; at rollover builds the circuit input (ARCHITECTURE.md §5.2), generates a fresh `saltOut` with `crypto.getRandomValues` reduced mod p.
- Proof Worker: one proof at a time; queue max 2; if the queue would exceed 2, the oldest unproven window is dropped (it will time out) and a warning is logged.
- Reports `witnessMs`, `proveMs` to the HUD and in the `window_proof` message.
- A partial window at round end is padded (API_SPEC.md §5).
- **AC:** with N=60 on the baseline laptop, frame time p95 < 20 ms while proving; no window skipped in a clean 3-minute match (if prove time < window duration).

## F10. Server verification
- Order: schema → bind → digest → commitIn → `verify` in worker pool (2 s timeout).
- Results persisted per window; `proof_result` broadcast to both players.
- Timeout sweep runs every tick: any window k without a result by end of window k+2 → `timeout`.
- **AC:** each mismatch type is produced by a dedicated integration test; verify p95 < 50 ms.

## F11. Enforcement modes
- `observe`: results shown and stored; match continues.
- `strict`: first non-valid result → `match_end` (`forfeit_proof`), opponent wins.
- **AC:** strict mode ends the match within 1 tick of the failing result.

## F12. Proof strip HUD
- Two strips (own + opponent), last 10 windows, newest right, statuses ✓ ✕ ◌ –.
- Tooltip: window index, status, prove ms (own only), verify ms.
- **AC:** status visible within 100 ms of `proof_result`; readable by symbol without color.

## F13. Dev cheat panel
- Only in builds with `VITE_DEV_CHEATS=true`; server must also have `DEV_CHEATS=true`.
- Cheats and their effect on proofs:

| Cheat | What it does | Expected result |
|---|---|---|
| Speedhack | `MAX_SPEED × 2` | No proof (speed constraint) → `timeout` |
| Rapid-fire | Ignores cooldown | No proof (weapon constraint) → `timeout` |
| Infinite ammo | Never decrements ammo | No proof (ammo transition) → `timeout` |
| Snap-aim | Sets angle straight at opponent each tick | No proof when turn > `MAX_TURN` → `timeout` |
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

## F16. Match history
- "My matches" list (last 20), paginate with `before`.
- **AC:** only the current player's matches are listed.

## F17. Health & circuit info
- `/api/health` for uptime checks; `/api/circuit/info` for the active variant and constants.
- **AC:** client refuses to play on constant mismatch.
