# TESTING — ZK-Duel

The riskiest code is the circuit: a missing constraint silently accepts cheats, and an over-strict one rejects honest players. Circuit and sim/circuit agreement tests get the most attention.

Commands:
```bash
npm test               # unit + circuit tests (Vitest)
npm run test:circuits  # circuit tests only
npm run test:int       # server integration tests (real ws, in-memory SQLite)
npm run test:e2e       # Playwright two-player match
npm run lint && npm run typecheck
```

## 1. Coverage targets

| Area | Target |
|---|---|
| `shared/sim.ts`, `shared/protocol.ts` | ≥ 95% lines |
| `server/src/zk/*`, `server/src/match/*` | ≥ 85% |
| Client game logic (`client/src/game/*` excluding renderer) | ≥ 80% |
| Circuit | Every constraint family has ≥ 1 positive and ≥ 1 negative test |

## 2. Unit tests (Vitest)

**shared/sim.ts**
- Movement clamp at all four arena edges; speed clamp per axis.
- `turnDelta` wraps correctly: 3590→10 = 20, 10→3590 = 20, 0→1800 = 1800.
- Weapon transitions: every row W1–W5 of ARCHITECTURE §3; fire with ammo, fire at 0 ammo (blocked), cooldown decrement, next shot exactly 12 ticks after a shot (not 11, not 13), reload start/finish (ammo = MAG_SIZE exactly 90 ticks after the press), reload blocked while full, fire blocked while reloading, fire + reload press on the same tick (fire wins), reload press during a reload (ignored).
- Determinism: same input log → same per-tick state hash, 1000 runs.
- Round-end truncate + pad helper (shared by client and server).
- `matchField` derivation and `constantsHash` canonical JSON are stable.

**shared/protocol.ts**
- Each message schema accepts a valid example and rejects: missing fields, floats where ints are required, field elements ≥ p, oversized strings, out-of-range values for non-snapshot fields. `input_snapshot` with integer but out-of-range values is accepted by the schema (flagged as a strike by the server).

**server**
- Ray-circle hit: dead-center, tangent, just-miss, behind shooter, angle 0/900/1800/2700/3599.
- Simultaneous lethal hits tie rule.
- `DigestBuilder` output equals the JS reference Poseidon chain and the circuit's `digest` for the same window (cross-check with circom_tester).
- Snapshot gap fill (≤ `STALL_TICKS`) and stall detection; late snapshot replaces the held value in the digest.
- Digest finalised at window end; only digests + last snapshot retained.
- Timeout sweep marks exactly window k at end of window k+2.
- Results decided in window order; first non-valid → later windows in the round `chain_broken`; chain resets next round.
- JWT issue/verify/revoke; expired token rejected.

**client**
- WindowRecorder produces circuit inputs whose field names and lengths match the circuit.
- Partial-window padding matches the server's padding.
- Salt generation always < p.

## 3. Circuit tests (`circuits/test/`, circom_tester)

Compile `main_<N>.circom` with small N (e.g. N=4) for fast tests, plus one full N=60 smoke test.

| Test | Expectation |
|---|---|
| Honest window from recorded log | Witness computes; `digest`, `commitOut` match JS |
| Δx = MAX_SPEED + 1 on one tick | Witness fails |
| Δx = −(MAX_SPEED + 1) | Witness fails (**field-wrap check**) |
| x = R − 1 or x = W − R + 1 | Fails |
| Turn = MAX_TURN + 1 across the 3599→0 boundary | Fails |
| Turn = MAX_TURN exactly, both directions | Passes |
| Fire with ammo 0 | Fails |
| Fire with cooldown 1 | Fails |
| Fire while reloadTimer > 0 | Fails |
| Ammo not decremented after fire | Fails |
| Reload completes → ammo = MAG_SIZE | Passes; any other ammo fails |
| `fired = 2` or `reloadPress = 2` | Fails (boolean constraint) |
| `commitIn` wrong hidden state | Fails |
| Digest computed with one altered public snapshot | Output digest differs from server digest |
| Malicious witness for helper signals (`turnD`, `k`) set inconsistently | Fails (proves helpers are constrained) |

**Property tests (fast-check, N=4):**
- Random *legal* input sequences → always satisfiable.
- Random legal sequence with one randomly mutated field → the circuit is satisfiable **iff** `shared/sim.ts` `checkSequence` accepts it (exact agreement); an accepted mutation must change the digest or commitment, **except** a `reloadPress` the rules ignore (W1 fire wins, reload already running, full magazine), which changes no state and is an equivalent witness, not a cheat. (Clarified in Phase 2 after fast-check found such a case.)

