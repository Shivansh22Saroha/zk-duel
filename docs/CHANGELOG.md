# CHANGELOG — ZK-Duel

All notable changes are recorded here. Format based on *Keep a Changelog*; versions follow SemVer. Circuit releases are tagged separately (`circuits-vX.Y.Z`) because any circuit change invalidates old proofs and benchmark comparability.

Every entry that changes the circuit must state: new constraint count per variant, and whether `publicSignalOrder` changed.

---

## [Unreleased]

### Planned (see TODO.md)
- Phase 1: playable game without ZK.

### Phase 0 — Repo setup — 2026-10-09
#### Added
- npm workspaces `shared`, `client`, `server`, `circuits`, `bench`; ESM; `.npmrc` with `save-exact` + `engine-strict`; `.node-version` = 22.
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) via `tsconfig.base.json`; ESLint 9 flat config + typescript-eslint `strict`; Prettier 3 (LF line endings, `.gitattributes` forces LF).
- `shared/constants.ts`: every PRD §5 constant plus the six added ones, protocol limits (rate limits, strikes, timeouts, name/room-code rules) and the aggregated `CONSTANTS` object that `/api/circuit/info` returns.
- `shared/canonical.ts`: canonical JSON + `constantsHash` (WebCrypto SHA-256, identical in Node and browsers).
- `shared/field.ts`: BN254 scalar modulus p **and base-field modulus q**. Proof curve coordinates are F_q elements, slightly larger than p, so they are range-checked against q; public signals and PLONK evaluations against p. (SECURITY §4 said "< p" for all field elements; applying that to proof coordinates would wrongly reject valid proofs.)
- `shared/protocol.ts`: zod schemas for every WS message (both directions, incl. `proof_failed`, `resume`), Groth16 + PLONK proof shapes (`.strict()`), REST bodies (guest auth, rooms, bench upload), error formats. `window_proof` has a separate header schema so a malformed body can still be attributed to a window (→ `malformed`).
- `circuits/build.config.json`: variants + Hermez ptau table (powers 8–20; URLs and blake2b-512 hashes generated from the snarkjs README, not retyped).
- `circuits/scripts/ptau.ts` (`npm run circuits:ptau -- --power N`): download, verify blake2b against the README, record SHA-256. `circuits/scripts/check-tools.ts` (`npm run circuits:check`).
- `.github/workflows/ci.yml` skeleton: toolchain check, lint, format, typecheck, unit + circuit tests, integration tests, circomspect (once `window.circom` exists), `npm audit --omit=dev --audit-level=high`.
- Tests: 76 unit tests (constants, canonical JSON/hash, field bounds, protocol accept/reject cases).

#### Security
- npm `overrides`: `ws` → 8.22.0 (circomlibjs → ethers pulled ws 8.18.0, high: GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p) and `underscore` → 1.13.8 (snarkjs → bfj → jsonpath pulled 1.13.6, high: GHSA-qpx9-hpmf-5gmw). Same majors.
- Remaining: 15 **low** advisories, all `elliptic` via circomlibjs → ethers 5 (unused at runtime by us; no fix available). `npm audit --omit=dev --audit-level=high` is clean.

#### Notes
- Version lines that moved past the docs' minimum: Vite 8 (docs: "6.x or later"), Vitest 5 (docs: "2.x+"). zod kept on 3.x, ESLint on 9.x, pino 9.x, dotenv 16.x, TypeScript 5.x as TECH_STACK specifies, although newer majors exist.
- Ptau power 16 downloaded and verified for now; the final per-variant power is chosen from real constraint counts in Phase 2/5.
- CI workflow has not run yet — there is no remote. It is syntax-only until pushed.

