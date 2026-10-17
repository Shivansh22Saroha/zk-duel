# CHANGELOG — ZK-Duel

All notable changes are recorded here. Format based on *Keep a Changelog*; versions follow SemVer. Circuit releases are tagged separately (`circuits-vX.Y.Z`) because any circuit change invalidates old proofs and benchmark comparability.

Every entry that changes the circuit must state: new constraint count per variant, and whether `publicSignalOrder` changed.

---

## [Unreleased]
_Nothing yet._

## [1.0.2] — 2026-10-17
Viva demo readiness and README polish. **No change to the circuit, its constants, the zkeys, `publicSignalOrder`, Poseidon inputs, bind/digest/commit, `bench/out/` or `bench/RESULTS.md`** (nothing under `circuits/` changed except the version in `circuits/package.json`). Also contains the Phase 6 report sections below, which were committed to main after v1.0.1.

### Offline check (findings before the fix)
- **Static scan** of `client/` and `server/` for `http://` / `https://`. The only runtime network dependency was **Google Fonts**: `client/index.html` loaded an Inter + JetBrains Mono stylesheet and had two preconnects, and the server CSP allowed fonts.googleapis.com / fonts.gstatic.com. Every other URL is a library comment or licence string in the bundle, localhost, or a dev-script default.
- **Live test** (`npm run offline:check`: Chrome with every non-loopback request aborted plus a dead proxy, against the `perf:serve` build). The bot match, spot-checks, audit (`audited_clean`), results page and `/bench` all **worked**. The only failure was the blocked font stylesheet: 1 blocked URL and one `ERR_INTERNET_DISCONNECTED` console error per page, with a silent fallback to the system font.
- Wi-Fi was not switched off, because that would cut the agent session; the block was done in the browser.

### Fixed
- Fonts are now self-hosted: `@fontsource/inter` 5.3.0 (400, 600) and `@fontsource/jetbrains-mono` 5.3.0 (500), bundled by Vite with all unicode subsets and `unicode-range`, as Google served them.
  - Google Fonts links removed; CSP is now `style-src 'self'; font-src 'self'` (SECURITY.md, TECH_STACK.md and UI_UX_SPEC.md updated).
  - After the fix: 0 blocked requests, 0 errors, Inter loaded.
- `server/scripts/detection.ts` `exportCsv` now refuses to overwrite `bench/out/detection.csv` with fewer rows than it already has. After `demo:reset` the live DB has no detection runs, so `detection-report.ts` would otherwise have written an empty CSV.

### Added
- `npm run demo` (`scripts/demo.mjs`):
  - checks Node 22.x, `server/.env`, the ACTIVE_VARIANT artefacts and that ports 8080/5173 are free, each with the exact fix;
  - rebuilds the client (`--mode perf`) only when `client/dist` is older than its sources (marker `client/dist/.demo-build.json`);
  - starts the server + `vite preview` with `DEV_CHEATS=true` and `DEFAULT_ENFORCEMENT=strict`, then prints the player, bot, private-room and `/bench` URLs. Ready in 5–8 s, including a rebuild.
- `npm run demo:reset` (`server/scripts/demo-reset.ts`):
  - refuses while the server runs;
  - backs up with `VACUUM INTO server/data/backup-<local date-time>.db` (never overwrites a backup), then checks integrity and row counts;
  - creates a fresh DB and copies the benchmark runs back, so `/bench` keeps its charts. Never touches `bench/out/`.
- `npm run offline:check` and `npm run demo:rehearse` (Playwright; both need `npm run demo`), plus a TESTING.md §9 item.
- `docs/DEMO.md`: one-page viva runbook (preparation, a 5-minute script with clicks, keys and rehearsal timings, and fixes).
- `LICENSE` (MIT, as `package.json` and the README already stated).

### Changed
- `README.md` rewritten for the public repo:
  - description, two screenshots, key results (numbers only from bench/RESULTS.md and docs/REPORT.md), quick start with `npm run demo`, structure, docs index, limitations and licence;
  - setup, benchmarks and the scripts table kept in collapsed sections;
  - the "build order for a coding AI" section dropped (it is in CLAUDE.md).
- Versions 1.0.2.

### Demo rehearsal (`npm run demo:rehearse`, two runs, AC, one laptop, bots in both windows)
- Honest match: live 4.3–4.6 s after Find Match, first ✓ ≈ 8 s, `AUDITED CLEAN` at 20–38 s.
- Strict private room: live 4.3–4.5 s, forfeit banner 1.9–4.4 s after Speedhack, `AUDIT FAILED` 12–17 s after room creation.
- `/bench`: 0.5 s.

### Secrets check
- No `.env` file (other than the two `.env.example` files), key, DB or zkey file is tracked or was ever committed.
- The real `JWT_SECRET` / `BENCH_TOKEN` values occur in no tracked file, in no commit of the history (`git log -S`) and not in `client/dist`.
- No token or private-key patterns. The only secret-like values in the repo are the example placeholders and a test-only secret.

### Phase 6 — report sections — 2026-10-17
- **Added** `docs/REPORT.md`: Results (circuit size, Groth16/PLONK tables, detection outcome, live catch rate vs prediction, detection latency, playability while proving) and Limitations (L1–L10) for the seminar report, with the source of every number. Detection stats use `bench/out/detection.csv` rows 1–135 only. Live latency over all 118 live catches (Node + browser): median 4.5 s, p95 8.6 s, max 10.6 s; the Node-only figures (114) match Phase 4.
- **Fixed** `bench/RESULTS.md`: the Chrome plonk_60 memory peak is 15.1 GiB (15,492 MiB), not 15.5 GiB.
- PPT update skipped for now (owner).

## [1.0.1] — 2026-10-16
Debugging and cleanup pass (`docs/AUDIT_v1.0.1.md`: 40 findings in Phase A, plus 2 found during Phase B). **No change to the circuit, the zkeys, `publicSignalOrder`, Poseidon inputs, bind/digest/commit or any benchmark result** (no `.circom`, circuit script/test, build artefact, `bench/out/` or `bench/RESULTS.md` change — only the `circuits/` and `bench/` `package.json` manifests; `constantsHash` `fab7a759…` and every `circuits/build/*/info.json` byte-identical before and after). Every commit passed typecheck, lint, `npm test` and `npm run test:int` under Node 22.23.3.

### Fixed
- **Server crash on a failed match creation** (E3, `392bd95`): `tryPair` / `joinPrivateRoom` fired `createRoom` without a rejection handler, so a DB or Poseidon error was an unhandled rejection that ended the process. Now logged (`match creation failed`); both players get `error INTERNAL` and can queue again. Regression test `server/src/match/manager.test.ts`.
- **Server crash on a snapshot-log write error** (E4, `accc94b`): the `LOG_SNAPSHOTS` write stream had no `'error'` listener. The error is now logged once and snapshot logging is switched off; an uncreatable log directory no longer fails match creation. Tests `server/src/log/snapshotLog.test.ts`, `manager.test.ts`.
- **Startup hang when a verifier worker dies before it is ready** (E5, `ffc3275`): the pool respawned the failing worker forever and `VerifierPool.ready()` never resolved. Startup now fails fast with `verifier worker failed before it was ready (vkey …)`. Test `server/src/zk/verifierPool.test.ts`.
- **Dev server exposed the whole repo to the LAN** (X1, `02a9962`): `server.fs.allow: ['..']` served e.g. `server/data/zkduel.db` via `/@fs/` (200). Now only `client/` and `circuits/build` → 403; game, `/zk`, `/bench.html` and fixtures unchanged (checked with `npm run dev` and `npm run dev:lan`).
- `npm run test:e2e` crashed ("No tests found": no Playwright config/specs) (E2, `fb28603`): now runs `e2e:cheats` then `e2e:audit-reload` (needs `npm run perf:serve`); both PASS.
- Integration test "audit policy gap" failed on a loaded machine (E1, `1dbf320`): the loser could not prove ~41 audit windows in the 15 s audit window (rate limit ≥ 11 s + ~0.5 s/proof). Test-only: 30 s; assertions unchanged.
- Favicon 404 on every page load (S8, `854bc80`).

### Removed
- `SERVE_CLIENT` env var (validated, never read) and the unused `@fastify/static` dependency (D5/U1, `9acfb3b`); single-port production serving is documented as future work. Direct `pino` dependency (U2) — nothing imported it; Fastify's bundled pino still does the logging.
- `ENV.DEV_CHEATS` (never read) and `export` on 10 module-local values (D2/D4, `9e181ce`).

### Changed
- Node pinned to 22: `.nvmrc`, `engines.node` `>=22 <23` (`b976475`).
- `@zkduel/shared` declared in client/server/circuits/bench, `zod` in server (U5, `3ee5653`); lockfile regenerated under Node 22.
- `MS_PER_TICK` moved to `shared/constants.ts`, outside `CONSTANTS` (not hashed); new test pins `constantsHash` (S1, `ea0c3c3`). Rule-1 note: render/UI tuning values (renderer sizes, banner/refresh timings, ping interval, mouse sensitivity) stay module-local in the client, as before.
- Versions 1.0.1; `SERVER_VERSION` / `clientVersion` read from `package.json` (S2, `83da3e5`).
- `client/scripts/*.ts` are now typechecked (`client/tsconfig.scripts.json`); stale comments in `view.ts` / `protocol.ts`; snapshot-log header uses the injected epoch clock (S3–S5, S7, `b29afa5`).
- `knip.json` with the real entry points: knip reports nothing (S9, `65f6c58`).
- Unit tests for `BotInput`, `MemoryTickLog`, `TimingStats` (T1, `a63a648`): unit line coverage 55.7 % → 62.4 %.
- Docs matched to the code (M1–M10, `18a2091`): DEPLOYMENT/ENVIRONMENT build commands, unbuilt routes (`GET /api/matches`, `/api/matches/:id/log`) marked, `bench:node`, migrations 004/005, circomspect gate, CLAUDE.md file count.

