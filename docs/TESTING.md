# TESTING — ZK-Duel

The riskiest code is the circuit: a missing constraint silently accepts cheats, and an over-strict one rejects honest players. Circuit and sim/circuit agreement tests get the most attention.

Commands:
```bash
npm test               # unit + circuit tests (Vitest)
npm run test:circuits  # circuit tests only
npm run test:int       # server integration tests (real ws, in-memory SQLite)
npm run test:e2e       # browser E2E: e2e:cheats, then e2e:audit-reload (needs npm run perf:serve)
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
- Commit deadline: no `window_commit` within one window after window k ended → `missing_commit`, later windows of the round `chain_broken`; chain resets next round.
- Challenges: at most one outstanding per player; drawn only from ended, digest-final, still-`committed` windows of the current round; deadline → `timeout`; draw distribution is uniform (chi-square over many draws, seeded only by `crypto.randomInt`).
- Verification against claimed commitments: wrong `commitIn` or `commitOut` → `mismatch_commit`; any window order.
- Audit close: remaining `committed` → `unaudited`; `audited_clean` / `audited_failed` / `audit_incomplete`; `overturned` only when the winner failed.
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

**Static analysis:** `npm run circuits:lint` (circomspect `--level WARNING` on the generated `main_4.circom` and `main_60.circom`) must report no findings (CI gate). Running circomspect directly on `circuits/window.circom` also prints a style note (`Window` takes many template parameters), which is not an under-constraint finding. Also assert `snarkjs r1cs info` constraint count is recorded and does not grow > 10% without a CHANGELOG note.

**Public signal order:** a test reads `info.json.publicSignalOrder` and checks the server maps `bind`, `digest`, `commitIn`, `commitOut` to the right indices by verifying one known proof.

## 4. Integration tests (server, real sockets)

Using two `ws` clients driven by scripted input logs and real proofs from the N=4 test circuit (build a `groth16_4` test variant for speed):

| Scenario | Expected |
|---|---|
| Clean match, 3 rounds | Every window committed, every challenge `valid`, audit → every window `valid`, `audited_clean` |
| Scripted cheater cheats in one window | That window fails (live challenge or audit); match never `audited_clean` |
| Commit missing | `missing_commit`; rest of the round `chain_broken` |
| Challenge not answered | `timeout` at `PROOF_DEADLINE_MS` |
| Proof for a window that is not challenged (during play) | Dropped |
| Proof from window k sent as k+1 | `mismatch_bind` |
| Proof from another match | `mismatch_bind` |
| Snapshots altered after proving | `mismatch_digest` |
| Wrong `commitIn` | `mismatch_commit` |
| Corrupted `pi_a` | `invalid` |
| `proof_failed` sent for a challenged window | `unprovable` immediately |
| Wrong claimed `commitOut` (proof ends elsewhere) | `mismatch_commit` |
| Next round after a broken chain | Chain restarts from `initialCommit`; windows `valid` |
| Round ends mid-window | Truncated + padded final window is `valid` |
| Integer out-of-range snapshot | Accepted into digest, strike counted, proof fails |
| Strict mode + invalid | `match_end` `forfeit_proof` within 1 tick |
| Frame inspector over the whole match (incl. audit) | No `ammo`, `cooldown`, `reload`, `salt` keys in any client→server frame; `window_commit` carries only `commitOut`, `window_proof` only proof + public signals |
| 5 malformed messages | Socket closed `4400` |
| 200 snapshots in 1 s | Rate-limited, strikes counted |
| Reconnect within 10 s | Match resumes; `resume` sent with `chainStatus:'broken'`, the held commits and the outstanding challenge; windows from the gap on `chain_broken`; next round valid |
| `cheat_toggle` with `DEV_CHEATS=false` | Rejected `FORBIDDEN` |
| `cheat_toggle` with `DEV_CHEATS=true` | `cheat_events` row (window index) + `cheat_flag` to both players |
| Private room: create (strict) → both `room_join` | Private match with the creator's enforcement; code used up afterwards (`ROOM_NOT_FOUND`); a second outsider gets `ROOM_FULL` |
| Winner closes the tab during the audit | `audit_incomplete`, result `unverified` (not overturned); loser `audited_clean` |

## 5. End-to-end (Playwright)

`npm run test:e2e` (with `npm run perf:serve` running in another terminal) runs `npm run e2e:cheats` (private rooms, E2E-2, E2E-3, browser frame inspector) and then `npm run e2e:audit-reload` (E2E-6). `npm run perf:match` (E2E-5) stays separate because it is long. These are Playwright scripts run with tsx, not `playwright test` specs.

- Two browser contexts, scripted keyboard/mouse via `page.keyboard`/`page.mouse`, `WINDOW_TICKS=30` variant.
- **E2E-1:** queue → match → play 20 s → every spot-check ✓, then the audit ends `audited_clean`.
- **E2E-2:** private room with strict mode → enable speedhack in context A → the match ends with a forfeit banner at the first challenged cheating window (`unprovable`), or the audit ends `audited_failed`.
- **E2E-3:** smooth-aim enabled → strip stays ✓.
- **E2E-4:** results page numbers equal API values.
- **E2E-5:** performance trace while proving → frame time p95 < 20 ms (run on the baseline machine, not in CI): `npm run perf:serve` + `npm run perf:match -- --acc 1800 --stop-after 180` (production `--mode perf` build, so source edits cannot reload the pages).
- **E2E-2 + E2E-3 + private rooms + browser frame inspector (Phase 4):** `npm run perf:serve` + `npm run e2e:cheats` (two Chrome windows; the room is created and joined through the UI).
- **Detection experiment (Phase 4):** `npm run exp:detect` (Node bots, full matrix) and `npm run perf:serve` + `npm run exp:browser` (one live browser run per cheat) → `detection_runs`, `bench/out/detection.csv`.
- **E2E-6 (Phase 3):** reload player 0's page mid-audit → the audit resumes from IndexedDB → `audited_clean`, no stored windows left: `npm run perf:serve` + `npm run e2e:audit-reload`.

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
- [ ] Frame inspector green (no hidden state in any WS frame); the downloadable dev tick log (`VITE_LOG_TICKS`) contains the player's own hidden state by design and never leaves the browser
- [ ] Works offline: `npm run offline:check` (bot match, results, /bench with all non-local traffic blocked) and `npm run demo:rehearse` (the docs/DEMO.md script, timed) both print only PASS — needs `npm run demo` running
