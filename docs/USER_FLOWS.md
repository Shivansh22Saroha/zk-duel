# USER FLOWS — ZK-Duel

Each flow lists the steps, what the system does, and the failure branches.

## Flow 1 — First visit to a finished match (quick play)

1. Player opens `/`. Client fetches `GET /api/circuit/info`, compares constants with its bundle.
   - ✕ Mismatch → banner "Client and server versions differ. Refresh." Play disabled.
2. Player types a display name. Inline validation.
3. Player clicks **Find Match**.
   - Client calls `POST /api/auth/guest` (if no valid token in `sessionStorage`), opens `/ws`, sends `hello`.
   - Client starts downloading `window.wasm` + `window_final.zkey` (progress bar).
   - Client sends `queue_join`.
4. Queue screen: "Waiting for opponent… 00:07".
   - Player clicks **Cancel** → `queue_leave` → back to step 2.
5. Second player joins → both receive `match_found`.
6. Client finishes the artefact download, checks SHA-256 against `zkeySha256`, sends `ready`.
   - ✕ Hash mismatch → error screen "Proving key corrupted — retry download." No `ready` is sent; after 30 s the server cancels the match for both.
7. Both `ready` → `countdown` 3-2-1 → `start`.
8. Gameplay (see Flow 3). Round ends → banner → next round.
9. `match_end` → Results screen (Flow 6).

## Flow 2 — Private room (demo with an examiner)

1. Player A: Landing → **Private Room ▾ → Create room** → chooses enforcement `strict` → `POST /api/rooms`.
2. Client A sends `room_join` with the returned code. Room screen shows code `K7QX2M` with copy button.
3. Player B: Landing → **Private Room ▾ → Join with code** → enters code → `room_join`.
   - ✕ Unknown/expired code → inline error "Room not found or expired."
   - ✕ Room full → "Room already has two players."
4. Continue from Flow 1 step 5.

## Flow 3 — Playing a window (happens every second)

1. Each tick, the client reads input, applies the rules (clamped to legal values), updates hidden weapon state, records `{public, private}` into the WindowRecorder, sends `input_snapshot`.
2. Server buffers snapshots, resolves shots, broadcasts `state`. Client renders opponent with interpolation.
3. When the server's `state` for the window's last tick arrives, the recorder freezes the window, commits to its hidden state and sends `window_commit`. The HUD adds a hollow (committed) cell on both screens.
   - ✕ No commit by the end of the next window → `missing_commit` (✕); the rest of the round is `chain_broken` (⛓).
4. Whenever the player has no outstanding challenge, the server draws one of their ended, committed windows at random and sends `challenge`. That cell turns ◌; the Proof Worker proves it (≈ 1.6 s at N=60 in Chrome) → client sends `window_proof`.
   - ✕ Witness generation throws → client sends `proof_failed` → server records `unprovable`.
5. Server checks bind → digest → commitIn/commitOut against the claimed commitments → verify → sends `proof_result`; the next challenge follows.
6. The cell turns ✓ (green) or ✕ (red) on both players' screens; "Spot-checks: 7/7 passed" updates.
   - ✕ Proof not received within `PROOF_DEADLINE_MS` → `timeout` (✕).
   - ✕ In `strict` mode a failed challenge → `match_end` reason `forfeit_proof`, red banner with window number and status.
7. At round end, `round_end{endTick}` arrives; client and server truncate the window containing `endTick` and pad it identically, and that window is committed like any other.
8. After `match_end` the results screen shows "Auditing… 23/150 windows" while the client proves every window still committed (Flow 6).

## Flow 4 — Cheat demonstration (researcher, dev build)

1. Researcher builds with `VITE_DEV_CHEATS=true` and runs the server with `DEV_CHEATS=true`.
2. Starts a private room in `strict` or `observe` mode with a second player.
3. Mid-round presses **F9** → cheat drawer opens.
4. Toggles **Speedhack** → client sends `cheat_toggle`; server records `cheat_events` and broadcasts `cheat_flag`; both screens show `CHEAT: speedhack` under the name.
5. The player now moves 8 units/tick. The client still commits every window (the commitment hides nothing illegal by itself), but the circuit's speed constraint can't be satisfied for the cheating windows: **no valid proof exists**. When one of them is challenged, witness generation throws in the worker; the honest (dev) client sends `proof_failed` and shows a local "proof could not be generated" note; the server records `unprovable`. (A real cheater would stay silent instead → `timeout` at the challenge deadline.)
6. The HUD turns red when a cheating window is challenged — live, with probability ≈ 1 − (1 − r)^m for m cheating windows — and at the latest in the post-match audit, which proves every window: the match ends `audited_failed` (or `audit_incomplete` if the cheater abandons the audit), never `audited_clean`. In `strict` mode the first failed challenge ends the match.
7. Researcher toggles **Smooth aim** → proofs stay green → explains the input-provenance limitation.

## Flow 5 — Disconnect & reconnect

1. Player's socket drops. Server marks `opponent_status: reconnecting` to the other player; that player's sim keeps running, and the disconnected player's last snapshot is held.
2. Client auto-reconnects (backoff 0.5 s, 1 s, 2 s), sends `hello` with the same token.
3. Server re-attaches the socket to the match and sends `resume{roundNo, nextWindowIndex, chainStatus, committed, challenge}` followed by the current `state`.
   - Windows from the gap on → `chain_broken` for the rest of that round (their digests contain ticks the server never received), so `chainStatus = 'broken'`. The client re-sends any commit for an earlier window that `committed` does not list (if still within its deadline), re-sends or re-proves the outstanding `challenge`, keeps playing, and resumes committing at the next round's fresh `initialCommit`.
   - A disconnect during the post-match audit: the client reconnects the same way and continues sending audit proofs (they carry `matchId`).
4. ✕ No reconnect within 10 s → `match_end` reason `disconnect`, remaining player wins.

## Flow 6 — Results review

1. Results screen loads `GET /api/matches/:id`.
2. Shows winner, score, per-player proof stats, full window timeline, cheat events, research metrics.
3. While the audit runs: "Auditing… 23/150 windows"; the client keeps proving in the worker and the timeline fills in live. When the server sends `audit_end`: `AUDITED CLEAN` / `AUDIT FAILED` / `AUDIT INCOMPLETE`, plus `OVERTURNED` if the winner failed.
   - ✕ Player leaves before the audit ends → confirm dialog; remaining windows become `unaudited` → `audit_incomplete`.
4. **Download match log** → `GET /api/matches/:id/log`.
5. **Back to lobby** → Landing. (Rematch was dropped — not in PRD.)

## Flow 7 — Benchmark run (researcher)

**CLI (Node):**
1. `npm run bench -- --log bench/logs/rec_01.jsonl --samples 20`.
2. Script replays the log through `shared/sim.ts`, builds inputs for each variant (groth16/plonk × 30/60/120), proves and verifies each 20 times, prints a summary table.
3. Uploads to `POST /api/bench/runs` with `X-Bench-Token`; writes `bench/out/results.csv`.

**Browser (realistic):**
1. Open `/bench`, enter a device label, click **Run benchmark in this browser**.
2. Page downloads all variant artefacts (progress shown), proves each sample in a worker, shows a live progress bar and partial results.
3. On finish → uploads results → charts refresh with the new run selected.
   - ✕ Tab hidden during run → warn "Background tabs are throttled; results may be slower" and flag the run in `notes`.

## Flow 8 — Viewing past matches (P1 — after Phase 4)

1. Landing → **My matches** (visible when a token exists).
2. List from `GET /api/matches`; click a row → Results screen for that match.
