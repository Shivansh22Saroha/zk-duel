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
                 "PLAYER_RADIUS": 12 }
}
```
The client must compare `constants` with its own bundled `shared/constants.ts` and refuse to play on mismatch (`VERSION_MISMATCH` toast).

### `POST /api/rooms` 🔒
Creates a private room. Request `{ "enforcement": "strict" }` (optional, default `observe`).
Response `201 { "roomCode": "K7QX2M", "expiresAt": … }` (expires in 10 min if unused).

### `GET /api/matches?limit=20&before=<ms>` 🔒
Current player's recent matches.
```json
{ "matches": [ { "id": "uuid", "startedAt": 0, "endedAt": 0, "mode": "queue",
  "opponent": "rahul_7", "result": "win", "score": "3-1",
  "windows": { "valid": 112, "invalid": 0, "timeout": 1 } } ], "nextBefore": 0 }
```

### `GET /api/matches/:id` 🔒 (participants only, or any when `PUBLIC_MATCHES=true`)
Full match summary: players, rounds, per-player window stats (counts by status, mean/p95 prove ms, mean verify ms), cheat events, enforcement, scheme, window size.

### `GET /api/matches/:id/windows?player=0` 🔒
`{ "windows": [ { "roundNo": 1, "windowIndex": 0, "startTick": 0, "status": "valid", "proveMs": 410, "verifyMs": 5.8, "proofBytes": 805 } ] }`

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
| `hello` | `token`, `clientVersion`, `constantsHash` | Must be first |
| `queue_join` | `enforcement?` | Ignored if already in a match |
| `queue_leave` | — | |
| `room_join` | `roomCode` | |
| `ready` | `artefactSha256` | Sent after proving key loaded and hash checked |
| `input_snapshot` | `tick`, `x`, `y`, `angle`, `fired` | One per tick; ints only; out-of-order ticks dropped |
| `window_proof` | `roundNo`, `windowIndex`, `scheme`, `proof`, `publicSignals[4]`, `proveMs` | `publicSignals` order is read from `info.json.publicSignalOrder` (circom puts outputs first, then public inputs in template declaration order) — never hard-coded |
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
| `start` | `startTick: 0`, `serverTime` |
| `state` | `tick`, `players: [{x,y,angle,fired,hp}, {…}]`, `hits: [{shooter, target, tick}]` |
| `round_end` | `roundNo`, `winnerIndex`, `score: [a,b]`, `nextRoundTick`, `initialCommit` (fresh public commitment for the new round) |
| `proof_result` | `playerIndex`, `roundNo`, `windowIndex`, `status`, `verifyMs` |
| `cheat_flag` | `playerIndex`, `cheat`, `enabled` (broadcast so both see the `CHEAT` tag) |
| `opponent_status` | `status: 'connected' \| 'reconnecting' \| 'stalled'` |
| `match_end` | `winnerIndex`, `reason`, `score`, `resultsUrl` |
| `pong` | `ts`, `serverTime` |
| `error` | `code`, `message` |

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
- `window_proof`: ≤ 4/s, max payload 64 KB (PLONK proofs are larger than Groth16)
- all other types: ≤ 10/s

## 5. Proof verification contract

For `window_proof` from player p, window k, the server sets status:
1. `malformed` — schema/field-element parse fails, or `scheme` ≠ match scheme.
2. `mismatch_bind` — `publicSignals.bind` ≠ `Poseidon(matchField, p, roundNo, k)` for the current round.
3. `mismatch_digest` — `publicSignals.digest` ≠ server digest of its buffered snapshots for p, window k.
4. `mismatch_commit` — `publicSignals.commitIn` ≠ stored `commitOut` for p, window k−1 (or round's `initialCommit` for the first window of a round).
5. `invalid` — `snarkjs.<scheme>.verify(vkey, publicSignals, proof)` returns false.
6. `valid` — otherwise; store `commitOut_k`.
7. `timeout` — no proof received before end of window `k + PROOF_GRACE_WINDOWS`.

Checks 2–4 run before 5 (cheap first). In `strict` mode any non-`valid` result ends the match with `end_reason = 'forfeit_proof'`.

**Window boundaries and rounds:** windows are counted from tick 0 of each round. A partial final window at round end is padded by repeating the last snapshot with `fired=0` (both client and server pad identically) so every proof covers exactly N ticks.
