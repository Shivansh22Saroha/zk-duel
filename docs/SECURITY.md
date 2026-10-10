# SECURITY — ZK-Duel

ZK-Duel is a research prototype run on localhost or a LAN for demos and benchmarks. This document covers ordinary web security (auth, validation, transport) **and** the ZK-specific risks, which are the interesting part.

## 1. Security goals

| ID | Goal |
|---|---|
| S1 | A player cannot gain an advantage that violates the movement, aim or weapon rules without their proofs failing |
| S2 | Hidden state (ammo, cooldown, reload timer, salts, raw input samples) never leaves the client in plaintext |
| S3 | A valid proof cannot be replayed into another window, round, match or player slot |
| S4 | A client cannot crash or stall the server or the other player's session |
| S5 | Benchmark data is labelled with its provenance and cannot be confused with verified match data |

## 2. Authentication & sessions

- Guest-only: display name → JWT (HS256), 24 h expiry, `jti` stored in `sessions` so tokens can be revoked.
- `JWT_SECRET` ≥ 32 random bytes from env; server refuses to boot with the dev default when `NODE_ENV=production`.
- Token sent in the `Authorization` header (REST) and in the first `hello` frame (WS). **Never** in URL query strings.
- One live socket per player; a new `hello` closes the older socket (`4409`).
- Logout revokes the `jti`.

## 3. Authorization

| Resource | Rule |
|---|---|
| Match details / windows / log | Participants only, unless `PUBLIC_MATCHES=true` |
| `cheat_toggle` | Rejected unless server `DEV_CHEATS=true`; the client cheat panel is excluded from the bundle unless `VITE_DEV_CHEATS=true` |
| `POST /api/bench/runs` | Requires `X-Bench-Token` equal to `BENCH_TOKEN` |
| `window_proof` / `input_snapshot` | Only for the socket's own `playerIndex` in its own active match |

## 4. Input validation

- Every REST body and WS message validated with **zod** schemas from `shared/protocol.ts`; unknown fields stripped.
- Snapshots: `x`, `y`, `angle`, `fired`, `tick` must be integers (wrong types / non-integers → rejected as malformed). `tick` must be round-relative and monotonic, at most `STALL_TICKS` ahead of the server's wall-clock tick, and at most `PROOF_GRACE_WINDOWS × WINDOW_TICKS` behind it (late honest snapshots at high RTT are accepted); outside that range → rejected + strike. Integer values outside the legal ranges (`x ∈ [0, ARENA_W]`, `y ∈ [0, ARENA_H]`, `angle ∈ [0, 3599]`, `fired ∈ {0,1}`) are **accepted into the digest as sent** and counted as a strike — the digest reflects what was actually sent, so the proof fails on the bounds constraints. Hit detection clamps such values to the legal range before ray-casting. All integers are bounded to a safe range (|v| < 2^31) by the schema so field encoding is unambiguous.
- Field elements: decimal strings, `/^[0-9]{1,78}$/`, parsed with `BigInt`. Public signals, commitments, digests, salts and PLONK evaluations must be `< p` (BN254 scalar field). Proof curve-point coordinates (`pi_a`, `pi_b`, `pi_c`, PLONK commitments) are base-field elements and must be `< q` (BN254 base field, slightly larger than p) — checking them against p would wrongly reject valid proofs.
- Proof objects: exact shape for the scheme (Groth16: `pi_a[3]`, `pi_b[3][2]`, `pi_c[3]`, `protocol`, `curve`); payload ≤ 64 KB.
- Display names: `^[A-Za-z0-9_]{3,16}$`. Rendered as text, never as HTML.
- Room codes: `^[A-HJ-NP-Z2-9]{6}$` (no ambiguous characters).

## 5. Transport & web hardening

