# CHANGELOG — ZK-Duel

All notable changes are recorded here. Format based on *Keep a Changelog*; versions follow SemVer. Circuit releases are tagged separately (`circuits-vX.Y.Z`) because any circuit change invalidates old proofs and benchmark comparability.

Every entry that changes the circuit must state: new constraint count per variant, and whether `publicSignalOrder` changed.

---

## [Unreleased]

### Planned (see TODO.md)
- Phase 1: playable game without ZK.

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

## Exact dependency versions (fill at setup)

| Package | Pinned version |
|---|---|
| node | |
| circom | |
| snarkjs | |
| circomlib | |
| circomlibjs | |
| vite | |
| fastify | |
| ws | |
| better-sqlite3 | |
| ptau file + sha256 | |