### Tests
`npm test` 366 → 383 passed · `npm run test:int` 27/28 → 28/28 · `npm run test:e2e` broken → PASS · knip, depcheck clean except documented items · `npm audit --omit=dev` 15 low (unchanged: elliptic via circomlibjs).

### Known, not changed (see AUDIT_v1.0.1.md)
- **LAN demo over plain HTTP cannot start on a second laptop** (E6, found in Phase B): `crypto.subtle` is undefined on a non-secure origin such as `http://192.168.x.x:5173`, so `constantsHash()` throws at boot (also `matchField`, artefact hash check). Not fixed — the same code feeds the proof `bind`. Workaround verified: start Chrome with `--unsafely-treat-insecure-origin-as-secure=http://<laptop-ip>:5173`.
- `circuits/build/*/info.json` record a stale `constantsHash` (X3): two values, neither the current one, because `CONSTANTS` also holds non-circuit values (rate limits, timeouts) changed after those builds. Nothing reads it at runtime.

## [1.0.0] — 2026-10-12
First complete release for the CSC301 seminar: 1v1 browser shooter whose rule compliance is proven per window with zk-SNARKs (commit every window, prove on challenge, full post-match audit), cheat demo, benchmarks. Circuit unchanged in Phases 4.5–6 (constraint counts: groth16_30 16,968 · groth16_60 32,748 · groth16_120 64,308; PLONK 270,648 / 530,058 / 1,097,478 rows); `publicSignalOrder` `[commitOut, bind, digest, commitIn]` unchanged. Tag `v1.0.0`.

**Commits per phase**

| Phase | Commits |
|---|---|
| Specs | `3cec127` baseline spec set · `ea44bf4` pre-Phase 0 spec fixes |
| 0 — repo setup | `129cd48` |
| 1 — playable game, no ZK | `87d11eb` · `6d97655` follow-ups |
| 2 — window circuit, offline tests | `a3c21c1` |
| 3 — live proving / verification | `c567c5f` · `21a961b` (exit check passed) |
| 4 — cheats, private rooms, detection experiment | `5887a97` |
| 4.5 — 3D renderer + first-person input | `fa2c3bf` · `dd0de6d` · `c300892` |
| 5 — benchmarks | `45b8896` tooling · `db0b8b5` · `5948972` Groth16 runs · `4748bb0` RESULTS + charts · `a640f9e` PLONK Node · `81bc898` driver exit fix · `66aa6ac` PLONK Chrome + charts · `606fc75` screenshots |
| 6 — polish, demo checklist, release | `d56c812` README/label · `d420ee8` first checklist run · `8b80b96` checklist CSV, TESTING §9 · `3182abd` **rate-limiter fix** · release commit tagged `v1.0.0` |

**Known limitations** (details: `bench/RESULTS.md`, PRD): smooth-aim / input provenance is out of scope for the proofs (an aimbot obeying the turn limit passes); single-party Groth16 phase-2 setup; walls are not checked in the circuit; benchmarks from one laptop only (stronger machine deferred); PLONK impractical on this hardware; the demo checklist was run on one laptop with two Chrome windows (two-laptop LAN run not done).

### Phase 6 — fix: honest snapshots dropped by the WS rate limiter — 2026-10-12
#### Fixed
- **False `mismatch_digest` against honest players.** Cause: the per-connection snapshot limit was 70 per *fixed 1-second window* at 60 ticks/s. A ~170 ms stall of the Chrome process running both players made both clients send a catch-up burst; the gateway answered `RATE_LIMITED`, the dropped real snapshots were held in the server digest, and the honestly proven window failed (`mismatch_digest`, same window for both players; the `ws strike` log shows the strikes at exactly those ticks in matches `99315686` and `c7b5a682`). The gap-fill / late-snapshot digest path was correct (late snapshots replace holds until the late bound) — the snapshots never reached it.
- `server/src/ws/rateLimit.ts`: token buckets. Snapshots refill at `RATE_LIMIT_SNAPSHOTS_PER_S` (70/s, unchanged) with burst capacity **`RATE_LIMIT_SNAPSHOT_BURST` = PROOF_GRACE_WINDOWS × 120 + STALL_TICKS = 246** (new constant, flagged per rule 1: every tick the server can still accept); proofs / commits / other keep their per-second budgets. A flood is still limited and still closes the socket (4429).
#### Added
- Server log `digest gap-fill` (match, player, round, window, fromTick, count) whenever the digest holds a skipped / never-arrived tick (public tick numbers only). In practice one line per held tick (each later snapshot triggers its own fill). Seen in the verification runs: ticks 60–65 of window 1, the client filling locally after falling > STALL_TICKS behind — windows valid.
#### Tests
- `rateLimit.test.ts`: honest traces (60/s with a 120–400 ms stall at 55 positions, then the catch-up burst) are never limited; the old fixed-window limiter rejects them (reproduces the bug); flood and per-category budgets. `matchRoom.test.ts`: snapshots delayed past STALL_TICKS for one window, then delivered late (both players / one player held by the tick loop) give exactly the digest over the real snapshots. Security flood test sized beyond the burst. Unit 320/320, integration 28/28.
- **Verification:** 3 honest 3-min bot matches (`perf:match -- --acc 1800 --miss 300 --stop-after 180`, perf build, AC/Performance, power watcher: no events): **all `audited_clean`, 180/180 windows valid per player, spot-checks 80/80, 81/81, 80/80, 0 rate-limit strikes**, frame p95 ≤ 7.2 ms, audit 189–195 s.
- Unaffected: Phase 4 detection data — its 135 matches have only `valid` (5,083) and `unprovable` (973) windows, no `mismatch_digest`; smooth-aim controls 722/722 valid. Phase 5 benchmarks prove offline (no server code; constants they use unchanged).
#### Notes
- `constantsHash` changed (new constant): client and server compute it at runtime, so they agree after a rebuild; the value recorded in each circuit's `info.json` is informational only (not enforced) and now differs. Circuits and zkeys unchanged.

### Phase 6 — demo checklist re-run after the fix — 2026-10-12
All automated, one laptop (perf build, AC, Performance scheme, power watcher: no events):
1. *Full match, all ✓* — 3/3 honest 3-min matches `audited_clean` (above). **PASS** (one-laptop substitute for the two-laptop LAN match).
2. *Speedhack, rapid-fire, infinite ammo, snap-aim → non-valid* — `exp:browser`: all four `audited_failed`, all four caught live this time; `e2e:cheats` E2E-2 strict + speedhack → forfeit after 1.6 s. **PASS.**
3. *Smooth-aim stays ✓* — E2E-3 16/16 spot-checks, `audited_clean`; `exp:browser` smooth-aim `audited_clean`. **PASS.**
4. *Dashboard with reference lines* — `/bench` serves (200), 6 runs; charts exported in Phase 5. **PASS.**
5. *Frame inspector green* (reworded item) — 5,062 frames, no hidden keys. **PASS.**
- `e2e:cheats` 11/11 PASS. The 10 browser detection rows of both checklist runs are in `bench/out/detection-checklist.csv` (ids 136–145), not in the Phase 4 `detection.csv`.

### Phase 6 — polish + first demo checklist run — 2026-10-12
- Results screen: live detection latency shows `– (none caught live)` instead of the stale `– (Phase 4)`. README: benchmark section rewritten (scripts that exist), power-settings prerequisite, `circuits:build -- --all`.
- **Demo checklist (TESTING.md §9), automated, one laptop (perf build, AC, Performance scheme, power watcher: no events):**
  1. *Full match, all ✓* — substitute: `perf:match` 3-min honest bot match (two Chrome windows on one laptop; two laptops not available). **FAILED, reproduced twice:** `audited_failed` OVERTURNED, 1 `mismatch_digest` window per player (same window for both), 179/180 valid; frame p95 7.2 ms. Open bug in TODO.md → Bugs; **v1.0.0 not tagged**.
  2. *Speedhack, rapid-fire, infinite ammo, snap-aim → non-valid* — `exp:browser`: all four `audited_failed` (three caught live, snap-aim by the audit). **PASS.** `e2e:cheats` E2E-2 strict + speedhack → forfeit after 1.6 s. **PASS.**
  3. *Smooth-aim stays ✓* — E2E-3: 17/17 spot-checks, `audited_clean`; `exp:browser` smooth-aim `audited_clean`. **PASS.**
  4. *Dashboard with real-time reference lines* — `/bench` chart export (play-time line, all 12 variants). **PASS.**
  5. *Match log download contains no hidden state* — **doc mismatch:** the only downloadable log is the dev-only local tick log (`VITE_LOG_TICKS`), which by design contains the player's own hidden state and never leaves the browser. Network side checked by the frame inspector (`e2e:cheats`, 5,054 frames, no hidden keys): **PASS.** Proposed TESTING.md fix: reword item 5 to "frame inspector green; the dev tick log is local only".
- Run once (not twice as TODO lists) per owner instruction.

### Phase 5 — benchmark runs — 2026-10-12
Results and conditions: `bench/RESULTS.md`. All 6 variants measured in one session (AC, Performance scheme, power watcher: no events). Groth16 2 warm-ups + 20 samples (Node + Chrome); PLONK with fewer samples (owner decision); Chrome plonk_120 failed to load its 3.96 GiB zkey (`Failed to fetch`, recorded as the result).
#### Changed
- `/bench` dashboard: new default run selection "Best run per variant (all runs)" (per scheme × N the run with the most samples, newest on a tie), because Groth16 and each PLONK variant were separate runs. Prove-time chart subtitle states the real n per point instead of "20".
- `bench/tables.ts`: RESULTS.md tables from the raw run files.
#### Fixed
- `bench:browser` stayed alive for 90 min after a run (uncleared per-variant timeout timer); it now clears the timer and exits.
#### Data cleanup
- The duplicate partial plonk_120 Node run (`7b5f5110…`, 1 sample) was deleted from the database with owner approval; results.csv regenerated (137 samples).