- Production: HTTPS + WSS only (TLS terminated at Caddy, see DEPLOYMENT.md). HSTS enabled.
- WS `Origin` header must match `ALLOWED_ORIGINS`; otherwise reject the upgrade.
- CORS: allow only `ALLOWED_ORIGINS`.
- Headers via `@fastify/helmet`: CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com`. (`wasm-unsafe-eval` is required for the circuit WASM.)
- Rate limits: REST via `@fastify/rate-limit`; WS limits per API_SPEC.md §4.
- Message size cap: `maxPayload: 65536` on the ws server.
- No secrets in the client bundle. Only `VITE_*` variables are exposed, and none are secret.

## 6. Denial-of-service controls

| Vector | Control |
|---|---|
| Proof flooding | ≤ 4 `window_proof` + `proof_failed` + `window_commit` per second; proofs are accepted only for the outstanding challenge or (after the match) for still-`committed` windows of that match — anything else is dropped before verification; one in-flight verify per window |
| Expensive verify | Verification runs in a `worker_threads` pool with a 2 s timeout; timeout = `invalid` |
| Snapshot spam | ≤ 70/s; excess dropped and counted as strikes |
| Slow client | Snapshot gap > 6 ticks → `stalled`; 10 s → forfeit |
| Memory | Only the current window's snapshots are kept per player; past windows keep just their digest and last snapshot |
| Malformed frames | 5 strikes → close `4400` |

## 7. ZK-specific threat model

### 7.1 What the proof guarantees
For each window, the prover knew private values such that: the public snapshots hash to `digest`; movement, aim and weapon rules held for every tick; the hidden state chains from `commitIn` to `commitOut`; and the proof is tied to this match, player and window (`bind`).

### 7.2 Attacks and mitigations

| # | Attack | Mitigation | Status |
|---|---|---|---|
| A1 | Send snapshots that differ from what was proven | Server computes `digest` from snapshots it actually received; mismatch → `mismatch_digest` | Mitigated |
| A2 | Replay an old valid proof | `bind = Poseidon(matchField, playerIndex, roundNo, windowIndex)` is a public input checked by the server | Mitigated |
| A3 | Reset ammo by starting a window from a fake hidden state, or by resuming from an older (fuller) commitment | Every window's `commitOut` is **claimed** in `window_commit` when the window ends and is immutable afterwards. A proof for window k must open the claimed `commitOut_{k−1}` (the round's public `initialCommit` for k = 0) and produce the claimed `commitOut_k`; a mismatch is `mismatch_commit`. A fake state at a boundary therefore makes the boundary window unprovable — it fails when challenged or audited. A missing commit breaks the chain for the rest of the round (`chain_broken`); the chain restarts at the next round's `initialCommit` | Mitigated (live: probabilistic; audit: complete) |
| A4 | Learn opponent's ammo from commitments | Commitments include a fresh random 248-bit salt per window (Poseidon hiding) | Mitigated |
| A5 | Field overflow (e.g. negative Δx wrapping to a huge field element) | Every comparator input is range-checked with `Num2Bits` to a fixed bit width before `LessThan` | Must be tested (TESTING.md §3) |
| A6 | Under-constrained circuit (a signal assigned with `<--` but never constrained) | Use `<==` everywhere except witness helpers (`turnD`, `k`), each of which gets explicit constraints; run circomspect; negative tests per rule | Must be tested |
| A7 | Withhold proofs / commits when cheating | Challenged window not proven by `PROOF_DEADLINE_MS` → `timeout`; commit not sent → `missing_commit`; audit proof not sent → `unaudited` → `audit_incomplete`. None of these can end `audited_clean`; `strict` mode forfeits on a live failure. (`proof_failed` → `unprovable` is only a courtesy signal from honest clients; the guarantee is that silence never looks clean) | Mitigated (detectable, not preventable) |
| A8 | Forge a Groth16 proof using setup toxic waste | Phase 1 uses the public Hermez Powers-of-Tau ceremony; phase 2 is a **single local contribution** — acceptable for a prototype but means whoever ran the setup could forge proofs. Production would need a multi-party phase 2. PLONK variant uses only the universal ptau, no circuit-specific toxic waste | Documented limitation |
| A9 | Tamper with the proving artefacts served to the client | Server publishes `zkeySha256`; client checks hash before `ready`; vkey lives only on the server | Mitigated |
| A10 | Smooth aimbot that stays under `MAX_TURN` | **Not detectable by this circuit.** The proof shows the rules were obeyed, not that a human produced the inputs | Accepted limitation — core seminar finding |
| A11 | Wallhack (seeing the opponent through walls) | Out of scope in v1: opponent positions are public snapshots anyway; no walls in circuit v1 | Out of scope |
| A12 | Lie about `proveMs` | Client-reported, informational only; never used for enforcement or published as verified data | Accepted |
| A13 | Desync between JS sim and circuit (honest player fails proofs) | Shared `sim.ts` + test vectors run through both JS rules and the circuit in CI | Must be tested |
| A15 | Predict which window will be challenged, and cheat only in the others | Challenges are drawn with `crypto.randomInt` on the server, uniformly among *all* of the player's ended, still-committed windows of the round, only after their commitments are fixed. Residual predictability: (a) at a round's start the first window can be the only candidate, so it is certain to be challenged; (b) a window that ends late in a round faces fewer draws than an early one, so late windows are less likely to be checked live. Both only shift *live* detection probability — the audit checks every window regardless | Accepted; measured (challenge rate r per match) |
| A16 | Launder a cheating window by disconnecting during it | A disconnect makes the rest of the round `chain_broken`, which is not a failure — but the match can then only reach `audit_incomplete`, never `audited_clean`, and the disconnect is logged | Accepted limitation |
| A17 | Leave before the audit finishes (close the tab) | Remaining windows become `unaudited` → `audit_incomplete`. A result is only ever reported as clean when every window of both players was proven | Accepted (visible) |
| A14 | Infer the opponent's hidden ammo from public data | **Partially possible.** `fired` is public every tick, so shot counts are public and ammo is roughly inferable (`MAG_SIZE` − shots since the last reload). Cooldown is likewise inferable from the last public shot. What stays truly hidden is reload timing (when R was pressed / whether a reload is in progress, hence the exact ammo after a manual reload) and the salts | Accepted limitation — hidden state is *partially inferable* |

### 7.3 Spot-checks and the post-match audit (Phase 3 design change)
Proving every window live is slower than real time (browser: ≈ 1.6× at N = 60, ≈ 2.0× at N = 30 on the dev laptop — CHANGELOG Phase 3), so live play is protected by unpredictable spot-checks and the match by a full audit afterwards.

- **Why challenges must be unpredictable.** A cheater who knew which window would be checked would simply play honestly in that one and cheat in the rest. Challenges are drawn on the server with `crypto.randomInt` (never `Math.random`), uniformly among the player's ended windows that are still unproven, and only *after* those windows' commitments are stored — the client must commit to window k before it can learn whether k will be checked. One outstanding challenge per player keeps the proving load bounded.
- **Why committing every window prevents rewriting history.** Without commitments, a cheater could prove only the challenged window, starting from whatever hidden state it likes (e.g. a full magazine). With a commitment per window, fixed when the window ends, window k's proof must start at the claimed `commitOut_{k−1}` and end at the claimed `commitOut_k`. Any "rewrite" (a refilled magazine, a skipped reload) must happen *inside* some committed window, which then has no valid proof. `circuits/test/ammoSafety.test.ts` shows the flip side: a window whose `commitIn` is only claimed can start from any state, so only proving the whole chain (the audit) bounds the hidden state for every window.
- **Live detection probability.** If a cheat makes m windows unprovable and each window is challenged during play with probability r (the measured challenge rate), the chance that at least one of them is challenged live is `1 − (1 − r)^m`. This treats challenges as independent per window; the real scheme (one outstanding challenge, uniform over the round's unproven windows) only approximates that — see A15 — so the achieved r and the detection latency are measured per match, not assumed.
- **The audit is the full guarantee.** After `match_end` the client proves every remaining committed window. Only a match in which every window of both players verified is `audited_clean`; any failure is `audited_failed` (and `overturned` if the winner failed); anything missing is `audit_incomplete`. Live spot-checks give early detection and `strict`-mode forfeits; the audit gives certainty.

### 7.4 Honest framing for the report
ZK-Duel demonstrates **verifiable rule compliance over committed hidden state**. The hidden state is only *partially* hidden (A14): the commitments never reveal it, but the public shot stream lets an observer estimate ammo. It is not anti-cheat in the industry sense: it does not stop memory reading, input automation or information leaks outside the proven rules. The hybrid recommendation (Objective 4) is: ZKPs for auditable rule claims; existing server-side and behavioural detection for input provenance.

## 8. Secrets management

| Secret | Where |
|---|---|
| `JWT_SECRET` | `server/.env`, never committed; Docker secret in production |
| `BENCH_TOKEN` | `server/.env` |
| Phase-2 contribution entropy | Generated during `circuits:build`, discarded after; never stored |

`.env*` and `circuits/build/**/*_0000.zkey` (intermediate zkeys) are in `.gitignore`.

## 9. Dependency & supply-chain hygiene

- `npm ci` with a committed `package-lock.json`.
- `npm audit --omit=dev` in CI; high/critical blocks merge.
- Pin circom by version, and record the ptau file's published hash and `zkeySha256` in `circuits/build/*/info.json`.
- Download ptau over HTTPS and verify its checksum before use.

## 10. Logging & privacy

- Logs (pino, JSON): connection events, match lifecycle, proof results, rate-limit hits. Never log tokens, proofs (unless `STORE_PROOFS`), or full snapshot streams (unless `LOG_SNAPSHOTS`).
- IP addresses are not persisted to the database.
- Data stored: guest names, match results, proof outcomes, benchmark timings. No email, no passwords, no personal data.
