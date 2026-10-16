# CLAUDE.md — ZK-Duel

1v1 browser shooter with zk-SNARK rule-compliance proofs (CSC301 seminar). Specs live in `docs/` (15 files, incl. the v1.0.1 audit) plus the root `README.md`. Spec fixes agreed before Phase 0 are listed in `docs/CHANGELOG.md` → "Spec fixes (pre-Phase 0)" — e.g. weapon table W1–W5, round-relative ticks, `unprovable`/`chain_broken` statuses. **Read the relevant spec before touching an area**; `docs/PRD.md` is the scope authority, `docs/TODO.md` is the work order.

## Hard rules

1. **Constants come only from `shared/constants.ts`.** No magic numbers anywhere (client, server, tests, circuit). The circuit build script templates them into `circuits/main_<N>.circom`. Any constant not in PRD §5 that I need (spawns, ray length, sin/cos scale, round pause, stall ticks…) is added to `shared/constants.ts` and flagged in the phase report.
2. **Integer-only game state.** x, y, angle, ammo, cooldown, reloadTimer, hp, ticks are ints. No floats/trig in state or sim. Floats only in rendering/interpolation. Rays use the integer sin/cos table (scale 1024).
3. **Hidden state never leaves the client.** ammo, cooldown, reloadTimer, reloadPress, salts must never appear in any WS frame, REST body, DB row, or log. Only public snapshots `{tick,x,y,angle,fired}` and commitments go out. Keep the frame-inspector test green.
4. **Field elements are decimal strings** on the wire, never JS numbers. Validate `< p` (BN254) with BigInt.
5. **Rules live once in `shared/sim.ts`**; client sim, server sanity checks, test-vector generation and bench all use it. The circuit only *checks*, never clamps. Sim and circuit must agree (test vectors in CI).
6. **Build order (do not skip or reorder):** shared → playable game (no ZK) → circuit tested offline → live proving/verification → cheats + private rooms → benchmarks → polish. One phase at a time; **stop and wait for user approval between phases.**
7. **No features outside `docs/PRD.md`.** If a doc implies something PRD doesn't list, ask first.
8. **Tests before "done".** Run the tests TESTING.md lists for the phase; a phase is done only when its TODO.md *Exit check* passes. Never claim success without running it. Never fake results — report real numbers, failures, and slow benchmarks.
9. **Docs are wrong → say so and propose a fix.** Do not silently change the design. Record accepted deviations in CHANGELOG.md.
10. **Server is authoritative for hits/damage; client for movement, aim, hidden weapon state.** Server never trusts `proveMs`.
11. Circuit changes: record new constraint counts per variant and any `publicSignalOrder` change in CHANGELOG.md. Read signal order from `info.json.publicSignalOrder`, never hard-code indices.
12. Security: zod-validate every message; no tokens in URLs; no secrets in client bundle; `DEV_CHEATS` off by default outside dev; `.env*` and intermediate `*_0000.zkey` never committed.

## Per-phase routine

- Track every TODO.md item of the phase in the task list; tick `[x]` in `docs/TODO.md` as done.
- Write + run the phase's tests; add CHANGELOG entry (pinned versions in Phase 0; constraint counts when circuit changes).
- Commit at phase end (if git is set up) with a clear message.
- Report: what was built, test results, failures/deviations, exactly how the user can run/check it. Then STOP.

## Environment (Windows)

- Never rewrite UTF-8 files with Windows PowerShell 5.1 `Get-Content`/`Set-Content` (it mis-decodes them as ANSI); use the Edit tool or Node.
- Shell is PowerShell/cmd: no `cp`, `export`, `openssl`. Use `copy`, `$env:X=`, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Target Node 22 LTS, npm workspaces (`client server shared circuits bench`), TypeScript strict + `noUncheckedIndexedAccess`.
- Artefacts in `circuits/build/` are build outputs, not committed.