### First-person WASD (input only, owner request) — 2026-10-12
No change to sim rules, protocol, circuit or constants: the per-axis bound |Δx|, |Δy| ≤ MAX_SPEED that `checkTick` and `SpeedCheck` enforce is unchanged; only what the input layer asks for changes.
#### Changed
- **3D first-person: WASD is facing-relative** — W forward along the aim yaw, S back, A/D strafe, combinations allowed. `client/src/game/facing.ts` `relativeStep()` rotates (forward, right) by the yaw with the integer sin/cos table (`TRIG_SCALE` 1024): forward = (cos a, sin a), right = (−sin a, cos a); each axis = round(MAX_SPEED · v / TRIG_SCALE) clamped to ±MAX_SPEED. Top-down (and the 2D renderer) keep arena-axis WASD. The keyboard input asks the active renderer (`GameRenderer.isFirstPerson?()`) every tick, so V switches the mapping immediately.
- `shared/sim.ts`: `TickInput.step?: {dx, dy}` (optional exact integer step, overrides moveX/moveY) and `stepExact()` (round, clamp each axis to ±MAX_SPEED, then to the arena). Additive; the arena-axis path is unchanged. Diagonal steps are e.g. (3, 3) at 45°; W+D at 45° is (0, 4), i.e. no diagonal speed bonus beyond the existing per-axis rule.
- Speedhack is still caught in first-person: a facing-relative step always has one axis ≥ 3, so doubling it exceeds MAX_SPEED.
- Bot: `?fpmove=1` moves with facing-relative WASD; `perf:match --fp-move` (implies `--camera first`) and runs the rule checker (`checkSequence`, the circuit mirror) over each page's own tick log in memory (hidden state never written out), plus a count of off-axis steps.
- UI_UX_SPEC camera note updated. `axisMapping.test.ts`: the old "first-person W goes left" test now checks, through the real first-person camera, that W lands straight ahead, S behind, D right and A left of the view at 7 yaws.
#### Added (diagnostics)
- Server logs `ws strike` (player id, error code, fixed reason, strike count) and `ws closed` (player id, close code, reason, strikes); the client logs `[net] socket closed (<code>)` to the console. Codes and fixed strings only — no game state. Added because an earlier run lost a client with no trace (below).
#### Tests
- `facingMove.test.ts` (60): W/S/A/D and the four diagonals at yaw 0, 450, 900, 1234, 1800, 2700, 3150 give integer steps ≤ MAX_SPEED in the right direction (< 15° from the float direction, exact at the cardinals), applied unchanged by `stepPlayer` and accepted by `checkTick`; S = −W, A = −D, opposite keys cancel; all 3600 yaws × 9 combinations legal and equal to the table formula; a 2000-tick walk along the walls stays legal. Unit suite 310/310; typecheck, ESLint, Prettier clean.
- **Recorded first-person match** (`npm run perf:match -- --fp-move --acc 1800 --miss 300 --stop-after 60`, dev server, real groth16_60 key): rule checker **all legal** for both players (3569 ticks each; 2991 / 3054 moving, 2293 / 2415 of them off-axis facing-relative steps); 59/59 windows valid per player, spot-checks 7/7 + 7/7, **`audited_clean`**, verdict verified; zero strikes. An earlier run of the same match (5e0b5470) was also `audited_clean` (120/120 valid) but crashed before the rule check (script bug: tick logs read after `browser.close()`, fixed).
- These runs were on **battery** with the "Silent" power scheme: prove mean 5.5 s (vs ≈ 2.3 s on AC in Phase 4.5) and a 60 Hz display — not usable as performance numbers.
- Integration suite: 24/26. The two failures — `matches.test.ts` tick-loop p99 2.25 ms (bound < 2 ms) and `phase4.test.ts` loser's audit `audit_incomplete` — fail identically with this change's server files stashed (p99 2.89 ms), i.e. machine state (battery, Silent scheme), not this change. To re-run on AC.
#### Incidents while testing (environment)
- Run 1 lost its WebSocket: the laptop entered **Modern Standby** 10:18:54–10:21:33 on battery (Kernel-Power 506/507, "connectivity in standby: disconnected"); the match aborted at tick 0. Later standbys 10:56–12:59 stalled a test run.
- Run 3 hung on "Waiting for opponent…": 33 s into the match one window returned to the lobby without a reconnect attempt (new guest login, no page reload), the server ended the match `disconnect` 10 s later, and the bot auto-re-queued alone. No standby at that time; strikes and close codes were not logged then, so the cause is **not confirmed** — the diagnostics above were added and the next run had no strikes or unexpected closes. `perf:match` itself still waits up to 15 min if a page re-queues (it does not detect a lost match).

### Phase 4.5 — 3D renderer — 2026-10-11
Rendering only: game rules, sim, protocol, input and circuit are unchanged (positions stay integer x, y on a flat floor, aim is one yaw angle, shots are horizontal rays).
#### Added
- **Three.js renderer** (`client/src/game/renderer3d.ts`, three **0.186.1**, `@types/three` 0.186.0) behind the existing `GameRenderer` seam (`view.ts`); same lint rule as the 2D renderer (no sim / protocol / session / input / network imports). Lazily loaded (own 539 kB / 135 kB-gzip chunk) — the 2D path never downloads it.
  - Arena: 1000×600 floor, 50-unit grid (brightened for projectors), low walls on the edges, hemisphere + directional light, no shadows.
  - Players: low-poly capsules at their true radius in the P0/P1 colours (self-lit base to match the HUD), barrel + floor arrow for the aim direction, white hit flash; opponent interpolation unchanged.
  - Shots: tracer lines at barrel height in the shooter's colour, clipped to the walls, 140 ms fade.
  - Camera modes on **V** (remembered per browser): angled top-down over the whole arena (default) and first-person (yaw from the aim angle, no pitch, own capsule hidden, crosshair). Mode badge bottom-right; the hint line mentions V.
- **Canvas 2D kept as fallback:** `?renderer=2d`, and automatically if WebGL cannot start.
- `perf:match` gained `--renderer 2d|3d` and `--camera third|first`.
#### Fixed
- The Settings overlay (and any element toggled with the `hidden` attribute whose class sets `display`) was visible from the start of a match until the pointer was locked — `.settings { display: grid }` overrode `hidden`. A global `[hidden] { display: none !important }` fixes it (also affected the 2D renderer since Phase 1).
#### Measured — frame time while proving (AC power, production `--mode perf` build, two Chrome windows on one laptop, both proving throughout; `npm run perf:match -- --acc 1800 --miss 300 --stop-after 90`; ≈ 144 Hz display)
| Renderer | frame interval p50 | p95 (worst 20 s sample, both windows) | per-frame work p95 | max | match |
|---|---|---|---|---|---|
| Canvas 2D | 6.9 ms | **7.1 ms** | 0.7–0.8 ms | 132 ms | 90/90 windows valid per player, `audited_clean` |
| 3D top-down | 6.9–7.0 ms | **13.9 ms** (first 40 s; then 7.3–7.6 ms) | 1.6–1.8 ms | 146 ms | 90/90 valid, `audited_clean` |
| 3D first-person | 6.9–7.0 ms | **13.9 ms** | 1.8–1.9 ms | 153 ms | 90/90 valid, `audited_clean` |

- Both renderers meet NFR-2 (< 20 ms p95 while proving). In 3D, p95 = 13.8–13.9 ms is exactly two refresh intervals: ≈ 5 % of frames miss one vsync on the 144 Hz display; per-frame CPU work stays under 2 ms.
- The 2D run happened to show slower proving (challenge prove mean 4.3 s, audit 316 s) than both 3D runs (2.3–2.4 s, audit 135 s) and than Phase 3's 2D run (2.2 s) — background load on the laptop during that run, not the renderer (2D does less work per frame); recorded as observed.
#### Notes / decisions
- **First-person movement stays world-aligned** (W = −y), because input is outside this phase's scope ("rendering only"). View-relative WASD in first-person would be an input-layer change (quantised to the 8 legal directions; no rule change) — not done; ask if wanted.
- Top-down is a fixed angled camera over the whole arena (projector-friendly) rather than a chase camera following the own player.
- PRD §3 non-goal "3D graphics" reworded to "3D gameplay" (the renderer is presentation only).
#### Direction check (bug report "W moves left in 3D")
- **Top-down axis mapping verified, no sign flip:** arena x → three X (screen right), arena y → three Z (screen down, camera looks from the +Z edge), heading (cos a, 0, sin a) via `rotation.y = −a`. New unit test `client/src/game/axisMapping.test.ts` (50 cases) projects W/A/S/D/W+D/S+A from 5 positions and 16 aim angles through the real top-down camera and the 2D transform: every sign matches; the only difference is perspective (arena-vertical lines lean ≤ 16° towards the vanishing point at the left/right edges), always within the same one of the 8 compass directions. A right mouse move turns the aim clockwise on screen in both.
- **Cause of "W moves left": first-person mode.** Movement is world-aligned (W = −y), and facing east (P0 spawn, angle 0) arena-up is the view's left. The camera mode is remembered per browser, so a match can start in first-person. The test documents this behaviour; changing it (view-relative WASD) is the pending first-person change.
- Camera math moved to `client/src/game/renderer3dCamera.ts` (pure, Node-testable) and the WASD mapping to `movementFromKeys()` in `input.ts` — refactors, no behaviour change.

