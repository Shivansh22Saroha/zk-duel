# CHANGELOG — ZK-Duel

All notable changes are recorded here. Format based on *Keep a Changelog*; versions follow SemVer. Circuit releases are tagged separately (`circuits-vX.Y.Z`) because any circuit change invalidates old proofs and benchmark comparability.

Every entry that changes the circuit must state: new constraint count per variant, and whether `publicSignalOrder` changed.

---

## [Unreleased]

### Planned (see TODO.md)
- Phase 1: playable game without ZK.

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
