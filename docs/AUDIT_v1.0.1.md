# AUDIT v1.0.1 — debugging & cleanup pass (Phase A: audit only)

Branch `cleanup/v1.0.1` from `main` @ `6360965` (= v1.0.0 code + a `.gitignore` change). Audit run 2026-10-16.
**No code was changed in Phase A.** Temporary files used for checks (a scripts tsconfig, a type-aware ESLint config, a diagnostic copy of one integration test) were deleted again; `git status` is clean apart from this file.

Risk legend: **safe** = no effect on game behaviour, circuit, proofs or measured results · **needs care** = needs your decision or touches something sensitive · **do not touch** = false positive, intentional, or outside the cleanup rules.
Status column is filled in during Phase B.

## Environment notes (affect how results were obtained)

- The non-interactive shell resolves `node` to the **system Node v24.17.0** (`C:\Program Files\nodejs`), not fnm's default **v22.23.3** (fnm is not initialised there). `engines` is `>=22.12 <23`, `.node-version` is `22`, `engine-strict=true`. Typecheck, lint, knip, depcheck, unit/circuit tests, coverage and the first integration run ran on Node 24; the failing integration file was re-run on Node 22 (same failure); `perf:serve` + the bot match ran on Node 22.
- On AC power, "Performance" plan, but **~31 % CPU load before any test started** (several Chrome processes, VPN client, etc.).

## Commands run and results (baseline, before any fix)

| Check | Result |
|---|---|
| `npm run typecheck` (5 workspaces) | clean |
| `npm run lint` | clean |
| `tsc --noUnusedLocals --noUnusedParameters` (5 workspaces + `client/scripts` via a scratch tsconfig) | clean, 0 findings |
| `npm run format:check` | clean |
| type-aware ESLint (`no-floating-promises`, `no-misused-promises`), one-off | 0 findings (all fire-and-forget calls are explicit `void`) |
| `npx knip` | 4 unused files, 2+1 unused deps, 78 unlisted deps, 18 unused exports, 31 unused exported types — every hit cross-checked with grep below |
| `npx depcheck` per workspace | `@fastify/static`, `pino` unused (server); `circomlib` (circuits), `fast-check` (root) false positives; `zod` missing in server |
| `npm ls` | only `ws@8.22.0` / `underscore@1.13.8` "invalid" — the intentional `overrides` |
| `npm audit --omit=dev` | 15 low, all one advisory (elliptic GHSA-848j-6mx2-7j84 via circomlibjs → ethers 5); 0 high/critical |
| `npm test` (unit + circuits) | **366 / 366 passed** (24 files, 53 s) |
| `npm run test:int` | **27 / 28 passed, 1 failed** (`phase4.test.ts` "audit policy gap"; afterAll hook timeout as a follow-on), 559 s — see E1 |
| `npm run test:e2e` | **broken** — "No tests found" (see E2) |
| unit coverage (`vitest --project unit --coverage`) | lines 55.7 %, statements 54.0 %, branches 50.0 % (unit project only) — see T1/T2 |
| `circomspect` on `circuits/window.circom` | 1 warning: `Window` takes too many parameters (style) — see S10 |
| `npm run circuits:lint` (the CI gate, `main_4` + `main_60`) | No issues found |
| Runtime: `npm run perf:serve` + `npm run perf:match -- --acc 1800 --miss 300 --stop-after 60` (2 Chrome windows, bots 11/22) | **`audited_clean`**, 60/60 windows valid per player, 22/22 spot-checks passed, frame p95 7.3 ms; 1 console error (404, see S9); server log: 0 warnings / errors |

## Findings