### Phase 4 findings (owner-approved, 2026-10-11)
- **1 − (1 − r)^m is a lower bound** on the live catch probability, not a prediction: it assumes every window is spot-checked independently with probability r. For single-window cheats it predicted ≈ 55 % while **85 %** (34/40) were caught live.
- **The scheduler-aware model fits:** replaying each run's real challenge draws through the actual scheduler (uniform over the round's still-unproven windows) predicts **81 %** — within the binomial margin of the observed 85 %. For m ≥ 5 every model and every run is at 97–100 %.
- **Windows late in a round are the least likely to be spot-checked live:** a window stays in the challenge pool from the moment it ends until the round ends, so early windows face many draws and the last windows of a round face few or none. Live spot-checks therefore cannot be relied on for every window — **the full post-match audit is required** for the guarantee (124/124 rule-breaking runs ended `audited_failed` because of it).
- Accepted as decided: an unanswered spot-check when leaving → `timeout` → `overturned` (not `unverified`); the experiment bot behaviour, the Node-based matrix and the smaller additions.

### Phase 4 — Cheats, private rooms and the detection experiment — 2026-10-10
#### Added
- **Result verdict** (audit policy gap): `matches.result_verdict` = `verified` (winner's own audit clean) / `overturned` (winner failed) / `unverified` (winner's audit incomplete — e.g. the winner closed the tab during the audit; the result is not changed) / NULL (no winner). In `audit_end.resultVerdict`, `GET /api/matches/:id`, and as an `UNVERIFIED` stamp on the results screen. Migration `004_phase4`.
- **Dev cheat module** (FEATURES F13): `client/src/game/cheats.ts` (speedhack ×2 step, rapid-fire ignores cooldown, infinite ammo never decrements, snap-aim exact angle, smooth-aim ≤ `MAX_TURN`), shared by the browser and the experiment bots; F9 drawer (280 px, DEV badge); module + drawer dynamically imported behind the compile-time `VITE_DEV_CHEATS` flag (verified: a `VITE_DEV_CHEATS=false` build contains no cheat code); server accepts `cheat_toggle` only with `DEV_CHEATS=true` → `cheat_events` row (window index, epoch) + `cheat_flag` broadcast → `CHEAT: …` tag under the player's name on both screens. Live detection latency (`match_players.detection_latency_windows/_ms`): first cheat activation → first failed challenge after it.
- **Private rooms** (F3): `POST /api/rooms` (creator picks observe/strict; 6-char code without 0/O/1/I; 10 min expiry), both players `room_join`; one seat reserved for the creator (`ROOM_FULL` for a second outsider), `ROOM_NOT_FOUND` for unknown/expired/used codes; match mode `private` with the room's enforcement and `room_code`. Landing "Private Room ▾" (create with enforcement / join by code), room screen with the code + Copy.
- **Detection experiment**: `npm run exp:detect` (Node bots, real groth16_60, provers in worker_threads, 6 threads each), `npm run exp:browser` (one live run per cheat in two Chrome windows, production build), `detection_runs` table, `bench/out/detection.csv`, `server/scripts/detection-report.ts` (matrix + scheduler-aware prediction).
- **Tests**: `cheats.test.ts` (each rule-breaking cheat is rejected by the circuit mirror, smooth-aim legal), tracker verdict + latency tests, integration `phase4.test.ts` (private rooms, cheat events, winner closes the tab during the audit → `unverified`), browser `npm run e2e:cheats` (private room through the UI in two windows, E2E-2, E2E-3, frame inspector).

#### Detection experiment — results (AC power, Intel Core 5 210H 8C/12T, real groth16_60 circuit)
**Node matrix** (`npm run exp:detect -- --reps 10 --m 1,5,20`; 130 matches, 100 min): two Node bots in one process with the server, each proving in a worker_thread with 6 threads (both provers share the CPU — the same worst case as two browsers on one laptop). One round per match (bots fire but always miss), cheat on from window 3 for m windows, 10 more windows, opponent forfeits, both audit. **Browser runs** (`npm run exp:browser`): one live run per cheat in two Chrome windows on one laptop, production build.

| env | cheat | m | runs | m_eff (mean) | r (mean) | caught live | predicted 1−(1−r)^m_eff | scheduler-aware prediction | caught by audit | audited_failed | audited_clean | latency windows / s (mean, caught live) | anomalies |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| browser | infinite_ammo | 5 | 1 | 5.0 | 0.647 | 100 % | 99 % | 100 % | 0 % | 1/1 | 0/1 | 1.0 / 3.9 | 0 |
| browser | rapid_fire | 5 | 1 | 3.0 | 0.471 | 100 % | 85 % | 99 % | 100 % | 1/1 | 0/1 | 0.0 / 3.9 | 0 |
| browser | smooth_aim | 20 | 1 | 0.0 | 0.344 | 0 % | 0 % | 0 % | 0 % | 0/1 | 1/1 | – / – | 0 |
| browser | snap_aim | 5 | 1 | 2.0 | 0.471 | 100 % | 72 % | 87 % | 0 % | 1/1 | 0/1 | 0.0 / 9.5 | 0 |
| browser | speedhack | 5 | 1 | 6.0 | 0.588 | 100 % | 100 % | 100 % | 100 % | 1/1 | 0/1 | 1.0 / 4.2 | 0 |
| node | infinite_ammo | 1 | 10 | 1.0 | 0.564 | 90 % | 56 % | 83 % | 10 % | 10/10 | 0/10 | 0.0 / 4.9 | 0 |
| node | infinite_ammo | 5 | 10 | 5.0 | 0.722 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 1.0 / 3.3 | 0 |
| node | infinite_ammo | 20 | 10 | 20.0 | 0.848 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 1.7 / 4.1 | 0 |
| node | rapid_fire | 1 | 10 | 1.0 | 0.564 | 90 % | 56 % | 83 % | 10 % | 10/10 | 0/10 | 0.0 / 5.1 | 0 |
| node | rapid_fire | 5 | 10 | 3.7 | 0.639 | 100 % | 97 % | 100 % | 20 % | 10/10 | 0/10 | 0.6 / 3.7 | 0 |
| node | rapid_fire | 20 | 10 | 13.0 | 0.824 | 100 % | 100 % | 100 % | 30 % | 10/10 | 0/10 | 1.3 / 5.1 | 0 |
| node | smooth_aim | 20 | 10 | 0.0 | 0.486 | 0 % | 0 % | 0 % | 0 % | 0/10 | 10/10 | – / – | 0 |
| node | snap_aim | 1 | 10 | 1.0 | 0.543 | 70 % | 54 % | 80 % | 30 % | 10/10 | 0/10 | 0.0 / 4.5 | 0 |
| node | snap_aim | 5 | 10 | 5.0 | 0.726 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 1.1 / 3.3 | 0 |
| node | snap_aim | 20 | 10 | 20.0 | 0.848 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 1.3 / 3.8 | 0 |
| node | speedhack | 1 | 10 | 1.0 | 0.529 | 90 % | 53 % | 80 % | 10 % | 10/10 | 0/10 | 0.0 / 4.8 | 0 |
| node | speedhack | 5 | 10 | 5.0 | 0.722 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 1.5 / 3.9 | 0 |
| node | speedhack | 20 | 10 | 20.0 | 0.848 | 100 % | 100 % | 100 % | 0 % | 10/10 | 0/10 | 0.8 / 3.4 | 0 |

