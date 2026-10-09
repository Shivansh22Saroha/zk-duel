# ARCHITECTURE — ZK-Duel

## 1. Overview

```
┌──────────────────────── Browser (Player A) ─────────────────────────┐
│  Input ─► Game Sim (60 Hz, integer state) ─► Renderer (Canvas)      │
│              │  public snapshot/tick          ▲ merged state        │
│              │  private witness/tick          │                     │
│              ▼                                │                     │
│        WindowRecorder ──(every N ticks)──► Proof Worker (snarkjs)   │
│                                               │ proof + signals     │
└──────────────┬────────────────────────────────┼─────────────────────┘
               │ WebSocket (JSON)               │
┌──────────────▼────────────────────────────────▼─────────────────────┐
│ Server (Node)                                                        │
│  WS Gateway ─► Match Room (tick loop, hit detection, digest builder) │
│                    │                     │                           │
│                    ▼                     ▼                           │
│               Verifier Pool          Persistence (SQLite)            │
│           (worker_threads, snarkjs)  matches, windows, bench…        │
│  Fastify REST: auth, match history, bench results, circuit info      │
└──────────────────────────────────────────────────────────────────────┘
               ▲ same protocol
        Browser (Player B)
```

The server is **authoritative for hits and damage**. The client is authoritative for its own **movement, aim and hidden weapon state**, and must prove each window obeyed the rules.

## 2. Monorepo modules

| Path | Responsibility |
|---|---|
| `shared/constants.ts` | Every game constant (PRD §5). Imported by client, server, and the circuit build script (which templates them into circom). |
| `shared/protocol.ts` | WebSocket message types + zod schemas |
| `shared/sim.ts` | Pure, deterministic rule functions: `stepMovement`, `stepWeapon`, `turnDelta`. Used by client sim, server sanity checks, test vector generator. |
| `shared/poseidon.ts` | Wrapper around `circomlibjs` Poseidon so JS and circuit hashes match |
| `client/src/game/` | Input, sim loop, interpolation, renderer |
| `client/src/zk/` | `WindowRecorder`, `proofWorker.ts`, artefact loader |
| `client/src/ui/` | Screens and HUD (see UI_UX_SPEC.md) |
| `server/src/ws/` | Gateway, auth handshake, message validation |
| `server/src/match/` | `MatchRoom`, queue, room codes, tick loop, hit detection |
| `server/src/zk/` | `DigestBuilder`, `VerifierPool`, commitment chain check |
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
cooldown:    0..FIRE_COOLDOWN
reloadTimer: 0..RELOAD_TICKS
reloadPress: 0 | 1        (input this tick)
```

### Deterministic rules (`shared/sim.ts`), applied per tick t → t+1
```
Movement:  |x[t+1]-x[t]| ≤ MAX_SPEED, |y[t+1]-y[t]| ≤ MAX_SPEED
           PLAYER_RADIUS ≤ x ≤ ARENA_W-PLAYER_RADIUS  (same for y)
Aim:       d = (angle[t+1] - angle[t] + 3600) mod 3600
           min(d, 3600-d) ≤ MAX_TURN
Weapon (evaluated with state at t, input fired[t+1]):
  if fired:  require ammo>0 ∧ cooldown==0 ∧ reloadTimer==0
             ammo' = ammo-1, cooldown' = FIRE_COOLDOWN
  else:      cooldown' = max(cooldown-1, 0)
  reload:    if reloadPress ∧ reloadTimer==0 ∧ ammo<MAG_SIZE: reloadTimer' = RELOAD_TICKS
             else if reloadTimer>0: reloadTimer' = reloadTimer-1;
                                    if reloadTimer'==0: ammo' = MAG_SIZE
```
Clamping happens in the client before the state is committed; the circuit only checks, never clamps.

## 4. Data flow per window

```
tick t   client: apply input → new state → push {public, private} to WindowRecorder
                 send input_snapshot{tick, x, y, angle, fired}
         server: store snapshot in room buffer; ray-cast if fired; broadcast state
end of window k (tick % WINDOW_TICKS == WINDOW_TICKS-1):
         client: recorder hands window k to Proof Worker (postMessage, transferable)
                 worker: snarkjs.groth16.fullProve(input, wasm, zkey)
                 → send window_proof{windowIndex:k, proof, publicSignals}
         server: DigestBuilder computes digest_k from its own buffered snapshots
                 checks publicSignals.digest == digest_k
                 checks publicSignals.commitIn == stored commitOut_{k-1}
                 VerifierPool.verify(vkey, publicSignals, proof)
                 persist window row; store commitOut_k; send proof_result