| ID | Category | File:line | What | Proposed fix | Risk | Status |
|---|---|---|---|---|---|---|
| E1 | error | `server/test/int/phase4.test.ts:123-168` | "audit policy gap" test fails reproducibly here (2 runs on Node 24, 1 on Node 22; independent of bot seeds). The loser must prove 41 audit windows within `AUDIT_TIMEOUT_MIN: '0.25'` (15 s). Measured: N=4 Node prove p50 444 ms / max 693 ms, proofs arrive every ~520 ms → only 29–34 accepted, 11–12 end `unaudited` → loser `audit_incomplete` instead of `audited_clean`. Rate limit (4 proofs/s) alone needs ≥ 11.25 s, so the 15 s budget leaves no margin on a loaded machine. Same code recorded 28/28 on 2026-10-12. Not a game/server logic bug. | Re-run with Chrome closed to confirm. Then test-only fix: raise this test's `AUDIT_TIMEOUT_MIN` to `'0.5'` (30 s) — assertions unchanged. | needs care | |
| E2 | error | `package.json` (`test:e2e`) | `playwright test` has no `playwright.config.*` and no Playwright specs; it collects the Vitest `*.test.ts` files and crashes ("No tests found"). The real E2E runs are tsx scripts (`e2e:cheats`, `e2e:audit-reload`, `perf:match`). | Remove the broken `test:e2e` script and point the docs (M4) to the existing E2E scripts. Alternative: keep the name and make it print the E2E commands. | safe | |
| E3 | error | `server/src/match/manager.ts:102`, `:180` | `void this.tryPair()` / `void this.createRoom(...).finally(...)` — no rejection handler. If `createRoom` throws (DB error, Poseidon init), Node's default `unhandled-rejection=throw` kills the server and every running match. | Regression test first (repo whose `createMatch` throws → server stays up, both players get `error INTERNAL`), then `.catch` → log + `error INTERNAL` to both players. Happy path unchanged. | safe | |
| E4 | error | `server/src/log/snapshotLog.ts:23` | `createWriteStream` without an `'error'` listener: a disk error while `LOG_SNAPSHOTS=true` crashes the server (dev/bench only). | Regression test (stream error → no throw), then `stream.on('error', …)` logging once and turning the log into a no-op. | safe | |
| E5 | error | `server/src/zk/verifierPool.ts:60-76` | `ready()` waits on each *original* worker's `ready` message. If a worker dies before it is ready, `replace()` swaps in a new slot and `ready()` never resolves → boot hangs instead of failing. | Re-check `this.slots[i]` in a loop (or resolve on the replacement's ready). Verification infrastructure — no effect on proofs, but timing-sensitive. | needs care | |
| D1 | dead code | `bench/tables.ts`, `server/scripts/detection-report.ts`, `server/scripts/prove-profile.ts`, `server/scripts/zk-node-bench.ts` | knip "unused files": false positives — documented tools run with `npx tsx` (README, RESULTS.md, CHANGELOG). | none (optionally S11: knip config with these entries) | do not touch | |
| D2 | dead code | `client/src/game/input.ts:12`, `renderer.ts:19`, `renderer3d.ts:69`, `renderer3dCamera.ts:14-15`, `session.ts:23`, `client/src/ui/proofStrip.ts:11`, `server/src/app.ts:22`, `config.ts:17`, `ws/gateway.ts:26`, `zk/tracker.ts:147` | `export` on values used only inside their own module (`DEFAULT_SENSITIVITY`, `Canvas2DRenderer`, `ThreeRenderer`, `OVERVIEW_TILT_DEG`, `EYE_H`, `MS_PER_TICK`, `STRIP_CELLS`, `SERVER_VERSION`, `EXAMPLE_JWT_SECRET`, `CLOSE`, `isFailure`). No code is dead. The same hits in test support (`circuits/test/helpers.ts`, `server/test/support/botClient.ts`) and bench (`server/scripts/detection.ts`) are left alone. | Drop the `export` keyword (app modules only). | safe | |
| D3 | dead code | 31 exported types/interfaces (knip list) | Exported but not imported elsewhere (e.g. `RoomOptions`, `TrackerDeps`, `SessionOptions`). They document module contracts. | none | do not touch | |
| D4 | dead code | `client/src/env.ts:10` | `ENV.DEV_CHEATS` is never read (`main.ts:37` uses `import.meta.env.VITE_DEV_CHEATS` directly so Vite can drop the cheat modules). Not cheat-panel code itself. | Remove the unused field. | safe | |
| D5 | dead code | `server/src/config.ts:59` | `SERVE_CLIENT` is parsed/validated but never read; documented as "serve the built client + `/zk` from Fastify static" — not implemented (`/zk` is served by Vite in dev/preview, by Caddy in the deployment design). | Your call: (a) remove `SERVE_CLIENT` + `@fastify/static` (U1) and the doc rows (M3), or (b) keep as documented future work (mark "not implemented"). Implementing it is feature work (out of scope). | needs care | |
| U1 | unused dep | `server/package.json:17` | `@fastify/static` is never imported (see D5). | Remove (with your approval; tied to D5). | needs care | |
| U2 | unused dep | `server/package.json:22` | `pino` is never imported; Fastify brings its own pino (`LOG_LEVEL` keeps working). | Remove (with your approval); TECH_STACK row → "via Fastify". | needs care | |
| U3 | unused dep | `circuits/package.json` (`circomlib`) | knip/depcheck false positive: used by circom `include "circomlib/…"` in `circuits/src/*.circom`. | none | do not touch | |
| U4 | unused dep | root `package.json` (`fast-check`) | depcheck false positive: used by `shared/sim.test.ts`, `circuits/test/window.test.ts` through hoisting. | none | do not touch | |
| U5 | unused dep | `client`, `server`, `circuits`, `bench` `package.json`; `server/src/config.ts:6` | Undeclared deps: `@zkduel/shared` imported by 4 workspaces but listed nowhere (works via the hoisted workspace symlink); `zod` imported by the server but declared only in `shared`. | Declare `"@zkduel/shared": "0.1.0"` where used and `"zod": "3.25.76"` in server. Changes `package-lock.json`; `npm install` must run under Node 22 (engine-strict). | needs care | |
| U6 | unused dep | `npm ls` (`ws`, `underscore`) | Reported "invalid" because of the intentional security `overrides` (CHANGELOG). | none | do not touch | |
| S1 | smell | `client/src/game/session.ts:23`, `server/src/match/matchRoom.ts:107` (+ list) | Rule 1: `MS_PER_TICK = 1000 / TICK_RATE` is defined twice. Other module-local numbers not in `shared/constants.ts` and not recorded as accepted in CHANGELOG: render/UI tuning (`renderer*.ts` GRID/WALL_H/…, `view.ts:49-50`, `matchScreen.ts:18-20`, `benchPage.ts:35-36`, `proofStrip.ts:11`), `socket.ts:5` PING_EVERY_MS, `input.ts:12-14`, `repo.ts:8` SESSION_RETENTION_MS, `loop.ts:7` MAX_CATCH_UP_STEPS, `config.ts:51-52` env defaults. | Move `MS_PER_TICK` (and optionally PING_EVERY_MS, SESSION_RETENTION_MS) into `shared/constants.ts` **outside the `CONSTANTS` object** (like `BENCH_*`, so `constantsHash` and `info.json` stay unchanged); record in CHANGELOG that render/UI tuning stays local. | needs care | |
| S2 | smell | all `package.json` `version`, `server/src/app.ts:22`, `client/src/net/socket.ts:18` | Versions say `0.1.0`; release is v1.0.0. `clientVersion` is a hard-coded literal. Informational only (version gating uses `constantsHash`; not in bench rows or DB). | Bump to `1.0.1`; read `SERVER_VERSION` / `clientVersion` from one source. | safe | |
| S3 | smell | `client/src/game/view.ts:8` | Stale comment: "a Three.js one (TODO Phase 6)" — `renderer3d.ts` shipped in Phase 4.5. | Reword comment. | safe | |
| S4 | smell | `shared/protocol.ts:101-103` | Stale comment: "'forfeit' is not yet in DATABASE_SCHEMA — flagged for decision"; it is in the doc and in `001_init.sql:32`. Comment only (protocol.ts is not circuit input). | Reword comment. | safe | |
| S5 | smell | `server/src/match/matchRoom.ts:208` | `createdAt: Date.now()` bypasses the injected `deps.epoch` (line 253 uses it). Identical in production; inconsistent for tests. | `(this.deps.epoch ?? Date.now)()`. | safe | |
| S6 | smell | environment | Node 24 on PATH vs required 22 (see Environment notes); `npm dedupe --dry-run` fails with EBADENGINE. Not a code issue. | README note: initialise fnm in the PowerShell profile (`fnm env --use-on-cd \| Out-String \| Invoke-Expression`), or remove the system Node 24. | do not touch | |
| S7 | smell | `client/tsconfig.json` (`include`) | `client/scripts/*.ts` (8 Playwright/perf/bench scripts) are in no tsconfig, so `npm run typecheck` / CI never typecheck them. They pass today with a scratch config. | Add `client/tsconfig.scripts.json` and run it from the client `typecheck` script. | safe | |
| S8 | smell | `client/index.html`, `client/bench.html` | No favicon → `/favicon.ico` 404 logged as a console error on every page load (the 1 error in the runtime check). | `<link rel="icon" href="data:,">`. | safe | |
| S9 | smell | repo root | No knip config, so every knip run reports the D1/U3/U4 false positives and 78 "unlisted" workspace imports. | Optional `knip.json` (no new dependency) with the tsx entry points. Adds a file — your call. | safe | |
| S10 | smell | `circuits/window.circom:16` | circomspect (direct run): `Window` takes too many parameters — style only, not under-constraint. CI gate on `main_4` / `main_60` is clean. | Report only. | do not touch | |
| X1 | security | `client/vite.config.ts:87` | `server.fs.allow: ['..']` exposes the whole repo via `/@fs/…` on the dev server, which `npm run dev:lan` binds to the LAN. Vite's default deny list blocks `.env*`, but e.g. `server/data/zkduel.db` and `server/data/logs/*` are readable by LAN peers in dev. | Narrow `fs.allow` to the folders the client imports (`../shared`, `../node_modules`, …) and test `dev`, `dev:lan`, `/bench.html` fixtures. | needs care | |
| X2 | security | `npm audit --omit=dev` | 15 low: elliptic GHSA-848j-6mx2-7j84 via circomlibjs → ethers 5 (the Poseidon dependency). No fix without replacing circomlibjs. CI gate (high/critical) passes. | Report only. | do not touch | |
| T1 | test gap | `client/src/game/input.ts` (14.9 %), `bot.ts` (0 %), `tickLog.ts` (0 %), `session.ts` (76.8 %), `server/src/match/stats.ts` (45.5 %) | Below TESTING §1 targets (client game logic ≥ 80 %, server match ≥ 85 %) in the unit project. | Add unit tests for the pure parts: `stats.ts`, `tickLog.ts`, input key mapping. Tests only. | safe | |
| T2 | test gap | `server/src/match/manager.ts`, `loop.ts`, `zk/verifierPool.ts`, `zk/variant.ts` (0 % unit) | Exercised by the integration suite, but coverage is collected for the unit project only, so the TESTING target can't be checked. | Collect coverage over unit + integration for the server targets (slow run; config change only). | needs care | |
| M1 | doc mismatch | `docs/DEPLOYMENT.md:9-10,46,122` + §5 | `npm run circuits:build:all` and `npm run build` don't exist; `server/dist/` is never produced (server runs via tsx); CI does not publish zkeys as a release asset; no `Dockerfile`, `Caddyfile`, `circuits.yml` or `release.yml` exist (only `ci.yml`). | Fix the LAN-path commands (`circuits:build -- --all`, no build step); mark the VM/Docker/release sections as design, not implemented in v1.0.x. | safe | |
| M2 | doc mismatch | `docs/ENVIRONMENT.md:103-104` | `circuits:build:all` doesn't exist (→ `circuits:build -- --all`); default `circuits:build` builds `groth16_60` + `groth16_4` (hard-coded), not "ACTIVE_VARIANT (or first entry)"; `groth16_4` is built by that default, not by the test setup. | Correct the text. | safe | |
| M3 | doc mismatch | `docs/ENVIRONMENT.md:30,55,119`, `docs/TECH_STACK.md:43,48` | `SERVE_CLIENT` row and `@fastify/static` / `pino` rows describe things the code doesn't do. | Follow the D5/U1/U2 decisions. | needs care | |
| M4 | doc mismatch | `docs/TESTING.md:10`, `README.md:177` | `npm run test:e2e  # Playwright two-player match` — no such test exists (E2). | List the real E2E scripts (`e2e:cheats`, `e2e:audit-reload`, `perf:match`), as TESTING §5 already does. | safe | |
| M5 | doc mismatch | `docs/API_SPEC.md:68,82`, `docs/USER_FLOWS.md:72`, `docs/UI_UX_SPEC.md:94` | `GET /api/matches` (P1, TODO still open) and `GET /api/matches/:id/log` + the "Download match log (JSON)" button are not implemented; the log endpoint isn't in PRD. | Mark both "not implemented in v1.0.x" (no new feature, rule 7). | safe | |
| M6 | doc mismatch | `docs/USER_FLOWS.md:78` | `npm run bench -- --log … --samples 20`: no `bench` script and no `--log` flag; real command is `npm run bench:node [-- --variants … --samples N --upload]`. | Correct the command. | safe | |
| M7 | doc mismatch | `docs/DATABASE_SCHEMA.md:147-148,225` | "Migrations as built" lists 001–003; `004_phase4` and `005_bench` exist. `detection_runs` prose omits `id`, `created_at`, `match_id`. (All other tables/columns match the migrated schema exactly — diffed programmatically.) | Add 004/005 and the 3 columns. | safe | |
| M8 | doc mismatch | `docs/ENVIRONMENT.md` §2 | `VITE_PERF_AUTOMATION` (injected by `vite build --mode perf`, `vite.config.ts:75`) isn't mentioned. | One sentence under §2. | safe | |
| M9 | doc mismatch | `docs/TESTING.md:79` | Says `circomspect circuits/window.circom` must be clean; the real gate runs on the generated `main_4` / `main_60` (clean); a direct run on `window.circom` reports S10. | Name the actual gate (`npm run circuits:lint`). | safe | |
| M10 | doc mismatch | `CLAUDE.md:3` | "Specs live in `docs/` (14 files)" — becomes 15 with this audit file. | Your file: update the count or leave it. | needs care | |