### Spec fixes (pre-Phase 0) — 2026-10-09
Decided by the owner after the Step 2 doc review. Each item lists the docs changed.
1. **Snapshot buffer → per-window digests.** Server finalises and stores each window's digest at window end, keeps only digests + the last snapshot (next window's seed). Timeout/unprovable/chain_broken rows use the stored digest. The digest uses the snapshot actually sent for each tick; a window finalises when its last tick's snapshot arrives or the player stalls. *(ARCHITECTURE §4/§6, FEATURES F6, SECURITY §6, DATABASE §2/§4, TESTING §2)*
2. **Round end.** `round_end` gains `endTick`; client truncates its last window to `endTick` and pads exactly like the server (last snapshot, `fired=0`; hidden state rolled forward with `fired=0, reloadPress=0`). The client starts proving window k only after the server's `state` for its last tick (or a `round_end` inside it) arrives, so it never proves ticks the server discards. *(ARCHITECTURE §4, API §4/§5, FEATURES F8/F9, USER_FLOWS 3)*
3. **Commit chain: no rewinds.** First non-valid window in a round → later windows of that round get new status `chain_broken`; chain resets every round from the public `initialCommit`. Results are decided in window order. *(ARCHITECTURE §4, API §5, SECURITY A3, FEATURES F10, DATABASE, TESTING §2/§4)*
4. **`proof_failed` message → `unprovable` status.** Honest client reports witness failure; server records `unprovable` immediately. `timeout` remains the real guarantee. PRD FR-20 reworded. *(PRD, API §4/§5, FEATURES F9/F13, USER_FLOWS 3/4, SECURITY A7, DATABASE `fail_reason`)*
5. **Weapon transition table W1–W5** written into ARCHITECTURE §3: firing sets `cooldown' = FIRE_COOLDOWN − 1` (next shot exactly 12 ticks later, 5 shots/s); fire beats a same-tick reload press; presses during a reload are ignored; cooldown range is now `0..FIRE_COOLDOWN−1`. *(ARCHITECTURE §3/§5.3, FEATURES F5, TESTING §2)*
6. **Round start.** Every round's `prev` snapshot = the player's spawn with `fired=0`; `prevSnapshot` is now in `round_end` as well as `match_found`. *(ARCHITECTURE §3/§5.4, API §4)*
7. **Ticks are round-relative** in protocol and sim; DB `rounds.start_tick/end_tick` and `matches.total_ticks` are match-absolute (server-computed). `start` and `state` gain `roundNo`; `state` gains `phase`; `round_end.nextRoundTick` replaced by `pauseTicks`. *(ARCHITECTURE §3, API §4, DATABASE, FEATURES F5/F8)*
8. **DB:** `window_ticks` CHECK now `IN (4,30,60,120)` (test variant). *(DATABASE)*
9. **Removed the "switch to N=120" fallback**: a slow prover is reported as a finding with the real prove/play ratio (near-real-time / post-match audit framing). *(PRD §9, TODO risks)*
10. **Ptau power per variant** from the real constraint count (PLONK needs more than R1CS count); smallest Hermez file that fits; recorded in `info.json` (`ptauPower`, `ptauFile`, `ptauSha256`). *(ARCHITECTURE §5.5, TECH_STACK §5, ENVIRONMENT §3, TODO)*
11. **Out-of-range snapshots:** integers are accepted into the digest as sent and counted as a strike (proof then fails on bounds); only wrong types are rejected. Added: hit detection clamps such values before ray-casting; schema bounds integers to |v| < 2^31. *(SECURITY §4, API §4, ARCHITECTURE §6, FEATURES F6, TESTING §2)*
12. **Movement:** per-axis step of exactly `MAX_SPEED`; diagonal ≈ 5.66 accepted. PRD FR-7 reworded. *(PRD, FEATURES F5)*
13. **Protocol:** creator also sends `room_join`; rematch dropped; match history moved to P1 after Phase 4; new server message `resume{roundNo, nextWindowIndex, chainStatus}`; `constantsHash` = SHA-256 of canonical JSON of all constants; `queue_join` has no enforcement; WS error codes enumerated incl. `FORBIDDEN`, `VERSION_MISMATCH`; `/api/circuit/info` returns every constant + `constantsHash`. *(API, FEATURES F2/F3/F16/F17, USER_FLOWS 2/5/6/8, UI_UX §3.4, TODO)*
14. **`matchField`** = first 31 bytes of SHA-256(matchId UUID string) as big-endian integer (< p). *(ARCHITECTURE §5.2, DATABASE)*
15. **PRD FR-16** now lists the full status set (incl. `unprovable`, `chain_broken`); UI symbols: ✕ for all failures, – timeout, ⛓ chain_broken. *(PRD, UI_UX §2/§3.4, FEATURES F12)*
16. **README stays in the root**, with Windows cmd commands and `docs/` links; the other 14 specs live in `docs/`. *(README, DEPLOYMENT §2, ENVIRONMENT secret generation)*
17. **Phase 1 exit check:** automated bot-driven matches over real sockets + owner's manual playtest. *(TODO)*
18. **New limitation A14 — partially inferable hidden state** (public shot counts reveal approximate ammo/cooldown; reload timing and salts stay hidden). *(SECURITY §7)*
19. **Frame time vs snarkjs threads:** measure while proving; cap threads if needed and report the setting. *(TODO risks)*
20. **Constants added to PRD §5** (to live in `shared/constants.ts`): `SPAWNS`, `RAY_LENGTH` 1200, `TRIG_SCALE` 1024, `ROUND_PAUSE_TICKS` 90, `STALL_TICKS` 6, `RECONNECT_TIMEOUT_MS` 10000. *(PRD §5)*

