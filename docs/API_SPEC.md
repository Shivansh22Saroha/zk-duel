# API SPEC — ZK-Duel

Base URL (dev): `http://localhost:8080`
WebSocket (dev): `ws://localhost:8080/ws`
All bodies JSON, UTF-8. All field elements (hashes, commitments, signals) are **decimal strings** — never JS numbers.

## 1. Authentication

Guest sessions only.
1. `POST /api/auth/guest` with a display name → returns a signed JWT (HS256, `JWT_SECRET`, 24 h expiry, `jti` stored in `sessions`).
2. REST: `Authorization: Bearer <token>` on protected routes.
3. WebSocket: the first message must be `hello` with the token. Any other first message, or no `hello` within 5 s, closes the socket with code `4401`.

Unprotected: `/api/health`, `/api/circuit/info`, `GET /api/bench/*`, static `/zk/*`.

## 2. Error format

```json
{ "error": { "code": "INVALID_NAME", "message": "Display name must be 3–16 characters [A-Za-z0-9_]." } }
```
| HTTP | Codes |
|---|---|
| 400 | `INVALID_NAME`, `INVALID_BODY`, `INVALID_ROOM_CODE` |
| 401 | `UNAUTHORIZED`, `TOKEN_EXPIRED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_IN_MATCH` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` |

## 3. REST endpoints

### `GET /api/health`
`200 { "status": "ok", "uptimeS": 1234, "activeMatches": 1, "circuits": ["groth16_60"] }`

### `POST /api/auth/guest`
Request `{ "displayName": "shiva_01" }`
Response `201 { "token": "<jwt>", "player": { "id": "uuid", "displayName": "shiva_01" }, "expiresAt": 1760000000000 }`
Rate limit: 10/min per IP.

### `POST /api/auth/logout` 🔒
Revokes the session. `204`.

### `GET /api/circuit/info`
```json
{
  "active": "groth16_60",
  "variants": [
    { "id": "groth16_60", "scheme": "groth16", "windowTicks": 60,
      "constraints": 51234, "publicInputs": 4,
      "zkeyUrl": "/zk/groth16_60/window_final.zkey",
      "wasmUrl": "/zk/groth16_60/window.wasm",
      "zkeySha256": "ab12…", "zkeyBytes": 24000000 }
  ],
  "constants": { "TICK_RATE": 60, "MAX_SPEED": 4, "MAX_TURN": 150, "MAG_SIZE": 10,
                 "FIRE_COOLDOWN": 12, "RELOAD_TICKS": 90, "ARENA_W": 1000, "ARENA_H": 600,
                 "PLAYER_RADIUS": 12, "…": "every constant exported by shared/constants.ts" },
  "constantsHash": "<hex>"
}
```
`constants` contains **every** constant in `shared/constants.ts`. `constantsHash` = hex SHA-256 of the canonical JSON of that object (keys sorted recursively, no whitespace). The client must compare it with its own bundled constants and refuse to play on mismatch (`VERSION_MISMATCH` toast).

### `POST /api/rooms` 🔒
Creates a private room. Request `{ "enforcement": "strict" }` (optional, default `observe`).
Response `201 { "roomCode": "K7QX2M", "expiresAt": … }` (expires in 10 min if unused). The creator then sends WS `room_join` with this code, like the second player.

### `GET /api/matches?limit=20&before=<ms>` 🔒 (P1 — match history, built after Phase 4)
Current player's recent matches.
```json
{ "matches": [ { "id": "uuid", "startedAt": 0, "endedAt": 0, "mode": "queue",
  "opponent": "rahul_7", "result": "win", "score": "3-1",
  "windows": { "valid": 112, "invalid": 0, "timeout": 1 } } ], "nextBefore": 0 }