## Checked and consistent (no finding)

- WS protocol: all 26 message types in `shared/protocol.ts` appear in API_SPEC; proof statuses match the `proof_windows.status` CHECK and DATABASE_SCHEMA; REST routes implemented = API_SPEC except M5.
- PRD §5: all 22 constants match `shared/constants.ts`.
- Server env vars (names, defaults, validation) and client `VITE_*` vars match ENVIRONMENT.md; `server/.env.example` / `client/.env.example` keys match the doc.
- DB: every table and column created by migrations 001–005 matches DATABASE_SCHEMA §2 (except the M7 prose).
- Every repo path referenced in backticks in README/CLAUDE.md/docs exists.
- Timers/listeners/workers: client listeners use an AbortController or a matching remove; intervals are cleared in `dispose`; `ProofClient` / `AuditResumer` dispose their prover → `worker.terminate()`; bench workers terminated; server `helloTimer`, loop timer and verifier timers are cleared; `VerifierPool` replace/exit re-entrancy is safe; shutdown closes gateway, pool and DB.
- No `TODO`/`FIXME`/`XXX` (except S3), no `debugger`, `@ts-ignore`, `@ts-expect-error` or `eslint-disable` in source; the only `console.log` in app code is the `migrate.ts` CLI; every empty `catch` is deliberate and commented.
- Clock domains: monotonic `deps.now` for durations, epoch for persisted timestamps (S5 is the only inconsistency).

## Summary

| Category | Found | safe | needs care | do not touch |
|---|---|---|---|---|
| error | 5 | 3 (E2, E3, E4) | 2 (E1, E5) | 0 |
| dead code | 5 | 2 (D2, D4) | 1 (D5) | 2 (D1, D3) |
| unused dep | 6 | 0 | 3 (U1, U2, U5) | 3 (U3, U4, U6) |
| smell | 10 | 6 (S2, S3, S4, S5, S7, S8) + S9 optional | 1 (S1) | 2 (S6, S10) |
| security | 2 | 0 | 1 (X1) | 1 (X2) |
| test gap | 2 | 1 (T1) | 1 (T2) | 0 |
| doc mismatch | 10 | 8 (M1, M2, M4–M9) | 2 (M3, M10) | 0 |
| **total** | **40** | **21** | **11** | **8** |

(S9 is counted as safe; it adds a new config file, so it waits for your OK.)

No finding touches `circuits/*.circom`, the circuit constants, `publicSignalOrder`, Poseidon inputs or the bind/digest/commit computation, and none needs `bench/out/` or `bench/RESULTS.md` changes.
