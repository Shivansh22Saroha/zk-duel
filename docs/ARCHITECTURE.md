# ARCHITECTURE — ZK-Duel

## 1. Overview

```
┌──────────────────────── Browser (Player A) ─────────────────────────┐
│  Input ─► Game Sim (60 Hz, integer state) ─► Renderer (Canvas)      │
│              │  public snapshot/tick          ▲ merged state        │
│              │  private witness/tick          │                     │
│              ▼                                │                     │
│        WindowRecorder ──(every window: commitOut)──► window_commit  │
│              │ keeps every window's private input until match end   │
│              ▼                                                      │
│        Proof Queue ──(challenged window first, audit after)──►      │
│              Proof Worker (snarkjs) ──► window_proof / proof_failed │
└──────────────┬──────────────────────────────────────────────────────┘
               │ WebSocket (JSON)                ▲ challenge{k}
┌──────────────▼─────────────────────────────────┴────────────────────┐
│ Server (Node)                                                        │
│  WS Gateway ─► Match Room (tick loop, hit detection, digest builder, │
│                commit store, challenge scheduler, audit)            │
│                    │                     │                           │
│                    ▼                     ▼                           │
│               Verifier Pool          Persistence (SQLite)            │
│           (worker_threads, snarkjs)  matches, windows, bench…        │
│  Fastify REST: auth, match history, bench results, circuit info      │
└──────────────────────────────────────────────────────────────────────┘
               ▲ same protocol
        Browser (Player B)
```

The server is **authoritative for hits and damage**. The client is authoritative for its own **movement, aim and hidden weapon state**. It **commits** to its hidden state at the end of every window, **proves** a window when the server challenges it (unpredictable spot-checks during play), and proves every remaining window in a **post-match audit** (Phase 3 design change, CHANGELOG).

## 2. Monorepo modules

| Path | Responsibility |
|---|---|
| `shared/constants.ts` | Every game constant (PRD §5). Imported by client, server, and the circuit build script (which templates them into circom). |
| `shared/protocol.ts` | WebSocket message types + zod schemas |
| `shared/sim.ts` | Pure, deterministic rule functions: `stepMovement`, `stepWeapon`, `turnDelta`. Used by client sim, server sanity checks, test vector generator. |
| `shared/poseidon.ts` | Wrapper around `circomlibjs` Poseidon so JS and circuit hashes match |
| `client/src/game/` | Input, sim loop (`GameSession`, DOM-free, shared with bots), interpolation, renderer. Renderer seam: `view.ts` — `FrameBuilder.build(now)` → `RenderFrame` → `GameRenderer.draw(frame)`; renderers never import sim/session/input/net (lint-enforced), so a Three.js renderer can replace Canvas 2D without touching game logic |
| `client/src/zk/` | `WindowRecorder`, `ProofQueue`, `proofWorker.ts` (Web Worker), artefact loader (SHA-256 + Cache API), `ProofClient` (commit / challenge / audit protocol, DOM-free — shared with the Node bots) |
| `client/src/ui/` | Screens and HUD (see UI_UX_SPEC.md) |
| `server/src/ws/` | Gateway, auth handshake, message validation |
| `server/src/match/` | `MatchRoom`, queue, room codes, tick loop, hit detection |
| `server/src/zk/` | `DigestBuilder`, `ProofTracker` (commit store, challenge scheduler, status pipeline, audit), `VerifierPool` |
| `server/src/db/` | Migrations + repository functions |
| `server/src/http/` | Fastify routes |
| `circuits/` | `window.circom`, templates, build/test scripts |
| `bench/` | Benchmark runner, recorded input logs, CSV export |

## 3. Game state model

### Public per-tick snapshot (sent every tick, visible to everyone)
```
x:      0..ARENA_W   (int)
y:      0..ARENA_H   (int)
angle:  0..3599      (int, tenths of a degree)
fired:  0 | 1
```