**Static analysis:** `circomspect circuits/window.circom` must report no under-constrained signal warnings (CI gate). Also assert `snarkjs r1cs info` constraint count is recorded and does not grow > 10% without a CHANGELOG note.

**Public signal order:** a test reads `info.json.publicSignalOrder` and checks the server maps `bind`, `digest`, `commitIn`, `commitOut` to the right indices by verifying one known proof.

## 4. Integration tests (server, real sockets)

Using two `ws` clients driven by scripted input logs and real proofs from the N=4 test circuit (build a `groth16_4` test variant for speed):

| Scenario | Expected |
|---|---|
| Clean match, 3 rounds | All windows `valid`; match ends `rounds` |
| Proof from window k sent as k+1 | `mismatch_bind` |
| Proof from another match | `mismatch_bind` |
| Snapshots altered after proving | `mismatch_digest` |
| Wrong `commitIn` | `mismatch_commit` |
| Corrupted `pi_a` | `invalid` |
| No proof sent | `timeout` at end of k+2 |
| `proof_failed` sent for window k | `unprovable` immediately; windows k+1… of the round `chain_broken` |
| Window k non-valid, valid-looking proof for k+1 | `chain_broken` (no rewind) |
| Next round after a broken chain | Chain restarts from `initialCommit`; windows `valid` |
| Round ends mid-window | Truncated + padded final window is `valid` |
| Integer out-of-range snapshot | Accepted into digest, strike counted, proof fails |
| Strict mode + invalid | `match_end` `forfeit_proof` within 1 tick |
| Frame inspector over the whole match | No `ammo`, `cooldown`, `reload`, `salt` keys in any client→server frame |
| 5 malformed messages | Socket closed `4400` |
| 200 snapshots in 1 s | Rate-limited, strikes counted |
| Reconnect within 10 s | Match resumes; `resume` sent with `chainStatus:'broken'`; gap windows `timeout`; rest of that round `chain_broken`; next round valid |
| `cheat_toggle` with `DEV_CHEATS=false` | Rejected `FORBIDDEN` |

## 5. End-to-end (Playwright)

- Two browser contexts, scripted keyboard/mouse via `page.keyboard`/`page.mouse`, `WINDOW_TICKS=30` variant.
- **E2E-1:** queue → match → play 20 s → strip shows ≥ 30 ✓ per player.
- **E2E-2:** private room with strict mode → enable speedhack in context A → match ends with forfeit banner within 3 windows (expected status `unprovable`, since the dev client reports `proof_failed`).
- **E2E-3:** smooth-aim enabled → strip stays ✓.
- **E2E-4:** results page numbers equal API values.
- **E2E-5:** performance trace while proving → frame time p95 < 20 ms (run on the baseline machine, not in CI).

## 6. Security tests

- Fuzz WS messages (random JSON, huge numbers, nested objects, 1 MB payloads) → server stays up; memory stable.
- Origin header not in `ALLOWED_ORIGINS` → upgrade rejected.
- Token in query string ignored.
- CSP headers present on all HTML responses.
- `npm audit --omit=dev` clean of high/critical.
- Modified zkey served → client refuses `ready`.
- Bench upload without `X-Bench-Token` → 401.

## 7. Performance tests

- Server: 10 concurrent simulated matches → tick processing p99 < 2 ms per match on the baseline machine.
- Verify latency: 1000 proofs → p95 < 50 ms.
- These are informative; the research benchmarks are in `bench/` (FEATURES F15), not in CI.

## 8. CI gates (GitHub Actions)

Blocking: lint, typecheck, unit, circuit tests (N=4), circomspect clean, integration tests, `npm audit` high/critical.
Non-blocking / manual: Playwright E2E (needs built circuits), full N=60/120 builds, benchmarks.

## 9. Manual demo checklist (before the viva)

- [ ] Two laptops on the same Wi-Fi play a full best-of-5 in strict mode, all ✓
- [ ] Speedhack, rapid-fire, infinite ammo, snap-aim each produce a non-valid result
- [ ] Smooth-aim stays ✓ and the explanation is ready
- [ ] Benchmark dashboard shows the latest run with the real-time reference lines
- [ ] Match log download opens and contains no hidden state