```

### `GET /api/matches/:id` 🔒 (participants only, or any when `PUBLIC_MATCHES=true`)
Full match summary: players, rounds, per-player window stats (counts by status, mean/p95 prove ms, mean verify ms), cheat events, enforcement, scheme, window size.

### `GET /api/matches/:id/windows?player=0` 🔒
`{ "windows": [ { "roundNo": 1, "windowIndex": 0, "startTick": 0, "status": "valid", "proveMs": 410, "verifyMs": 5.8, "proofBytes": 805 } ] }` (`startTick` is round-relative here)

### `GET /api/matches/:id/log` 🔒
Downloadable JSON match log (summary + windows + cheat events). No hidden state included.

### `GET /api/bench/runs`
`{ "runs": [ { "id": "uuid", "createdAt": 0, "environment": "browser", "deviceLabel": "…", "samples": 360 } ] }`

### `GET /api/bench/runs/:id`
Aggregates per variant: `{ scheme, windowTicks, constraints, n, proveMs: { mean, p50, p95, p5 }, verifyMs: { mean }, proofBytes, witnessMs: { mean } }`.

### `GET /api/bench/runs/:id/csv`
`text/csv` of all raw `benchmark_results` rows.

### `POST /api/bench/runs` 🔒 (requires `BENCH_TOKEN` header `X-Bench-Token`)
Used by the CLI / browser bench page to upload results.
```json
{ "environment": "browser", "deviceLabel": "Laptop i5 16GB", "userAgent": "…",
  "cpuThreads": 8, "inputLog": "rec_2026-10-20.jsonl", "seed": 42, "gitCommit": "abc123",
  "results": [ { "scheme": "groth16", "windowTicks": 60, "constraints": 51234,
    "sampleNo": 1, "witnessMs": 38.2, "proveMs": 612.4, "verifyMs": 6.1,
    "proofBytes": 805, "valid": true } ] }
```
Server re-verifies nothing here (bench data is self-reported); max 2000 results per request. `201 { "runId": "uuid" }`.

## 4. WebSocket protocol (`/ws`)

Envelope: `{ "t": "<type>", ...fields }`. Every message is validated against a zod schema in `shared/protocol.ts`; invalid messages → `error` + increment strike counter; 5 strikes closes with `4400`.

### Client → Server

| Type | Fields | Notes |
|---|---|---|
| `hello` | `token`, `clientVersion`, `constantsHash` | Must be first. `constantsHash` as defined in §3 `/api/circuit/info`; mismatch → `error VERSION_MISMATCH` |
| `queue_join` | — | Ignored if already in a match. Queue matches always use the server's `DEFAULT_ENFORCEMENT` |
| `queue_leave` | — | |
| `room_join` | `roomCode` | Sent by **both** players — the creator joins their own room with the code returned by `POST /api/rooms` |
| `ready` | `artefactSha256` | Sent after proving key loaded and hash checked |
| `input_snapshot` | `tick`, `x`, `y`, `angle`, `fired` | One per tick; `tick` is round-relative; must be integers (non-integers / wrong types are rejected). Integer values outside the legal range are **accepted into the digest as sent** and counted as a strike (the proof then fails on bounds). Out-of-order ticks dropped |
| `window_proof` | `roundNo`, `windowIndex`, `scheme`, `proof`, `publicSignals[4]`, `proveMs` | `publicSignals` order is read from `info.json.publicSignalOrder` (circom puts outputs first, then public inputs in template declaration order) — never hard-coded |
| `proof_failed` | `roundNo`, `windowIndex`, `reason` | Honest client reports that witness generation / proving threw for this window. Server records `unprovable` immediately. `reason` ≤ 200 chars, informational only |
| `cheat_toggle` | `cheat`, `enabled`, `tick` | Accepted only when `DEV_CHEATS=true` |
| `ping` | `ts` | |
| `forfeit` | — | |

### Server → Client

| Type | Fields |
|---|---|
| `welcome` | `playerId`, `serverVersion` |
| `queued` | `position` |
| `match_found` | `matchId`, `matchField`, `playerIndex`, `opponentName`, `scheme`, `windowTicks`, `enforcement`, `spawns[2]`, `initialCommit`, `prevSnapshot[4]` |
| `countdown` | `secondsLeft` |
| `start` | `roundNo`, `startTick: 0`, `serverTime` — sent at the start of every round (after the countdown for round 1, after `ROUND_PAUSE_TICKS` for later rounds) |
| `state` | `roundNo`, `phase: 'live' \| 'pause'`, `tick` (round-relative), `players: [{x,y,angle,fired,hp}, {…}]`, `hits: [{shooter, target, tick}]` |
| `round_end` | `roundNo`, `endTick` (last tick of the round, round-relative), `winnerIndex`, `score: [a,b]`, `pauseTicks` (= `ROUND_PAUSE_TICKS`), `initialCommit` (fresh public commitment for the new round), `prevSnapshot[4]` (receiving player's spawn, `fired = 0`, seed for the new round's first window) |
| `proof_result` | `playerIndex`, `roundNo`, `windowIndex`, `status`, `verifyMs` |
| `resume` | `roundNo`, `nextWindowIndex`, `chainStatus: 'intact' \| 'broken'` — sent after a reconnecting `hello`, followed by a `state` |
| `cheat_flag` | `playerIndex`, `cheat`, `enabled` (broadcast so both see the `CHEAT` tag) |
| `opponent_status` | `status: 'connected' \| 'reconnecting' \| 'stalled'` |
| `match_end` | `winnerIndex`, `reason` (`rounds` \| `forfeit_proof` \| `forfeit` \| `disconnect` \| `abort`), `score`, `resultsUrl` |
| `pong` | `ts`, `serverTime` |
| `error` | `code`, `message` — `code` ∈ `INVALID_BODY`, `INVALID_ROOM_CODE`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ALREADY_IN_MATCH`, `UNAUTHORIZED`, `FORBIDDEN`, `VERSION_MISMATCH`, `RATE_LIMITED`, `INTERNAL` |