```

The client keeps playing window k+1 while window k is being proven. A window's proof is late if not received before the end of window `k + PROOF_GRACE_WINDOWS`.

## 5. Circuit design (`circuits/window.circom`)

### 5.1 Template parameters
`Window(N, ARENA_W, ARENA_H, R, MAX_SPEED, MAX_TURN, MAG, COOLDOWN, RELOAD)` — values injected from `shared/constants.ts` by the build script into `circuits/main_<N>.circom`.

### 5.2 Signals

**Public inputs (4):**
| Signal | Meaning |
|---|---|
| `bind` | `Poseidon(matchField, playerIndex, roundNo, windowIndex)` — stops proof replay across matches, players, rounds and windows |
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
- `turnD[N]` — witness helper for angle difference

### 5.3 Constraints per tick i (with i−1 meaning `prev`/initial state for i=0)
1. **Digest chain:** `h[i] = Poseidon5(h[i-1], x[i], y[i], angle[i], fired[i])`; `h[-1] = Poseidon4(prev)`; `digest === h[N-1]`.
2. **Bounds:** `LessEqThan` checks for x, y within `[R, W-R]`/`[R, H-R]`; `angle < 3600`; `fired`, `reloadPress` boolean (`b*(b-1)===0`).
3. **Speed:** `|Δx| ≤ MAX_SPEED` via `LessEqThan(Δx + MAX_SPEED, 2·MAX_SPEED)` with range-checked bit width (prevents field wrap).
4. **Turn:** witness `turnD[i]` with constraint `angle[i] - angle[i-1] + 3600·k === turnD[i]`, `k ∈ {0,1}`, `turnD < 3600`; then `min(turnD, 3600-turnD) ≤ MAX_TURN` using a selector bit.
5. **Weapon transition:** using `IsZero`/`LessThan` gadgets, enforce the exact transition from §3. `fired[i]=1` forces `ammo>0`, `cooldown==0`, `reloadT==0` on the previous state.
6. **Commitments:** `commitIn === Poseidon4(ammo0, cooldown0, reload0, saltIn)`, `commitOut === Poseidon4(ammo[N-1], cooldown[N-1], reloadT[N-1], saltOut)`.

Expected size: roughly 700–900 constraints per tick (dominated by the Poseidon in step 1) → ~45–55k for N=60. **Estimate only — record the real count from `snarkjs r1cs info`.**

### 5.4 Initial commitment
At match start the server computes `commitOut_{-1} = Poseidon4(MAG_SIZE, 0, 0, 0)` (known starting state, salt 0) and sends it in `match_found`. Every later salt is a fresh random 248-bit field element chosen by the client, so later commitments hide the hidden state. A new round resets with a fresh public commitment computed the same way.

### 5.5 Build artefacts
```
circuits/build/<scheme>_<N>/window.wasm
circuits/build/<scheme>_<N>/window_final.zkey
circuits/build/<scheme>_<N>/verification_key.json
circuits/build/<scheme>_<N>/info.json   { constraints, publicInputs, publicSignalOrder, ptauPower, zkeySha256 }
```
The client loads `wasm` + `zkey` from `/zk/<scheme>_<N>/` (static, cached). The server loads only `verification_key.json`.

## 6. Server components

| Component | Detail |
|---|---|
| **WS Gateway** | Validates every message with zod; checks session token on `hello`; per-connection rate limit |
| **Queue / Rooms** | FIFO queue + room-code map; one `MatchRoom` per match |
| **MatchRoom** | `setInterval`-free fixed-step loop using `performance.now()` accumulator; buffers 2 windows of snapshots per player; handles input lag by holding the last snapshot for at most 6 ticks before marking the player stalled |
| **Hit detection** | Integer ray vs circle using the shooter's snapshot at that tick; one hit per shot; no projectile travel time |
| **DigestBuilder** | Same Poseidon chain as the circuit, computed from the room's buffered snapshots |
| **VerifierPool** | `worker_threads` pool (size = `VERIFIER_THREADS`) running `snarkjs.groth16.verify` / `plonk.verify`; vkeys loaded once at boot |
| **Persistence** | Synchronous `better-sqlite3`, writes batched once per window, never per tick |

## 7. Client components

| Component | Detail |
|---|---|
| **Sim loop** | Fixed 60 Hz step via accumulator; render via `requestAnimationFrame` with interpolation |
| **Input** | Keyboard state + pointer-locked mouse; converts mouse to integer angle, clamps turn to `MAX_TURN` and speed to `MAX_SPEED` (honest client never violates the rules) |
| **WindowRecorder** | Ring buffer of the current window's public + private state; on rollover produces the circuit input object |
| **Proof Worker** | Dedicated Web Worker; loads artefacts once; one proof at a time; queues at most 2; reports `{proveMs, constraints}` |
| **Cheat module** | Only bundled when `VITE_DEV_CHEATS=true`; bypasses the clamps in Input/Weapon |

## 8. Benchmark pipeline

`bench/run.ts` replays recorded input logs (`bench/logs/*.jsonl`) through `shared/sim.ts`, builds circuit inputs for every variant (scheme × N), proves ≥ 20 times each (Node or Playwright-driven browser), verifies, and writes rows to `benchmark_runs` / `benchmark_results`. `bench/export.ts` writes `bench/out/results.csv`.

## 9. Key decisions

| Decision | Why |
|---|---|
| Integer, fixed-point state | Circuits work over a finite field; floats and trig are impractical |
| Server-authoritative hits, client-proven rules | Hit detection needs both players' data; per-player rule compliance is exactly what a ZKP can attest |
| Public snapshots + hidden weapon state | Positions must be shared to render the opponent; ammo/cooldown are genuinely hidden information in shooters |
| Window batching + worker | Per-tick proving is infeasible; batching makes proof time an amortised, measurable cost |
| Groth16 primary, PLONK comparison | Groth16 has the smallest proofs and fastest verify; PLONK avoids per-circuit setup |
| SQLite | Single-machine research prototype; zero ops |