- **Exit criteria:** every rule-breaking cheat ended `audited_failed` in **124/124** runs (120 Node + 4 browser) — caught live, by the audit, or both; smooth-aim ended `audited_clean` in **11/11** (10 Node + 1 browser). **0 anomalies**: in every run every cheater window with a rule violation (ground truth: `checkSequence` on the cheater's own tick log) failed (`unprovable`) and every other window was `valid`.
- **Live catch vs prediction:** for m ≥ 5 the live catch rate is 100 % and both predictions are 97–100 %. For **m = 1** the observed live catch rate (pooled over the 4 cheats) is **34/40 = 85 %** (95 % CI ≈ 70–94 %), the naive **1 − (1 − r)^m predicts ≈ 55 %**, the **scheduler-aware prediction ≈ 81 %**. The naive formula underestimates single-window cheats because it assumes an independent per-window probability r; our scheduler draws uniformly among all still-unproven windows of the round, so a window that ends early stays in the pool for many draws (here: window 3 of a ~14-window round). The scheduler-aware prediction (a Monte Carlo replay of each run's real challenge draw times, `server/scripts/detection.ts` `schedulerPrediction`) matches within the binomial margin; the naive one does not for m = 1.
- **Achieved r:** honest play ≈ 0.49 (smooth-aim control) with two Node provers; it rises while cheating (0.53–0.85) because a cheated window fails in milliseconds (witness generation aborts), so the next challenge comes sooner. Browser runs: 0.34–0.65.
- **Live detection latency** (activation → first failed challenge; 114 live catches): **median 4.5 s, p95 8.6 s, max 10.6 s**; 0 windows after activation in 62/114, ≤ 3 windows in 113/114.
- **m_effective < m_nominal** for rapid-fire (3.7 of 5, 13 of 20): the cheat only breaks a rule when a shot happens during the cooldown, and the magazine reloads in between. Browser snap-aim m=5 had m_eff 2 (snap every tick: only the large turns are illegal).

#### Exit check — Phase 4
| Check | Result |
|---|---|
| Every rule-breaking cheat ends `audited_failed` (live or audit) | ✅ 124/124 runs |
| Smooth-aim ends `audited_clean` | ✅ 11/11 runs (and E2E-3: 13/13 spot-checks, 36/36 windows valid) |
| Live catch rate vs 1 − (1 − r)^m | ⚠️ m ≥ 5: 100 % vs 97–100 % ✅; **m = 1: 85 % vs 55 % — outside the margin**; the scheduler-aware prediction (81 %) is within it. Reported as a finding, table above |
| Private rooms between two browser windows | ✅ created + joined through the UI (`npm run e2e:cheats`), strict enforcement carried over |
| Frame inspector clean | ✅ browser: 5,141 frames, keys incl. `cheat`, `enabled`, `roomCode` — no hidden key; integration suites ✅ |
| E2E-2 strict + speedhack → forfeit | ✅ `forfeit_proof` 2.3 s after activation, banner "Spot-check failed: unprovable — round 1, window 2 …" |
| E2E-3 smooth-aim → valid, `audited_clean` | ✅ |
| Winner closes the tab during the audit → `unverified` | ✅ integration |

Tests: `npm test` 246/246, `npm run test:int` 26/26 (Phase 1 + 3 + 4 suites), `npm run e2e:audit-reload` PASS, circomspect clean, typecheck / ESLint / Prettier clean.

#### Deviations / decisions to confirm
- **Experiment bot behaviour while cheating** (`server/scripts/exp-detect.ts`): speedhack keeps moving, rapid-fire/infinite ammo hold the trigger, **snap-aim snaps every 10 ticks and does not shoot** (a hit-scan snap would end the round in under a second and reset the challenge pool). The cheat module itself (F13, F9 drawer) snaps every tick; `Cheats.snapEveryTicks` is the only experiment knob. Bots fire but always miss (`missBy` 300) to keep the match in one round.
- **Full matrix with Node bots** (as allowed): bots prove in worker_threads with 6 threads each; Node proves ≈ 1.2× faster than Chrome, so r is somewhat higher than with two browsers (browser runs: 0.34–0.65 vs Node 0.49–0.85).
- **Closing the tab with an outstanding challenge** after `match_end` → that challenge times out (failure) → the winner is `overturned`, not `unverified`. Kept deliberately (otherwise a last-window cheat + leaving would only give "unverified"); `unverified` is for leaving after the live challenge was answered. SECURITY A17 updated.
- `cheat_events` gained `created_at`; `proof_windows.decided_at`, `match_players.detection_latency_ms`, `matches.result_verdict` and `detection_runs` added (migration 004). Detection latency in windows is counted in window order from the activation window.
- `POST /api/rooms`: 10/min per IP, `409 ALREADY_IN_MATCH` while in a match; one seat reserved for the creator.
- Dev automation URL params (dev and `--mode perf` builds only): `&manual=1` (bot plays, lobby driven by the UI), `window.__zkd.cheat(name, on)`, `window.__zkd.tickLog()`.
- Benchmark export of the per-match research metrics stays a Phase 5 item; the detection rows have their own CSV (`bench/out/detection.csv`, 135 rows).

### Phase 3 findings (owner-approved, 2026-10-10)
All timings are on AC power (Intel Core 5 210H, 8C/12T, Chrome 155, Node 22.23.3); they supersede every battery-era number below.
- **Prove time vs play time (Chrome, one client):** N=60 prove p50 1,419 ms = **1.42×** the 1 s window; N=30 891 ms = **1.78×** the 0.5 s window. Proving every window live is not sustainable; Node (bot worker) is 1.1–1.2× faster than Chrome (1,187 / 795 ms).
- **Max sustainable live challenge rate** r_max ≈ window duration / prove time (one outstanding challenge, proofs back to back): Chrome alone **≈ 0.70 at N=60** (1000 / 1419), **≈ 0.56 at N=30** (500 / 891). Measured in the worst case (two provers on one laptop, N=60): **r = 0.356** (64 challenges / 180 windows; challenge prove p50 ≈ 2.2 s → 1/2.2 ≈ 0.45 minus verify/round-trip/idle gaps).
- **Frame time is unaffected by proving** (worker): p95 7.1 ms during the 3-minute match.
- **Power throttling note:** on battery with the power-saving plan, proving was **≈ 3.7× slower** (Node groth16_60 4,371 ms vs 1,187 ms on AC) and Chrome capped rendering at 30 Hz (33.5 ms frames). The battery-era numbers further down (marked) are kept only as this note.

### Phase 3 — Commit, challenge & audit — 2026-10-10 (exit check passed)
#### Added
- **Shared:** `window_commit`, `challenge`, `audit_end` messages; `matchId` on `window_proof`/`proof_failed`/`proof_result`; `phase` on `proof_result`; `resume.committed` + `resume.challenge`; `match_found.variant`; `match_end.auditTimeoutMs`; statuses `committed`, `missing_commit`, `unaudited`; `FAILURE_STATUSES`; `ClientFrame` type. Constants `PROOF_DEADLINE_MS` (15 000), `AUDIT_TIMEOUT_MIN` (60; was 30 until the review), `RATE_LIMIT_COMMITS_PER_S` (20, new: N=4 commits 15/s). `poseidonSync` (after `poseidonReady`) for the per-tick digest. Tick-log `window` line (salts + commitment, client logs only).
- **Server (`server/src/zk/`):** `DigestBuilder` (hashes tick t only when t ≤ processed tick and its value is final: arrived, skipped, or past the late bound; round-end padding; mid-round cut-off), `ProofTracker` (commit store, commit deadline → `missing_commit` + `chain_broken`, challenge scheduler with `crypto.randomInt`, pipeline bind → digest → commitIn → commitOut → verify against the claimed commitments, strict-mode forfeit, disconnect chain break, resume info, audit close + `overturned` + metrics), `VerifierPool` (worker_threads, timeout, worker replacement), variant loader (`info.json` + vkey; `/api/circuit/info` and `/api/health` list built variants). `MatchRoom`: `ready` checks the zkey hash, room stays registered until its audit closes (players are freed at `match_end`), late snapshots accepted into the ended round's final window during the pause/after the match, reconnect → `resume` + `state`. Gateway: `window_commit` (own rate budget, routed to the live room or the latest auditing room), `window_proof` header-first (malformed bodies attributed → `malformed` + strike), routing by `matchId`. Migration `002_proofs` (`proof_windows`, `matches.audit_status/overturned/audit_ended_at`, `match_players` metric columns). `GET /api/matches/:id` adds audit + per-player stats/metrics; new `GET /api/matches/:id/windows`.
- **Client (`client/src/zk/`):** artefact loader (download progress, SHA-256 via `crypto.subtle`, Cache API keyed by hash), `WindowRecorder` (freeze on state/round_end, truncate + pad, salts, commitments), `ProofClient` (commits, challenge-first queue then audit, resume/reconnect handling, per-window status for both players), Proof Worker (builds the input in the worker; warm-up proof during the countdown), `WorkerProver`. `GameSession`: explicit `ready` with the zkey hash, hold-fill up to `endTick` when lagging at round end, dev/test `tamper` hook. UI: proof strips (hollow / ◌ / ✓ / ✕ / ⛓) + "Spot-checks: x/y passed" + tooltips, last prove time, strict-forfeit banner; queue screen shows "Loading proving key… n%"; results screen: audit banner with live "Auditing… x/y windows", final status, `OVERTURNED` stamp, per-player status counts, spot-checks, r, detection latency (Phase 4), audit duration, prove/verify times, full window timeline; leaving during the audit asks first. Auto-reconnect (0.5/1/2 s backoff up to `RECONNECT_TIMEOUT_MS`).
- **Tooling:** `npm run perf:match` (two visible Chrome windows play through spot-checks + audit; `--stop-after` for a fixed length), `npm run perf:prove` + `/bench.html` (Step 1), `server/scripts/zk-node-bench.ts` (Node prove + pool verify on an idle machine). Bots: `NodeProver` (worker_threads, artefacts read once, thread cap), `BotClient` proving / tamper / drop + reconnect.
- **Tests:** unit — 7 DigestBuilder (= JS reference/circuit digest incl. gaps, late values, ticks past endTick, padding, cut-off), 13 ProofTracker (deadlines, chain_broken, challenge eligibility, uniformity χ² over 4 000 draws, every pipeline status, strict, disconnect/resume, audit close/overturned), 4 WindowRecorder (= `sliceLogWindows`, server digest = client input digest at round end, salts < p), MatchRoom ready-hash + audit close, protocol schemas; integration (real sockets, real N=4 proofs) — clean match → `audited_clean` + frame inspector, speed and hidden-ammo cheaters → never clean, every mismatch/invalid/malformed/timeout, `missing_commit` → `chain_broken`, strict forfeit, reconnect + resume; circuit — `ammoSafety.test.ts`.

#### Fixed (found by tests during the phase)
- **Every challenge was proven twice**: after sending a proof the window stayed `committed` until the result arrived, so the queue proved it again. Windows with a proof in flight are now skipped (`onReconnected()` re-queues them if the socket died).
- DigestBuilder would have hashed a tick a client sent past `endTick` before the server processed `endTick` (now: only ticks ≤ the processed tick are hashed).
- snarkjs/ffjavascript could not run inside a `worker_thread` at all: its `web-worker` shim treats every worker thread as its own child. Workers now present themselves as main thread before loading snarkjs. Capping the verifier's ffjavascript pool to 1 thread doubled verify time (p50 26 → 65 ms) — not capped.
- A worker exiting without an `error` event, or an exception in the async pipeline, could leave a window "verifying" forever and block the audit until its timeout.
- Test hook: a withheld proof was retried forever (all later challenges timed out).
- Integration files now run sequentially (`fileParallelism: false`) and failed matches close their bots: leftover provers were loading the CPU for later tests.

#### Measured during development (Intel Core 5 210H, 8C/12T, Node 22.23.3, Chrome 155) — ⚠ CPU-throttled: the laptop was on battery/power-saving for (at least) the later part of this session, so these timings are pessimistic and superseded by the AC numbers below; the functional results stand
- **Integration, real proofs, N=4 test circuit (bots in Node):** clean match → 95/95 windows valid per player, challenges 4/4 passed, r = 0.042, audit 117 s, **`audited_clean`**; frame inspector 1,146 client frames (190 `window_commit`, 196 `window_proof`), wire keys only `angle, artefactSha256, clientVersion, commitOut, constantsHash, curve, fired, matchId, pi_a, pi_b, pi_c, proof, protocol, proveMs, publicSignals, roundNo, scheme, t, tick, token, windowIndex, x, y` — no hidden key. Speed cheat (one tick, window 7) → `unprovable`, caught by the **audit** (not challenged live; r ≈ 0.05), `audited_failed` + `OVERTURNED` (the cheater won). Hidden ammo refill (window 7) → same. Mutated answers → exactly `mismatch_bind, mismatch_digest, mismatch_commit (in), mismatch_commit (out), invalid, malformed, timeout`, then `valid`. Missing commit r1w5 → `missing_commit`, 45 later round-1 windows `chain_broken`, round 2 all valid. Strict → `forfeit_proof` in the same step as the result. Reconnect: resume `{chainStatus: broken, committed: 10 windows, challenge: w0 with 2.6 s left}`, w10+ `chain_broken`, next round valid, `audit_incomplete`.
- **Verify (VerifierPool, worker_threads, one worker, idle machine):** p50 26.1 / p95 32.8 ms (groth16_4, 100 verifies) — NFR-4 met. Under integration load (two bot provers in the same process): p50 34 / p95 48 ms (190 verifies); worst run p95 72 ms (two test files in parallel, since disabled). In the browser matches the server shared the laptop with two proving browsers: verify mean 34–148 ms per player — NFR-4 **not** met under that load.
- **Node proving (bot worker, idle):** groth16_4 prove p50 656 ms (12 threads) / 1,530 ms (2 threads); groth16_60 witness 326 ms, prove p50 4,371 / p95 4,651 ms — ≈ 2.8× slower than Chrome on the same laptop.
- **Browser match (two visible Chrome windows, one laptop, both clients proving):** see the Phase 3 report — results with the laptop **on battery (13 %, "Silent" power plan)** for at least the last run: Chrome capped rendering at 30 Hz (frame interval p50 33.3 / p95 33.5 ms, per-frame work p95 1.7 ms) and proving slowed (challenge prove mean 5.6 s, p95 6.4 s; the earlier run 6.8–8.3 s). Clean match of 66 s of play (64 windows per player): **9/9 spot-checks passed per player, r = 0.141, audit 321–323 s, every window valid → `audited_clean`**; warm-up proof 8.2–8.4 s. First run (10 s deadline, no warm-up, 41 s match): frame interval p95 17.0 ms, both players' first challenge `timeout` (cold first proof > 10 s) → `audited_failed` — led to the deadline revert + warm-up. A 6.7-minute run (395 windows/player) had every challenge valid; its audit (≈ 6 s per window with two browsers proving) was interrupted at 13.6 min with 209 windows left per player by my own code edit (Vite reloaded the pages) — no final status for it.

#### Follow-ups after review (owner decisions, 2026-10-10)
- **Accepted:** only `missing_commit` breaks the chain; `overturned` only when the winner's audit fails. **Added:** per-player audit status (`match_players.audit_status`, migration `003_player_audit`; `audit_end.players[].auditStatus`; results screen "Own audit") — a loser whose audit fails is recorded `audited_failed` without changing the result.
- **`AUDIT_TIMEOUT_MIN` = 60** (was 30).
- **Audit survives reloads:** every window's private circuit input is written to IndexedDB (`zkduel-audit`, key matchId/round/window) when the window is frozen and deleted as soon as the server decided it; the match record holds the audit deadline. On page load an unfinished audit inside `AUDIT_TIMEOUT_MIN` resumes automatically (`AuditResumer`: `GET /api/matches/:id/windows` → prove the still-`committed` windows). Test `npm run e2e:audit-reload` (real Chrome, production build): player 0 reloaded at 3/15 audit windows → resumed with 12 left → both players 21/21 valid, `audited_clean`, 0 stored windows left. SECURITY §8: private inputs now also live in the player's own IndexedDB until decided — never sent anywhere.
- **Production build for perf runs:** `vite build --mode perf` (bot automation URL params + `window.__zkd`; a plain `vite build` has neither) served by `vite preview`, which now also serves `/zk/*`; `npm run perf:serve` = perf build + preview + server without watch. Source edits can no longer reload pages mid-run.
- **Bots:** `?miss=<angle units>` (bots fire but never hit) so `--stop-after 180` gives an exact 3-minute match.

#### "Node is 2.8× slower than Chrome" — investigated: it was the power state, not our code
- snarkjs per-step profile in Node (`server/scripts/prove-profile.ts`): groth16_60 prove 1.20 s warm in the main thread; the same code inside a worker_thread (with the `isMainThread` shim): 1.17–1.21 s; our bot worker (`nodeProveWorker.mjs`) under plain node: 1.17–1.20 s, under tsx: 1.19–1.23 s; letting snarkjs re-read wasm/zkey from file paths on every proof instead of in-memory buffers: 1.17–1.23 s (OS cache — no measurable cost).
- The earlier 4.37 s (Phase 3 session 1) and 4.8 s (Phase 2 preview) were measured on battery with Windows' power plan throttling the CPU — the same session's last browser runs were confirmed on battery (13 %). Numbers from that session are kept above for the record but are **not** comparable.
- **Fair comparison, same machine on AC, same 10 real windows, 12 threads, 1 warm-up:**

| | groth16_60 witness p50/p95 | groth16_60 prove p50/p95 | groth16_30 witness p50/p95 | groth16_30 prove p50/p95 | verify (VerifierPool) p50/p95 |
|---|---|---|---|---|---|
| Node 22 (bot worker_thread) | 79 / 87 ms | **1,187 / 1,241 ms** | 59 / 61 ms | **795 / 852 ms** | 6.2 / 7.4 ms |
| Chrome 155 (Proof Worker) | 62 / 120 ms | **1,419 / 1,480 ms** | 44 / 92 ms | **891 / 906 ms** | — |

  Node is ≈ 1.1–1.2× **faster** than Chrome; prove ÷ play time in Chrome is 1.42× at N=60 and 1.78× at N=30. Verify meets NFR-4 with a large margin on AC (p95 7.4 ms).

#### Exit check — Phase 3 (AC power, production perf build, **worst case: both players on one laptop**, two Chrome windows each running a 12-thread prover on the same 8C/12T CPU, server on the same machine)
`npm run perf:match -- --acc 1800 --stop-after 180 --miss 300`:

| Check | Result |
|---|---|
| Clean 3-minute match: every challenge valid | ✅ 181 s of play (ended by the scripted forfeit at 3:00), 180 windows per player; spot-checks **64/64** passed per player |
| Full audit, every window valid → `audited_clean` | ✅ 180/180 valid per player, `audited_clean`, not overturned; audit **242 s** (p0 241.9 s, p1 242.9 s, 116–117 windows audited per player) |
| Frame time p95 < 20 ms while proving | ✅ frame interval p95 **7.1 ms** in every 20 s sample (p50 6.9 ms, ≈ 144 Hz display; max 181 ms single spike), per-frame work p95 0.7–0.9 ms |
| Scripted cheater never `audited_clean` | ✅ integration (speed + hidden ammo refill) |
| Frame inspector: no hidden state on the wire | ✅ integration |

- Challenge rate **r = 0.356** (64 challenges / 180 windows) in this worst-case setup; live challenge prove (client-reported) mean 2.19–2.22 s, p95 2.77–2.78 s (vs 1.42 s alone — two provers share the CPU); witness ≈ 80–120 ms; warm-up proof 2.7–2.9 s during the countdown; server verify mean 21.5–39.4 ms.
- Earlier run with the same command without `--miss` (natural end after 115 s, 116 windows/player): also `audited_clean`, 42/42 spot-checks, r = 0.362, audit 157 s, frame p95 7.1 ms.

#### Test runs (AC power, final)
- `npm test`: 238/238 (unit + circuit, incl. `ammoSafety`); `npm run circuits:lint`: circomspect clean; typecheck, ESLint, Prettier clean.
- `npm run test:int`: **22/22** (289 s) — Phase 1: 10 concurrent bot matches, 0 desync, 16,360 frames inspected, server tick p99 1.51 ms; Phase 3 (N=4): clean → `audited_clean` (r = 0.27, audit 25 s), speed cheater (cheater lost) → `audited_failed`, not overturned; ammo cheater (cheater won) → `audited_failed`, overturned; all protocol scenarios; VerifierPool verify p50 9.5 / p95 12.8 ms under test load (n = 390).
- First full run: 21/22 — the reconnect scenario waited for a round to pass tick 40, but with that seed every round ended at tick 36 (the earliest possible). Drop point changed to tick 20 (always reachable); then 4/4 and 22/22.
- `npm run e2e:audit-reload`: PASS (see above).

#### Deviations / decisions to confirm
- `RATE_LIMIT_COMMITS_PER_S = 20` (new constant; `window_commit` has its own budget — at N=4 a client commits 15 windows/s).
- `window_commit` has no `matchId` (as specified); after `match_end` it is routed to the player's most recent room still auditing.
- Live late snapshots of a round that arrive after the **next** round started are lost (the protocol's snapshots carry no round number); honest RTT is far below the 1.5 s pause.
- Each challenge proof is retried after a reconnect only if the server still lists it (`resume.challenge`); audit proofs lost on a dead socket are re-proven on reconnect.
- `witnessMs` reported by the live client now includes building the circuit input (digest chain) in the worker.
- Dev-only URL params (`vite dev` builds only): `?bot=<seed>&acc=<jitter>&threads=<n>&stopAfter=<s>`.
- At N=4 the commit deadline is one window = 67 ms (as specified); integration tests on a loaded machine are timing-sensitive because of it.
- Research metric "live detection latency" column exists but stays NULL until `cheat_events` (Phase 4); benchmark export of the metrics is Phase 5.

### Phase 3 design change — commit every window, prove on challenge, audit after the match — 2026-10-10
Decided by the owner after the Phase 2 performance preview (options (a) then (d)). Recorded before any Phase 3 code. Docs changed: ARCHITECTURE §1/§2/§4/§5.3/§6/§7/§9, API_SPEC §3/§4/§5, PRD G2/G4/§5/FR-13–FR-18/FR-20/FR-22/§8, FEATURES F9–F14, DATABASE_SCHEMA, SECURITY §6/§7 (A3, A7, new A15–A17, new §7.3), UI_UX §2/§3.3/§3.4, USER_FLOWS 3–6, TESTING §2/§4/§5, ENVIRONMENT, TODO.

1. **Commit every window.** At the end of each window the client sends `window_commit{roundNo, windowIndex, commitOut}`; the server stores it as the claimed commitment (`committed`). Missing by the end of the next window → `missing_commit`, rest of the round `chain_broken`.
2. **Challenges.** One outstanding challenge per player; drawn uniformly with `crypto.randomInt` among the player's ended, digest-final, still-`committed` windows of the current round; `challenge{playerIndex, roundNo, windowIndex, deadlineMs}` with `deadlineMs = PROOF_DEADLINE_MS`.
3. **Proving a challenged window** against the claimed commitments: `commitIn` = claimed `commitOut_{k−1}` (or `initialCommit`), `commitOut` = claimed `commitOut_k`; a different `commitOut` → `mismatch_commit`. Every window's private input stays in client memory (and the dev tick log) until the audit ends.
4. **Statuses:** `committed`, `valid`, `invalid`, `mismatch_bind`, `mismatch_digest`, `mismatch_commit`, `missing_commit`, `unprovable`, `timeout` (challenge deadline), `chain_broken`, `malformed`, plus `unaudited` (audit closed). DB CHECK updated.
5. **Post-match audit:** the client proves every remaining committed window; the server accepts audit proofs for `AUDIT_TIMEOUT_MIN`; `matches.audit_status` = `audited_clean` / `audited_failed` / `audit_incomplete`.
6. **Enforcement:** `strict` forfeits on the first live failure; an audit failure sets `overturned` without rewriting history.
7. **HUD:** hollow = committed, ◌ = challenged/proving, ✓, ✕, ⛓; "Spot-checks: 7/7 passed".
8. **Research metrics per match:** challenge count, challenge rate r, live detection latency, audit duration (results screen; benchmark export in Phase 5).
9. **SECURITY §7.3:** why challenges must be unpredictable, why commit-every-window prevents rewriting history, live detection probability 1 − (1 − r)^m, the audit is the full guarantee.

**Decisions taken while writing the design down (please confirm):**
- `PROOF_DEADLINE_MS` default **15 000 ms** (owner's value). After Step 1 I first lowered it to 10 000 (≈ 6× the single-client prove p95); the first browser exit-check run then showed that two clients proving on one laptop need 8–9 s per challenge and that the cold first proof exceeded 10 s → both players' first challenge timed out. Reverted to 15 000, and the worker now runs one warm-up proof during the countdown. `AUDIT_TIMEOUT_MIN` = 30. Both live in `shared/constants.ts` (rule 1) with server env overrides.
- **Only `missing_commit` breaks the chain.** A failed window does not: claimed commitments are immutable, so no rewind is possible, and later windows are still checked against the claims. (Before: the first non-valid result broke the chain.)
- **`strict` forfeits on a failed challenge *or* a `missing_commit`** (both are live failures).
- **`overturned` = the winner's audit failed.** A loser who cheated makes the match `audited_failed` but the result is not "overturned". Literal alternative: any audit failure → overturned.
- **`window_proof` / `proof_failed` gain `matchId`** so audit proofs after `match_end` (and after a reconnect) are routed unambiguously, even if the player is already in the lobby.
- **`challenge` is broadcast** (with `playerIndex`) so the opponent's strip shows ◌ too; `proof_result` gains `phase: 'live' | 'audit'` and is also sent for `committed`; new `audit_end`; `resume` gains `committed[]` and `challenge`; `match_end` gains `auditTimeoutMs`; `match_found` gains `variant`.
- **Disconnects:** windows from the first tick the server did not receive become `chain_broken` (not a failure — they contain held values the client never played), so a reconnect makes that round `audit_incomplete` at best. A cheater can use this to turn "failed" into "incomplete" for one round (SECURITY A16).
- **G4 / FR-20 / §8 reworded:** "non-valid within 3 windows" is no longer a property of the system; the guarantee is "never `audited_clean`", with the live detection probability measured.
- **Residual predictability (SECURITY A15):** the first window of a round can be the only candidate (certain challenge); windows late in a round face fewer draws. Implemented as specified; documented and measured, not fixed.

#### Step 1 — browser proving measured (before the redesign was coded) — ⚠ power state not recorded; superseded by the AC table in "Phase 3 findings"
Chrome 154 (Playwright, headed, tab visible), Intel Core 5 210H (8C/12T), `client/bench.html` → Proof Worker, 10 real windows from the Phase 1 fixture logs + 1 warm-up per setting, synthetic arena rendering on the main thread. All public signals equal the JS reference.

| Variant | snarkjs threads | witness p50/p95 | prove p50/p95 | prove ÷ play | frame interval while proving p50/p95/max |
|---|---|---|---|---|---|
| groth16_60 | 12 (default = hardwareConcurrency) | 75 / 128 ms | 1,579 / 1,732 ms | 1.6× | 6.9 / 7.1 / 8 ms |
| groth16_60 | 8 | 68 / 96 | 1,555 / 1,739 | 1.6× | 6.9 / 7.1 / 9 |
| groth16_60 | 4 | 76 / 146 | 2,019 / 2,189 | 2.0× | 6.9 / 7.1 / 9 |
| groth16_60 | 2 | 73 / 97 | 3,098 / 3,164 | 3.1× | 6.9 / 7.1 / 9 |
| groth16_60 | single | 73 / 131 | 5,628 / 6,572 | 5.6× | 6.9 / 7.1 / 8 |
| groth16_30 | 12 (default) | 52 / 79 | 1,014 / 1,081 | 2.0× | 6.9 / 7.1 / 8 |
| groth16_30 | 8 | 47 / 65 | 1,010 / 1,085 | 2.0× | 6.9 / 7.1 / 8 |
| groth16_30 | 4 | 50 / 83 | 1,347 / 1,429 | 2.7× | 6.9 / 7.1 / 8 |
| groth16_30 | 2 | 44 / 69 | 2,092 / 2,225 | 4.2× | 6.9 / 7.1 / 8 |
| groth16_30 | single | 41 / 53 | 3,574 / 3,958 | 7.1× | 6.9 / 7.1 / 8 |

- Idle frame interval p95 was 7.0–7.1 ms in every run: proving in the worker does not affect main-thread frame time at any thread setting, so threads are **not** capped (capping only slows proving).
- Browser proving is ≈ 3× faster than the Phase 2 Node preview (4.8 s at N=60), but still slower than real time (1.6× at N=60) — proving every window live remains infeasible on this laptop.
- New variant **groth16_30**: 16,968 constraints, ptau power 15, zkeySha256 `c2f21eb60a3baf8d10ba6e8a55f8b4b94f227f0b092d398ce87fd4d3829144fc`, zkey 18.84 MiB; `publicSignalOrder` `[commitOut, bind, digest, commitIn]` (unchanged). Circuit unchanged → groth16_4/60 constraint counts unchanged.
- Tooling: `client/bench.html` + `src/bench/proveBench.ts` (dev page), `npm run perf:prove` (Playwright driver); Vite dev middleware serves `/zk/<variant>/{window.wasm,window_final.zkey,info.json}` and `/__dev/fixtures/`; Vite aliases `circomlibjs` to its `poseidon_wasm.js` (the package index pulls in blake-hash/Buffer, which breaks in browsers).

#### "ammo < MAG" as "ammo ≠ MAG" — checked, safe, no circuit change
`circuits/test/ammoSafety.test.ts` (5 tests): `WeaponStep`'s equations transcribed literally in F_p; BFS from (MAG, 0, 0) gives **1,571 reachable hidden states**, closed under the circuit relation and bounded (ammo ∈ [0, 10], cooldown ∈ [0, 11], reloadT ∈ [0, 90]); on all of them the circuit relation equals `stepWeapon` ("<") for all 4 inputs; the compiled template agrees with the transcription on every reachable (state, input); window 0 opening `initialCommit` forces (MAG, 0, 0). So "≠" is safe for every window whose `commitIn` traces back to `initialCommit` through verified windows. The test also shows why that hypothesis matters under spot-checks: a window whose `commitIn` is only *claimed* can start from ammo = 1000 and still verify — only the window that produced the claim (or the audit) exposes it. A range check would not change that (a cheater would claim a legal-looking refilled magazine instead), so the circuit was not rebuilt.

### Phase 2 — Circuit (offline) — 2026-10-09
#### Added
- `circuits/src/*.circom` templates (`InRange`, `BoundsCheck`, `SpeedCheck`, `TurnCheck`, `WeaponStep`, `DigestChain`, `Commit`, `Bind`) and `circuits/window.circom` (`Window`). `circuits/scripts/gen-main.ts` generates `main_<N>.circom` from `shared/constants.ts` (no game numbers in .circom sources).
- `shared/zkInput.ts`: JS reference — circuit input object, expected `bind`/`digest`/`commitIn`/`commitOut`, log → window slicing (truncate + pad, hidden-state and salt chaining, per-round reset), `randomSalt()` (248 bits), `namePublicSignals()` (order from info.json).
- `circuits/scripts/build.ts` (`npm run circuits:build`), `prove-log.ts` (`npm run circuits:prove-log`), `mutate-log.ts` (`npm run circuits:mutate-log`); `npm run circuits:lint` (circomspect on main_4 + main_60, CI gate).
- Tests: 19 template tests, 17 Window(N=4) tests (all real-log windows, TESTING §3 table, malicious helper witness, 150 random legal sequences, 1,000 random mutations), 5 offline tests (3 cheats on real logs at N=4, N=60 smoke over every real window, groth16_60 prove/verify + publicSignalOrder), zkInput unit tests. Fixture logs: `circuits/test/fixtures/` (2 Phase 1 bot matches through the real server, both players).

#### Circuit
- **groth16_4**: 3,292 constraints; ptau power 12 (`powersOfTau28_hez_final_12.ptau`, sha256 `dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17`); zkeySha256 `0ae419920ef42b1d3f9e0e39df76e4759bf163d47ce0928842e46ccb66a793ee`; zkey 3.78 MiB.
- **groth16_60**: 32,748 constraints (~537/tick), 493 private inputs, 31,502 wires; ptau power 15 (`powersOfTau28_hez_final_15.ptau`, sha256 `3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f`); zkeySha256 `d49f56bb0795e0be41e2209ead25b719a3c1cdd1bea6c31cc5749d31ca45b93f`; zkey 34.83 MiB; wasm 2.9 MB; proof ≈ 724 B.
- **publicSignalOrder** (both): `[commitOut, bind, digest, commitIn]` — detected from a real proof at build time. First circuit release, so no previous order to compare.
- Setup: single local phase-2 contribution (SECURITY A8). Both ptau files blake2b-verified against the snarkjs README.
- The power-16 ptau downloaded in Phase 0 is not used (15 suffices for N=60).

#### Results
- Real logs, N=60, Node: **26/26 windows** of 4 logs prove + verify, and named public signals equal the JS values for every window.
- Mutated logs (from `match-bffb33a1-p1`): speed (tick 136) → only window 2 has no witness (`SpeedCheck`/`Num2Bits`); rapid-fire (tick 203) → only window 3 (`WeaponStep` cooldown legality); infinite ammo (tick 202) → only window 3 (`WeaponStep` ammo transition). All other windows still verify.
- Mutation property (N=4, 1,000 runs): 935 rejected by both circuit and sim, 65 accepted by both, **0 disagreements**.
- circomspect 0.9.0: no findings (gate verified to exit 1 on a planted under-constrained signal).

#### Performance preview (Node, not the official benchmark) — Intel Core 5 210H (8C/12T), 15.6 GB, Node 22.23.3, snarkjs 0.7.6, groth16_60, 26 windows
- witness p50 303 ms / p95 352 ms; **prove p50 4,840 ms / p95 6,067 ms** (min 1,911, max 7,125); verify p50 36 ms / p95 54 ms; proof ≈ 724 B; zkey 34.8 MiB.
- Prove time is ≈ 4.8× the window's 1 s of play → proving every window live is not feasible in Node on this laptop (browser is usually slower). See the Phase 3 decision in TODO.
- Verify p95 (54 ms) is slightly above NFR-4 (< 50 ms); measured in the same process right after proving — to be re-measured in the server's verifier pool in Phase 3.

#### Deviations from the docs
- `turnD` is computed in-circuit (`<==` from the helper `k`) instead of being a prover input; `k` is the only hand-written `<--`. No selector witness for the min(): two exclusive comparators must sum to 1.
- `Window` lives in `circuits/window.circom` (per ARCHITECTURE), the sub-templates in `circuits/src/`.
- "ammo < MAG" in W4 is implemented as "ammo ≠ MAG" (identical on reachable states — documented in the template).
- Circuits compiled with `--O2` (removes all linear constraints: N=4 7,432 → 3,292).
- TESTING §3 mutation property clarified: an ignored `reloadPress` is a legitimate no-op witness.

### Phase 1 follow-ups — 2026-10-09
- **Late snapshots bounded:** accepted up to `PROOF_GRACE_WINDOWS × WINDOW_TICKS` ticks behind the server's wall tick; older → rejected + strike (`strike_late`). Boundary unit test (exactly at the bound → ok, one past → strike). SECURITY §4 updated.
- **Phase 3 rule written down** (ARCHITECTURE §4, TODO Phase 3): a window's digest is finalised only when its last tick's snapshot has arrived or the grace deadline has passed, so a late honest snapshot never causes `mismatch_digest`.
- **Integration stress:** `npm run test:int` ×10 in a row — 10/10 passed (150/150 tests), 24–57 s per run; full output in `server/data/test-reports/int-stress.txt`.
- **Renderer seam for the future 3D renderer:** `client/src/game/view.ts` — `FrameBuilder.build(now)` → `RenderFrame` (plain, already interpolated) → `GameRenderer.draw(frame)`. Canvas 2D renderer reimplemented behind it (`createRenderer`); tracers/flash bookkeeping moved out of the renderer. ESLint `no-restricted-imports` forbids renderer files from importing sim, protocol, session, input, bot, net or api. TODO Phase 6: "3D renderer (Three.js), 2D rules unchanged".
- Accepted by owner: client-written private logs (deviation 1) and dev-only `?bot=` (deviation 6).

### Phase 1 — Playable game, no ZK — 2026-10-09
#### Added
- `shared/sim.ts`: integer rules exactly per ARCHITECTURE §3 (movement, aim, weapon table W1–W5), `checkTick`/`checkSequence` (JS mirror of the circuit's per-tick constraints), `holdTick` (gap fill / padding), `truncateAndPad` + public variant (round-end window), `TickRecord` = WindowRecorder shape (public + private per tick), FNV state hash.
- `shared/trig.ts` integer sin/cos table (scale 1024; test proves no entry sits on a rounding boundary → engine-independent). `shared/poseidon.ts` (circomlibjs; matches the reference vector Poseidon([1,2])), `shared/matchField.ts`, `shared/ticklog.ts` (JSONL log format), `shared/rng.ts`.
- Server: Fastify 5 + helmet CSP + CORS + rate limits; zod-validated env; SQLite migration `001_init` (players, sessions, matches incl. `end_reason 'forfeit'`, match_players, rounds); guest JWT auth with revocable `jti`; REST `/api/health`, `/api/auth/guest`, `/api/auth/logout`, `/api/circuit/info` (all constants + `constantsHash`), `/api/matches/:id` (participants only).
- WS gateway: Origin check, hello-within-5 s, strikes → 4400, rate limits → 4429, one socket per player → 4409, `VERSION_MISMATCH` on constants-hash mismatch, maxPayload 64 KB.
- `MatchRoom`: snapshot-driven tick processing (both snapshots in, or leader ≥ `STALL_TICKS` ahead → hold, `stalled`), integer ray-vs-circle hits, simultaneous-lethal tie rule, rounds with `endTick` + `prevSnapshot` + `initialCommit` in `round_end`, `ROUND_PAUSE_TICKS` pause, best-of-5, forfeit, disconnect/silence > 10 s → forfeit, ready timeout → abort. Fixed-step 60 Hz wall loop (performance.now accumulator). Server snapshot logs (`LOG_SNAPSHOTS`).
- Client (vanilla TS + Canvas): DOM-free `GameSession` (local sim, recorder, local gap fill identical to the server's hold, desync counter) shared with the Node bots; keyboard + pointer-lock input with queued turn (never loses mouse input to the MAX_TURN clamp); renderer (5:3 letterbox, grid, aim line, tracers, hit flash); landing, queue, match HUD, results screens; settings overlay (sensitivity, forfeit); debug overlay; dev-only tick-log download.
- Tooling: `npm run dev`, `dev:lan`, `db:migrate`, `bots`, `perf:frame` (Playwright + installed Chrome), `test:int`.
- Tests: 144 unit (sim every W-row, trig, poseidon, matchField, protocol, hit detection, JWT, MatchRoom with fake clock, client interp/frame stats) + 15 integration (10 concurrent bot best-of-5 matches; handshake/auth/origin/strikes/rate limits/fuzz/queue/REST/CSP).

#### Measured
- 10 concurrent bot matches (20 bot clients + server in one process): all ended by rounds, 0 desync ticks, client logs pass `checkSequence` for every round, server log values = client values for every tick, 0 hidden keys in 15,950 client→server frames (wire keys: `angle, artefactSha256, clientVersion, constantsHash, fired, t, tick, token, x, y`).
- Server tick processing (same run): p50 0.14 ms, p95 0.36 ms, p99 0.54 ms, max 2.3 ms (n = 7,944). Across all runs today p99 ranged 0.54–0.80 ms; max ranged 2.3–6.6 ms (single outliers, likely GC). NFR-1 (< 2 ms) holds at p99, not for every single tick.
- Client frame time, real Chrome 154, two bot-driven pages, 1366×768: headed — frame interval p50 7.0 ms, p95 13.8 ms, max 48.8 ms (≈ 135 fps, display-limited), per-frame work p50 0.3 ms, p95 1.0–1.3 ms; headless — interval p95 7.2 ms, work p95 1.4 ms.

#### Fixed (found by tests during the phase)
- `totalTicks` double-counted the final round when a match ended by rounds.
- Debug overlay sorted 3,600 samples per frame (work p50 3.8 ms → 0.3 ms after throttling to 4 Hz).
- `FrameStats` ignored a frame timestamp of 0.
- Poseidon is now built at server boot; a cold build inside the first `match_found` caused one intermittent integration-test timeout under load.

#### Deviations / decisions to confirm
- `LOG_SNAPSHOTS` cannot contain private state (the server never sees it). Server logs stay public-only; logs with private state are written client-side (bots → `server/data/logs/clients/`, browser → `VITE_LOG_TICKS` download). New env var `VITE_LOG_TICKS`.
- `VITE_API_URL` / `VITE_WS_URL` empty by default → derived from the page's host (LAN works without edits).
- `ready.artefactSha256` is not checked yet (no zkey until Phase 3); clients send 64 zeros; matches store `circuit_hash = 'none'`.
- Snapshot tick bound: only ticks from the future (> server tick + `STALL_TICKS`) are rejected (strike). Late ticks are accepted, so the SECURITY §4 "±6" lower bound is not enforced: rejecting late snapshots would drop honest data at RTT > 100 ms.
- Reconnect into a running match is Phase 3; in Phase 1 a dropped player forfeits after 10 s.
- Dev-only `?bot=<seed>` URL parameter (only in `vite dev` builds) lets a browser tab play itself, for frame-time measurement.
- `room_join` replies `FORBIDDEN` until Phase 4; `window_proof`/`proof_failed` are accepted and ignored until Phase 3.

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