### Close codes
| Code | Meaning |
|---|---|
| 4400 | Too many invalid messages |
| 4401 | Missing/invalid auth |
| 4409 | Same player connected elsewhere (older socket closed) |
| 4429 | Rate limited |
| 4500 | Server error |

### Rate limits (per connection)
- `input_snapshot`: ≤ 70/s (60 + jitter)
- `window_proof` + `proof_failed` (combined): ≤ 4/s, max payload 64 KB (PLONK proofs are larger than Groth16)
- all other types: ≤ 10/s

## 5. Proof verification contract

For player p, window k of round r, the server sets exactly one status:
0. `chain_broken` — an earlier window of round r for p already has a non-`valid` status. Assigned as soon as window k has ended; any proof for it is ignored.
1. `malformed` — schema/field-element parse fails, or `scheme` ≠ match scheme.
2. `mismatch_bind` — `publicSignals.bind` ≠ `Poseidon(matchField, p, roundNo, k)` for the current round.
3. `mismatch_digest` — `publicSignals.digest` ≠ the stored server digest for p, window k (finalised at window end).
4. `mismatch_commit` — `publicSignals.commitIn` ≠ stored `commitOut` for p, window k−1 (or round's `initialCommit` for the first window of a round).
5. `invalid` — `snarkjs.<scheme>.verify(vkey, publicSignals, proof)` returns false (or the 2 s verify timeout fires).
6. `valid` — otherwise; store `commitOut_k`.
7. `unprovable` — the client sent `proof_failed` for window k (recorded immediately).
8. `timeout` — no proof or `proof_failed` received before end of window `k + PROOF_GRACE_WINDOWS`.

Checks 2–4 run before 5 (cheap first). Results are decided **in window order**: a proof for window k that arrives before window k−1 is decided is held until it is. The first non-`valid` result in a round breaks the commitment chain for the rest of that round (no rewinds); the chain restarts each round from the public `initialCommit`. In `strict` mode any non-`valid` result ends the match with `end_reason = 'forfeit_proof'`. Messages for an already-decided window, or for windows starting after the round's `endTick`, are dropped.

**Window boundaries and rounds:** ticks and windows are counted from tick 0 of each round. The window containing `endTick` is truncated to `endTick` and padded up to N ticks by repeating the snapshot at `endTick` with `fired=0` (client and server pad identically; the client re-derives its hidden state over the padding with `fired=0, reloadPress=0`). The client starts proving window k only once it has received the server's `state` for the window's last tick in the same round, or a `round_end` whose `endTick` lies in window k — so it never proves ticks the server later discards.

**Reconnect:** windows that fall inside a disconnect gap end up `timeout`, so the chain is broken for the rest of that round (`resume.chainStatus = 'broken'`); the client resumes valid proving at the next round.