---

## [0.0.1] — 2026-10-09 — Specification

### Added
- Project specification set: README, PRD, ARCHITECTURE, UI_UX_SPEC, DATABASE_SCHEMA, API_SPEC, SECURITY, TECH_STACK, USER_FLOWS, FEATURES, ENVIRONMENT, TESTING, DEPLOYMENT, CHANGELOG, TODO.
- Game rule constants fixed (`TICK_RATE` 60, `MAX_SPEED` 4, `MAX_TURN` 150, `MAG_SIZE` 10, `FIRE_COOLDOWN` 12, `RELOAD_TICKS` 90).
- Circuit design: per-window proof with public inputs `bind`, `digest`, `commitIn` and public output `commitOut`.
- Decision: Groth16 primary, PLONK for comparison; window sizes 30/60/120 for benchmarks.
- Decision: server-authoritative hits; client-proven movement, aim and hidden weapon state.

### Context
- Builds on the mid-term seminar work (literature review of 26 sources, four research gaps, four objectives) for *Zero-Knowledge Proofs for Verifiable Fair-Play in Competitive Gaming and Esports*.

---

## Entry template

```
## [x.y.z] — YYYY-MM-DD

### Added
### Changed
### Fixed
### Circuit
- Variant groth16_60: constraints 51,234 → 49,880; publicSignalOrder unchanged
### Benchmarks
- Run <id> on <device>: groth16_60 prove p50 612 ms, p95 740 ms
```

## Exact dependency versions (pinned 2026-10-09, Phase 0)

| Package | Pinned version |
|---|---|
| node | 22.23.3 (npm 10.9.9, via fnm 1.39.0) |
| circom | 2.2.3 (built from tag `v2.2.3`, rustc 1.99.0 MSVC) |
| circomspect | 0.9.0 |
| snarkjs | 0.7.6 |
| circomlib | 2.0.5 |
| circomlibjs | 0.1.7 |
| circom_tester | 0.0.24 |
| vite | 8.3.4 |
| fastify | 5.12.5 (`@fastify/helmet` 13.1.2, `/cors` 11.3.1, `/rate-limit` 11.2.1, `/static` 10.1.5) |
| ws | 8.22.0 (also forced via `overrides`) |
| better-sqlite3 | 13.0.3 (bundled SQLite 3.53.4) |
| zod | 3.25.76 |
| jsonwebtoken / pino / dotenv | 9.0.3 / 9.14.0 / 16.6.1 |
| chart.js | 4.5.1 |
| typescript / tsx | 5.9.3 / 4.23.15 |
| eslint / typescript-eslint / prettier | 9.39.5 / 8.71.1 / 3.9.9 |
| vitest / @vitest/coverage-v8 / fast-check | 5.0.3 / 5.0.3 / 4.10.2 |
| @playwright/test | 1.64.0 (browsers not yet installed) |
| ptau file + sha256 | `powersOfTau28_hez_final_16.ptau` (75,580,568 B) — blake2b-512 `6a6277a2…efec125` (matches snarkjs README), sha256 `1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922` |
