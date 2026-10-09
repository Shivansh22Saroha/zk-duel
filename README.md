# ZK-Duel

A 1v1 top-down browser shooter where each player proves, with zero-knowledge proofs, that they followed the game rules — without revealing their hidden state (ammo, cooldown, reload timer) or their raw input samples.

ZK-Duel is the proof-of-concept for the seminar *"Zero-Knowledge Proofs for Verifiable Fair-Play in Competitive Gaming and Esports"* (The NorthCap University, CSC301, July–December 2026). The game exists to produce real benchmark data. It is a research prototype, not a production anti-cheat system.

---

## What it does

- Two players fight in a small 2D arena at a fixed **60 Hz tick rate**.
- Every **window of N ticks** (default 60), each client generates a **Groth16 zk-SNARK** (circom + snarkjs) in a Web Worker while the game keeps running.
- The proof shows that, across the window:
  1. **Movement** — the player never moved faster than `MAX_SPEED` per tick and stayed inside the arena.
  2. **Aim** — the aim angle never turned more than `MAX_TURN` per tick.
  3. **Fire rate & ammo** — every shot happened with ammo > 0, cooldown elapsed and no reload in progress, and the hidden counters updated correctly.
- The server verifies each proof in milliseconds and shows a green/red strip of proof results in the HUD.
- A **dev cheat panel** (speedhack, rapid-fire, snap-aimbot, infinite ammo) demonstrates proofs failing.
- A **benchmark mode** measures proof time, verify time, proof size and constraint count for window sizes 30 / 60 / 120 and Groth16 vs PLONK.

### What it does not claim

A ZKP proves that the inputs *obey the rules*. It cannot prove a *human* produced them. A smoothed aimbot that stays under `MAX_TURN` passes. This limit is stated in the seminar and is part of the findings. See `SECURITY.md` §7.

---

## Tech stack (summary)

| Layer | Choice |
|---|---|
| Client | TypeScript, Vite, HTML5 Canvas 2D, Web Workers |
| Server | Node.js 22 LTS, TypeScript, Fastify (REST), `ws` (WebSocket) |
| ZK | circom 2.2.x, circomlib, snarkjs 0.7.x (Groth16 primary, PLONK for comparison) |
| Database | SQLite via `better-sqlite3` |
| Tests | Vitest, Playwright, circom_tester |

Full versions: `TECH_STACK.md`.

---

## Repository layout

```
zk-duel/
├── client/          # Vite + TS game client (canvas, input, HUD, proof worker)
├── server/          # Fastify REST + ws game server, verifier, SQLite
├── shared/          # constants.ts, types.ts, protocol.ts (used by client + server)
├── circuits/        # window.circom + helpers, build scripts, test vectors
├── bench/           # benchmark runner + chart export
├── docs/            # these 15 spec documents
└── package.json     # npm workspaces root
```

---

## Prerequisites

- Node.js 22 LTS and npm 10+
- Rust toolchain (to install circom from source) **or** a prebuilt circom 2.2.x binary on PATH
- ~2 GB free disk (powers-of-tau file + build artefacts)
- A modern Chromium or Firefox browser

---

## Setup

```bash
git clone <repo-url> zk-duel && cd zk-duel
npm install

# 1. Build circuits (compile, download ptau, Groth16 setup, export vkey + wasm)
npm run circuits:build          # WINDOW_TICKS defaults to 60
# Optional: build all benchmark variants (30/60/120, groth16 + plonk)
npm run circuits:build:all

# 2. Copy environment templates
cp server/.env.example server/.env
cp client/.env.example client/.env

# 3. Create the database
npm run db:migrate
```

## Run (development)

```bash
npm run dev          # starts server on :8080 and client on :5173
```

Open `http://localhost:5173` in **two browser windows** (or two machines on the same LAN), enter a name in each, press **Find Match**.

## Run benchmarks

```bash
npm run bench                     # headless Node proving, all variants
npm run bench -- --browser        # opens a page that proves in-browser (realistic)
```

Results are written to the `benchmark_results` table and exported to `bench/out/results.csv`.

## Common scripts

| Script | Does |
|---|---|
| `npm run dev` | Server + client with hot reload |
| `npm run build` | Production build of client, server, circuits |
| `npm test` | Unit + circuit tests |
| `npm run test:e2e` | Playwright two-player match |
| `npm run circuits:build` | Build the default circuit |
| `npm run bench` | Benchmark suite |
| `npm run db:migrate` | Apply SQL migrations |

---

## Documentation index

| Doc | Purpose |
|---|---|
| `PRD.md` | What the app must do |
| `ARCHITECTURE.md` | How it is built, data flow, the circuit design |
| `UI_UX_SPEC.md` | Screens, layout, colors, components |
| `DATABASE_SCHEMA.md` | Tables, relations, indexes |
| `API_SPEC.md` | REST endpoints and WebSocket protocol |
| `SECURITY.md` | Auth, validation, threat model, ZK-specific risks |
| `TECH_STACK.md` | Exact frameworks and versions |
| `USER_FLOWS.md` | Step-by-step journeys |
| `FEATURES.md` | Feature-by-feature behaviour |
| `ENVIRONMENT.md` | `.env` variables and config |
| `TESTING.md` | Unit, circuit, integration, E2E, security tests |
| `DEPLOYMENT.md` | Build, Docker, CI/CD |
| `CHANGELOG.md` | Development history |
| `TODO.md` | Remaining work |

### Build order for a coding AI

1. `shared/` constants and protocol types (single source of truth — every number in these docs comes from `shared/constants.ts`).
2. Playable game with no ZK (client + server + SQLite). Must be fun and stable first.
3. `circuits/window.circom` tested offline against logged tick data.
4. Proof worker in the client, verifier in the server.
5. Cheat panel, benchmark mode, results dashboard.

Do not skip step 2. Do not add features not listed in `PRD.md`.

---

## License & credits

MIT. Built by Shivansh Saroha for the CSC301 Seminar, The NorthCap University, under the supervision of Ms. Vandana.
