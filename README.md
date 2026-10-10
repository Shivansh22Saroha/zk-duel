# ZK-Duel

A 1v1 top-down browser shooter where each player proves, with zero-knowledge proofs, that they followed the game rules — without revealing their hidden state (ammo, cooldown, reload timer) or their raw input samples.

ZK-Duel is the proof-of-concept for the seminar *"Zero-Knowledge Proofs for Verifiable Fair-Play in Competitive Gaming and Esports"* (The NorthCap University, CSC301, July–December 2026). The game exists to produce real benchmark data. It is a research prototype, not a production anti-cheat system.

---

## What it does

- Two players fight in a small 2D arena at a fixed **60 Hz tick rate**.
- Every **window of N ticks** (default 60), each client **commits** to its hidden weapon state. During play the server **spot-checks** random windows; the client proves each challenged window with a **Groth16 zk-SNARK** (circom + snarkjs) in a Web Worker while the game keeps running. After the match the client proves **every remaining window** — the audit — so a match is only "audited clean" when every window of both players verified.
- A proof shows that, across its window:
  1. **Movement** — the player never moved faster than `MAX_SPEED` per tick and stayed inside the arena.
  2. **Aim** — the aim angle never turned more than `MAX_TURN` per tick.
  3. **Fire rate & ammo** — every shot happened with ammo > 0, cooldown elapsed and no reload in progress, and the hidden counters updated correctly.
- The server verifies each proof in milliseconds and shows a strip of window results in the HUD (hollow = committed, ◌ = being proven, ✓ / ✕) and "Spot-checks: 7/7 passed".
- A **dev cheat panel** (speedhack, rapid-fire, snap-aimbot, infinite ammo, smooth-aimbot) demonstrates proofs failing — and the smooth aimbot passing.
- A **benchmark mode** measures proof time, verify time, proof size and constraint count for window sizes 30 / 60 / 120 and Groth16 vs PLONK.

### What it does not claim

A ZKP proves that the inputs *obey the rules*. It cannot prove a *human* produced them. A smoothed aimbot that stays under `MAX_TURN` passes. This limit is stated in the seminar and is part of the findings. See [`docs/SECURITY.md`](docs/SECURITY.md) §7 (including the *partially inferable hidden state* limitation).

---

## Tech stack (summary)

| Layer | Choice |
|---|---|
| Client | TypeScript, Vite, HTML5 Canvas 2D, Web Workers |
| Server | Node.js 22 LTS, TypeScript, Fastify (REST), `ws` (WebSocket) |
| ZK | circom 2.2.x, circomlib, snarkjs 0.7.x (Groth16 primary, PLONK for comparison) |
| Database | SQLite via `better-sqlite3` |
| Tests | Vitest, Playwright, circom_tester |

Full versions: [`docs/TECH_STACK.md`](docs/TECH_STACK.md).

---

## Repository layout

```
zk-duel/
├── client/          # Vite + TS game client (canvas, input, HUD, proof worker)
├── server/          # Fastify REST + ws game server, verifier, SQLite
├── shared/          # constants.ts, types.ts, protocol.ts (used by client + server)
├── circuits/        # window.circom + helpers, build scripts, test vectors
├── bench/           # benchmark runner + chart export
├── docs/            # the 14 spec documents (README stays at the root)
└── package.json     # npm workspaces root
```

---

## Prerequisites

- Node.js 22 LTS (via `fnm`: `winget install Schniz.fnm`, then `fnm install 22`) and npm 10+
- Rust toolchain (to install circom from source) **or** a prebuilt circom 2.2.x binary on PATH
- circomspect (`cargo install circomspect`) for static analysis
- ~2 GB free disk (powers-of-tau file + build artefacts)
- A modern Chromium or Firefox browser

---

## Setup

Commands below are for **Windows cmd** (they also work in PowerShell except where noted).

```bat
git clone <repo-url> zk-duel
cd zk-duel
fnm use 22
npm install

:: 1. Build circuits (compile, download ptau, Groth16 setup, export vkey + wasm):
::    groth16_60 (played) + groth16_4 (integration tests); groth16_30 is used by the browser bench
npm run circuits:build
npm run circuits:build -- --n 30
:: Optional: build all benchmark variants (30/60/120, groth16 + plonk)
npm run circuits:build:all

:: 2. Copy environment templates
copy server\.env.example server\.env
copy client\.env.example client\.env

:: 3. Create the database
npm run db:migrate
```

## Run (development)

```bat
npm run dev
```
Starts the server on :8080 and the client on :5173. For LAN play use `npm run dev:lan` (also exposes the client on the network) and add `http://<host-ip>:5173` to `ALLOWED_ORIGINS` in `server\.env`.