### Private per-tick state (never leaves the client in plaintext)
```
ammo:        0..MAG_SIZE
cooldown:    0..FIRE_COOLDOWN-1
reloadTimer: 0..RELOAD_TICKS
reloadPress: 0 | 1        (input this tick)
```

### Ticks
Ticks are **round-relative** everywhere in the protocol and the sim: the first simulated tick of each round is tick 0. Window k of a round covers ticks `[k·N, k·N+N−1]`. The server derives match-absolute ticks only for the DB (`rounds.start_tick/end_tick`, `matches.total_ticks`).

At the start of every round each player's hidden state is `(ammo, cooldown, reloadTimer) = (MAG_SIZE, 0, 0)` with salt 0, and its `prev` snapshot is its spawn `{x, y, angle, fired: 0}` from `SPAWNS`.

### Deterministic rules (`shared/sim.ts`), applied per tick
Notation: `s = (ammo, cd, rt)` is the hidden state after the previous tick (or the round's initial state); inputs at this tick are `fired` and `reloadPress` (`rp`); `s' = (ammo', cd', rt')` is the state after this tick.
```
Movement:  |x' - x| ≤ MAX_SPEED, |y' - y| ≤ MAX_SPEED   (honest client: each held axis steps exactly MAX_SPEED)
           PLAYER_RADIUS ≤ x' ≤ ARENA_W-PLAYER_RADIUS  (same for y with ARENA_H)
Aim:       d = (angle' - angle + 3600) mod 3600
           min(d, 3600-d) ≤ MAX_TURN
```

**Weapon transition table** (exhaustive; the circuit enforces exactly this):

| # | Condition on `s` and inputs | `ammo'` | `cd'` | `rt'` |
|---|---|---|---|---|
| W1 | `fired = 1` (requires `ammo > 0 ∧ cd = 0 ∧ rt = 0`, else **illegal**) | `ammo − 1` | `FIRE_COOLDOWN − 1` | `0` (`rp` ignored — fire wins) |
| W2 | `fired = 0 ∧ rt > 1` | `ammo` | `max(cd − 1, 0)` | `rt − 1` (`rp` ignored during reload) |
| W3 | `fired = 0 ∧ rt = 1` | `MAG_SIZE` | `max(cd − 1, 0)` | `0` (reload completes) |
| W4 | `fired = 0 ∧ rt = 0 ∧ rp = 1 ∧ ammo < MAG_SIZE` | `ammo` | `max(cd − 1, 0)` | `RELOAD_TICKS` (reload starts) |
| W5 | `fired = 0 ∧ rt = 0 ∧ (rp = 0 ∨ ammo = MAG_SIZE)` | `ammo` | `max(cd − 1, 0)` | `0` |

Consequences: a shot at tick t allows the next shot at exactly t + 12 (5 shots/s). A reload started at tick t completes at t + 90 (ammo = `MAG_SIZE` after that tick); the earliest shot is t + 91. Auto-reload at 0 ammo is just the client setting `rp = 1`.

Clamping happens in the client before the state is committed; the circuit only checks, never clamps.

## 4. Data flow per window — commit every window, prove on challenge, audit after the match

(Phase 3 design change, see CHANGELOG. Live proving of *every* window is not possible on the target hardware — prove time is a multiple of the window's play time — so the client commits to every window, proves the windows the server spot-checks during play, and proves all the rest after the match.)

```
tick t   client: apply input → new state → push {public, private} to WindowRecorder
                 send input_snapshot{tick, x, y, angle, fired}
         server: DigestBuilder appends the snapshot to player p's running digest (in tick order;
                 ticks the client never sent are filled with the previous snapshot, fired = 0);
                 ray-cast if fired; broadcast state
end of window k on the server (state for tick k·N+N−1 processed, or round_end inside window k):
         server: window k has ENDED. digest_k is finalised once p's snapshot for its last tick has
                 arrived (or at the grace deadline / next round start — late-snapshot rule below);
                 only digest_k and the last snapshot (seed for k+1) are kept
end of window k on the client — when the server's `state` for tick k·N+N−1 arrives (the round did
not end inside window k) and the local sim has reached that tick, or on `round_end` with endTick
inside window k (the window is truncated + padded first):
         client: WindowRecorder freezes window k (records + prev + hiddenIn + saltIn), draws a fresh
                 saltOut, computes commitOut_k = Poseidon4(ammo, cooldown, reloadT, saltOut) of the
                 window's last state and sends window_commit{roundNo, windowIndex: k, commitOut}.
                 The full private input of every window stays in memory until the match's audit ends.
         server: stores commitOut_k as the CLAIMED commitment for (p, round, k) → status `committed`;
                 broadcasts proof_result{status: 'committed'}. No window_commit by the end of window
                 k+1 (one window of play after window k ended) → `missing_commit`, and every later
                 window of that round is `chain_broken` (nothing to verify them against).
challenge (server, at most one outstanding per player):
         when player p has no outstanding challenge, the server picks a window uniformly at random
         (crypto.randomInt) among p's windows of the current round that have ended, have a finalised
         digest, and are still `committed`, and broadcasts challenge{playerIndex: p, roundNo,
         windowIndex: k, deadlineMs: PROOF_DEADLINE_MS}. The client cannot predict k: every
         candidate window's commitment was fixed before the draw.
proving (client Proof Queue → Proof Worker, one proof at a time; challenges first, audit after):
         worker: build the circuit input (digest chain, bind, commitIn/commitOut), witness, prove
                 → window_proof{matchId, roundNo, windowIndex: k, scheme, proof, publicSignals, proveMs}
                 → or, if witness generation throws: proof_failed{matchId, roundNo, windowIndex: k, reason}
verification (server, any window order — every window is checked against CLAIMED commitments):
         malformed → bind == Poseidon(matchField, p, roundNo, k) → digest == stored digest_k
         → commitIn == claimed commitOut_{k−1} (round's initialCommit for k = 0)
         → commitOut == claimed commitOut_k → VerifierPool.verify(vkey, publicSignals, proof)
         persist the window row; broadcast proof_result{status, verifyMs, phase}
         challenge deadline passed with no proof → `timeout`
after match_end — audit (AUDIT_TIMEOUT_MIN):
         client: proves every window that is still `committed` (outstanding challenge first, then in
                 window order), one at a time, sending window_proof / proof_failed for each;
                 the results screen shows "Auditing… 23/150 windows".
         server: verifies audit proofs exactly like challenge proofs. When no window of either player
                 is still `committed`, or AUDIT_TIMEOUT_MIN after match_end, the audit closes: windows
                 never proven → `unaudited`; matches.audit_status = audited_clean | audited_failed |
                 audit_incomplete; an audit failure of the winner sets matches.overturned = 1 (winner,
                 score and end_reason are never rewritten); broadcast audit_end.
```

**Why commitments make this sound.** Every window's commitment is fixed when the window ends, before any challenge for it can be drawn. A proof for window k is checked against the commitments claimed for k−1 and k, so the client cannot later "rewrite" the state a window starts or ends in — e.g. refill the magazine across a boundary — without the window that contains the rewrite having no valid proof. A cheat therefore makes at least one committed window unprovable; a live challenge finds it with some probability (SECURITY §7.3), and the audit finds it for certain unless the audit is left incomplete — which is itself visible (`audit_incomplete`, never `audited_clean`).

**Statuses per window** (API_SPEC §5): `committed` (claimed, not yet proven), `valid`, `invalid`, `mismatch_bind`, `mismatch_digest`, `mismatch_commit`, `missing_commit`, `unprovable`, `timeout` (challenge deadline passed), `chain_broken`, `malformed`, and after the audit `unaudited`. Failures = `invalid`, `mismatch_*`, `missing_commit`, `unprovable`, `timeout`, `malformed`.

**Enforcement.** `strict`: the first live failure (a failed challenge or a `missing_commit`) ends the match (`forfeit_proof`). `observe`: results are only recorded. Audit failures after the match never rewrite the result; they set `overturned` when the winner's audit failed.

**Round end.** `round_end` carries `endTick` (the last tick of the round). Both sides build the window containing `endTick` the same way: ticks `> endTick` are dropped and the window is padded up to N ticks by repeating the snapshot at `endTick` with `fired = 0`; hidden state is rolled forward over the padding with `fired = 0, rp = 0` using the table above. If the client's sim has not yet reached `endTick` when `round_end` arrives (it lags the server), it first fills the missing ticks locally with the same hold rule, exactly like the server fills ticks it never received. Windows that start after `endTick` do not exist. Windows of a round that never ended (match ended mid-window by forfeit/disconnect) do not exist either.

**Late snapshots (Phase 1 follow-up, binding for Phase 3).** The server accepts a snapshot up to `PROOF_GRACE_WINDOWS × WINDOW_TICKS` ticks behind its wall-clock tick; anything older is rejected and counts as a strike. Window k's digest must **not** be finalised until either the snapshot for its last tick has arrived or the grace deadline (end of window k + `PROOF_GRACE_WINDOWS`) has passed — only then are still-missing ticks filled (previous snapshot, `fired = 0`). During the round pause, late snapshots for ticks ≤ `endTick` of the ended round still count for its final window's digest; the next round's start finalises it. This guarantees a late but honest snapshot is always part of the digest and never causes `mismatch_digest`. (Hit detection may still have used a held value for that tick; that only affects gameplay, not proofs.) A window is only challenged after its digest is final.

**Commitment chain.** The chain of *claimed* commitments starts each round from the public `initialCommit` and can never be rewound: a claimed commitment is immutable once stored. A failed window does not break the claimed chain (later windows are still checked against the claims), but a `missing_commit` does: every later window of the round is `chain_broken`. Each round starts a fresh chain.

**Disconnect / reconnect.** When a player's socket closes during a live round, every window of that round from the one containing the first tick the server did not receive becomes `chain_broken` (its digest contains held values the client never played; it cannot be proven honestly) — not a failure, but it makes the audit `audit_incomplete` at best. Windows that ended before the gap stay committed/provable; their commits must still arrive by their deadline (the client re-sends any commit the `resume` message does not list). An outstanding challenge keeps its deadline across a reconnect; `resume` repeats it. The next round starts a fresh chain.

## 5. Circuit design (`circuits/window.circom`)

### 5.1 Template structure and parameters (as built in Phase 2)

| File | Template | Checks |
|---|---|---|
| `circuits/src/util.circom` | `InRange(BITS, LO, HI)` | `Num2Bits(BITS)` range check, then `GreaterEqThan`/`LessEqThan` — every comparator input is bit-bounded first (no field wrap) |
| `circuits/src/bounds.circom` | `BoundsCheck(ARENA_W, ARENA_H, R, ANGLES)` | x, y, angle ranges; `fired`, `reloadPress` boolean |
| `circuits/src/speed.circom` | `SpeedCheck(MAX_SPEED)` | `cur − prev + MAX_SPEED ∈ [0, 2·MAX_SPEED]` (one axis) |
| `circuits/src/turn.circom` | `TurnCheck(ANGLES, MAX_TURN)` | shortest-arc turn ≤ MAX_TURN |
| `circuits/src/weapon.circom` | `WeaponStep(MAG, COOLDOWN, RELOAD)` | weapon table W1–W5 exactly |
| `circuits/src/digest.circom` | `DigestChain(N)` | Poseidon chain |
| `circuits/src/commit.circom` | `Commit()` | Poseidon4(ammo, cooldown, reloadT, salt) |
| `circuits/src/bind.circom` | `Bind()` | Poseidon4(matchField, playerIndex, roundNo, windowIndex) |
| `circuits/window.circom` | `Window(N, ARENA_W, ARENA_H, R, MAX_SPEED, ANGLES, MAX_TURN, MAG, COOLDOWN, RELOAD)` | composes all of the above |

`circuits/main_<N>.circom` is **generated** (`circuits/scripts/gen-main.ts`) from `shared/constants.ts`; it is the only place numbers enter the circuit. Bit widths are derived in-circuit with circomlib's `nbits()`. Compiled with `circom --O2`. JS reference: `shared/zkInput.ts` (input object + expected `bind`, `digest`, `commitIn`, `commitOut`).

### 5.2 Signals

**Public signals (4): three public inputs and one public output.** snarkjs orders them `[commitOut, bind, digest, commitIn]` (outputs first); this order is detected from a real proof at build time and stored in `info.json.publicSignalOrder` — code must read it from there.
| Signal | Meaning |
|---|---|
| `bind` | `Poseidon(matchField, playerIndex, roundNo, windowIndex)` — stops proof replay across matches, players, rounds and windows. `matchField` = first 31 bytes of `SHA-256(matchId UUID string, UTF-8)` read as a big-endian integer (always < p) |
| `digest` | Poseidon chain over the window's public snapshots, seeded with the last snapshot of the previous window |
| `commitIn` | Hidden-state commitment entering the window |
| `commitOut` | Hidden-state commitment leaving the window (public output) |

**Private inputs:**
- `matchField, playerIndex, roundNo, windowIndex` (re-hashed to check `bind`)
- `prev[4]` — last public snapshot of previous window `{x, y, angle, fired}` (for continuity)
- `x[N], y[N], angle[N], fired[N]`
- `reloadPress[N]`
- `ammo0, cooldown0, reload0, saltIn` — hidden state entering window
- `ammo[N], cooldown[N], reloadT[N]` — hidden state per tick
- `saltOut`

(`turnD` is no longer a prover input: it is computed in-circuit, see rule 4.)

### 5.3 Constraints per tick i (with i−1 meaning `prev`/initial state for i=0)
1. **Digest chain:** `h[i] = Poseidon5(h[i-1], x[i], y[i], angle[i], fired[i])`; `h[-1] = Poseidon4(prev)`; `digest === h[N-1]`.
2. **Bounds:** `InRange` (Num2Bits then comparators) for x ∈ `[R, W-R]`, y ∈ `[R, H-R]`, angle ∈ `[0, 3599]`; `fired`, `reloadPress` boolean (`b*(b-1)===0`).
3. **Speed:** `InRange(cur − prev + MAX_SPEED)` in `[0, 2·MAX_SPEED]` with a 4-bit `Num2Bits` — a negative step that wraps mod p fails the bit check.
4. **Turn:** helper `k <-- (cur < prev) ? 1 : 0` (the circuit's **only** hand-written `<--`), constrained by `k·(k−1) === 0`; `turnD <== cur − prev + ANGLES·k` (a real constraint, not a prover input) range-checked into `[0, ANGLES−1]`, which has exactly one solution for k; then `LessEqThan(turnD, MAX_TURN) + GreaterEqThan(turnD, ANGLES − MAX_TURN) === 1` (the two cases are exclusive, so no selector witness is needed).
5. **Weapon transition:** `IsZero`/`IsEqual` gadgets enforce the table W1–W5 from §3 exactly. `fired·isZero(ammo) === 0`, `fired·(1−isZero(cooldown)) === 0`, `fired·(1−isZero(reloadT)) === 0`; next state written as single-product constraints. "ammo < MAG" is implemented as "ammo ≠ MAG", identical on every reachable state (ammo starts at MAG via the public initial commitment and every row keeps it in [0, MAG]). Proven in `circuits/test/ammoSafety.test.ts` (Phase 3): the 1,571 hidden states reachable from (MAG, 0, 0) are closed under the circuit relation and bounded, and on them the circuit relation equals `stepWeapon` ("<") for every input. This holds for any window whose `commitIn` traces back to `initialCommit` through windows that all verify; a window whose `commitIn` is only a *claimed*, unproven commitment can start from any state — that is what the audit covers (§4).
6. **Commitments:** `commitIn === Poseidon4(ammo0, cooldown0, reload0, saltIn)`, `commitOut <== Poseidon4(ammo[N-1], cooldown[N-1], reloadT[N-1], saltOut)`.

**Real size (`--O2`):** groth16_4 = 3,292 constraints; groth16_30 = 16,968; **groth16_60 = 32,748 constraints (~537/tick)**, 493 private inputs — lower than the earlier 45–55k estimate. circomspect: no findings.

### 5.4 Initial commitment
At match start the server computes `commitOut_{-1} = Poseidon4(MAG_SIZE, 0, 0, 0)` (known starting state, salt 0) and sends it in `match_found` together with `prevSnapshot` (the player's spawn, `fired = 0`). Every later salt is a fresh random 248-bit field element chosen by the client, so later commitments hide the hidden state. Every new round resets with a fresh public commitment computed the same way, sent in `round_end` together with the new round's `prevSnapshot`.

### 5.5 Build artefacts
```
circuits/build/<scheme>_<N>/window.wasm
circuits/build/<scheme>_<N>/window_final.zkey
circuits/build/<scheme>_<N>/verification_key.json
circuits/build/<scheme>_<N>/info.json   { constraints, publicInputs, publicSignalOrder, ptauPower, ptauFile, ptauSha256, zkeySha256 }
```
`ptauPower` is computed per variant from its real constraint count using snarkjs's own rule (Groth16: `floor(log2(nConstraints + nPubInputs + nOutputs)) + 1`; PLONK, Phase 5: the PLONK constraint count, which is larger than the R1CS count), and the smallest Hermez file of that power is used (groth16_4 → 12, groth16_30 → 15, groth16_60 → 15). Build: `npm run circuits:build` (`circuits/scripts/build.ts`); Groth16 phase 2 = one local contribution with `crypto.randomBytes` entropy that is never stored (SECURITY A8).
The client loads `wasm` + `zkey` from `/zk/<scheme>_<N>/` (static, cached). The server loads only `verification_key.json`.

## 6. Server components

| Component | Detail |
|---|---|
| **WS Gateway** | Validates every message with zod; checks session token on `hello`; per-connection rate limit |
| **Queue / Rooms** | FIFO queue + room-code map; one `MatchRoom` per match |
| **MatchRoom** | `setInterval`-free fixed-step loop using `performance.now()` accumulator; keeps only the snapshots of ticks not yet processed; handles input lag by holding the last snapshot for at most `STALL_TICKS` ticks before marking the player stalled. Integer but out-of-range snapshot values are accepted as sent (so the digest reflects them and the proof fails on bounds) and counted as a strike; malformed types are rejected |
| **Hit detection** | Integer ray vs circle using the shooter's snapshot at that tick; one hit per shot; no projectile travel time |
| **DigestBuilder** | Same Poseidon chain as the circuit, one per player, fed in tick order with the snapshots the client actually sent — independent of tick processing, so a snapshot that arrives late (after the server already held it for hit detection) is still the value in the digest. Ticks the client skipped are filled with the previous snapshot and `fired = 0` (the client fills them identically). `digest_k` is final when window k's last tick is in, or at the grace deadline (end of window k + `PROOF_GRACE_WINDOWS`), or — for a round's last window — at the next round's start; then missing ticks are filled the same way. Only per-window digests and the last snapshot (seed for the next window) are kept |
| **ProofTracker** | Per player: one slot per window (`digest`, claimed `commitOut`, status, challenge). Stores `window_commit`s, applies the `missing_commit` deadline and `chain_broken`, draws challenges (`crypto.randomInt`, one outstanding per player, `PROOF_DEADLINE_MS`), runs the verification pipeline against the claimed commitments, and after `match_end` runs the audit (`AUDIT_TIMEOUT_MIN`), then computes `audit_status`, `overturned` and the research metrics (challenge count, rate r, audit duration) |
| **VerifierPool** | `worker_threads` pool (size = `VERIFIER_THREADS`) running `snarkjs.groth16.verify` / `plonk.verify` with a `VERIFY_TIMEOUT_MS` timeout (→ `invalid`); vkey loaded once per worker |
| **Persistence** | Synchronous `better-sqlite3`; one write per window event (commit, result), never per tick |

## 7. Client components

| Component | Detail |
|---|---|
| **Sim loop** | Fixed 60 Hz step via accumulator; render via `requestAnimationFrame` with interpolation |
| **Input** | Keyboard state + pointer-locked mouse; converts mouse to integer angle, clamps turn to `MAX_TURN` and speed to `MAX_SPEED` (honest client never violates the rules) |
| **WindowRecorder** | Freezes each window when it ends (truncated + padded at round end), chains `prev`/hidden state/salt window to window, draws `saltOut`, computes the commitment for `window_commit`; keeps every window's private input in memory (and in the dev tick log) until the match's audit ends |
| **Proof Queue** | Challenged window first (only one can be outstanding), then — after `match_end` — every still-`committed` window in window order |
| **Audit store** | IndexedDB (`zkduel-audit`): each window's private circuit input is written when the window is frozen and deleted once the server decided it; the match record carries the audit deadline. On page load an unfinished audit inside `AUDIT_TIMEOUT_MIN` is resumed (`AuditResumer`: asks `GET /api/matches/:id/windows` which windows are still `committed` and proves those) |
| **Proof Worker** | Dedicated Web Worker; artefacts loaded once (SHA-256 checked, Cache API); builds the circuit input and proves one window at a time; reports `witnessMs`, `proveMs` |
| **Cheat module** | Only bundled when `VITE_DEV_CHEATS=true`; bypasses the clamps in Input/Weapon |

## 8. Benchmark pipeline

The input log is generated, not recorded: `shared/benchLog.ts` steps a seeded bot (BENCH_SEED) through `shared/sim.ts` for BENCH_LOG_TICKS ticks (a copy is written to `bench/logs/`), and windows of N are cut by the same `sliceLogWindows` as real matches; Node and browser report its SHA-256. `bench/run.ts` (Node) and `/bench` + `client/scripts/bench-browser.ts` (Chrome, Web Worker, Playwright) prove BENCH_WARMUPS + BENCH_SAMPLES windows per variant (scheme × N), verify, and upload to `benchmark_runs` / `benchmark_results`. `bench/export.ts` writes `bench/out/results.csv` and `bench/out/match-metrics.csv` (per-match research metrics).

## 9. Key decisions

| Decision | Why |
|---|---|
| Integer, fixed-point state | Circuits work over a finite field; floats and trig are impractical |
| Server-authoritative hits, client-proven rules | Hit detection needs both players' data; per-player rule compliance is exactly what a ZKP can attest |
| Public snapshots + hidden weapon state | Positions must be shared to render the opponent; ammo/cooldown are genuinely hidden information in shooters |
| Window batching + worker | Per-tick proving is infeasible; batching makes proof time an amortised, measurable cost |
| Commit every window, prove on challenge, audit after the match (Phase 3) | Proving every window live is slower than real time on the target hardware. Commitments fix the hidden state every window; unpredictable spot-checks give live detection with probability ≈ 1 − (1 − r)^m; the post-match audit is the full guarantee |
| Groth16 primary, PLONK comparison | Groth16 has the smallest proofs and fastest verify; PLONK avoids per-circuit setup |
| SQLite | Single-machine research prototype; zero ops |