Open `http://localhost:5173` in **two browser windows** (or two machines on the same LAN), enter a name in each, press **Find Match**. Each tab has its own guest session (`sessionStorage`), so two tabs or two windows both work — but keep both *visible* (side by side): browsers throttle hidden tabs, and a hidden player stalls.

The client downloads the proving key (≈ 35 MB for N = 60) while you wait in the queue, checks its SHA-256 and caches it (Cache API — only on `localhost`/https; on a plain-http LAN address it re-downloads each match). After a match, **keep the results page open**: it shows "Auditing… x/y windows" while your browser proves the windows that were not spot-checked (a few minutes for a 3-minute match), then the audit status.

Generate bot matches with full (public + private) tick logs for offline circuit tests: `npm run bots -- --matches 3` (server must be running).

## Run benchmarks

```bat
npm run bench
npm run bench -- --browser
```
The first runs headless Node proving for all variants; the second opens a page that proves in-browser (realistic).

Results are written to the `benchmark_results` table and exported to `bench/out/results.csv`.

## Common scripts

| Script | Does |
|---|---|
| `npm run dev` | Server + client with hot reload |
| `npm run dev:lan` | Same, with the client exposed on the LAN |
| `npm run build` | Production build of client, server, circuits |
| `npm test` | Unit + circuit tests |
| `npm run test:int` | Server integration tests (real sockets; 10 bot matches + Phase 3 proving matches with the N=4 circuit — ≈ 15–20 min) |
| `npm run bots -- --matches N` | Bot matches against a running server; writes tick logs |
| `npm run perf:frame` | Client frame-time measurement in Chrome (needs `npm run dev`) |
| `npm run perf:prove -- --variants groth16_60,groth16_30 --threads default,4` | Browser proving measurement: real windows in the Proof Worker + frame time (dev page `/bench.html`; needs `npm run dev -w client`) |
| `npm run perf:serve` | Production `--mode perf` client build + `vite preview` + server without watch (for perf/e2e runs) |
| `npm run perf:match -- --acc 1800 --stop-after 180` | Phase 3 exit check in Chrome: two bot-driven windows play a 3-minute match through spot-checks and the full audit (needs `npm run perf:serve`) |
| `npm run e2e:audit-reload` | Reload a page mid-audit; the audit must resume from IndexedDB and end `audited_clean` (needs `npm run perf:serve`) |
| `npx tsx server/scripts/prove-profile.ts --variant groth16_60` | Per-step timing of one snarkjs prove in Node |
| `npx tsx server/scripts/zk-node-bench.ts --variant groth16_60` | Node proving (bot worker) + VerifierPool verify times, idle machine |
| `npm run circuits:build` | Build groth16_60 + groth16_4 (compile, ptau, setup, info.json); `-- --n 30` for one |
| `npm run circuits:prove-log -- --log <file> --n 60` | Prove + verify every window of a client tick log offline |
| `npm run circuits:mutate-log -- --log <in> --out <out> --cheat speed\|rapid\|ammo` | Make a cheating copy of a tick log |
| `npm run circuits:lint` | circomspect on the generated main circuits |
| `npm run test:e2e` | Playwright two-player match |
| `npm run bench` | Benchmark suite |
| `npm run db:migrate` | Apply SQL migrations |

---

## Documentation index

| Doc | Purpose |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | What the app must do |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it is built, data flow, the circuit design |
| [`docs/UI_UX_SPEC.md`](docs/UI_UX_SPEC.md) | Screens, layout, colors, components |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Tables, relations, indexes |
| [`docs/API_SPEC.md`](docs/API_SPEC.md) | REST endpoints and WebSocket protocol |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Auth, validation, threat model, ZK-specific risks |
| [`docs/TECH_STACK.md`](docs/TECH_STACK.md) | Exact frameworks and versions |
| [`docs/USER_FLOWS.md`](docs/USER_FLOWS.md) | Step-by-step journeys |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Feature-by-feature behaviour |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | `.env` variables and config |
| [`docs/TESTING.md`](docs/TESTING.md) | Unit, circuit, integration, E2E, security tests |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Build, Docker, CI/CD |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Development history |
| [`docs/TODO.md`](docs/TODO.md) | Remaining work |

### Build order for a coding AI

1. `shared/` constants and protocol types (single source of truth — every number in these docs comes from `shared/constants.ts`).
2. Playable game with no ZK (client + server + SQLite). Must be fun and stable first.
3. `circuits/window.circom` tested offline against logged tick data.
4. Proof worker in the client, verifier in the server.
5. Cheat panel, benchmark mode, results dashboard.

Do not skip step 2. Do not add features not listed in [`docs/PRD.md`](docs/PRD.md).

---

## License & credits

MIT. Built by Shivansh Saroha for the CSC301 Seminar, The NorthCap University, under the supervision of Ms. Vandana.
