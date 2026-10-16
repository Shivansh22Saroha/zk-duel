# TECH STACK — ZK-Duel

Versions are the **major.minor lines to target**. At project setup, install the latest patch of each, then pin exact versions in `package-lock.json` and record them in `CHANGELOG.md`. Do not upgrade major versions mid-project — benchmark numbers must stay comparable.

## 1. Runtime & tooling

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS | Server, build scripts, Node benchmarks |
| npm | 10.x | Workspaces (`client`, `server`, `shared`, `circuits`, `bench`) |
| TypeScript | 5.x | `strict: true`, `noUncheckedIndexedAccess: true` |
| tsx | 4.x | Run TS scripts without a build step |
| circom | 2.2.x | Circuit compiler (Rust binary) |
| Rust / cargo | stable | Only needed to build circom from source |
| ESLint | 9.x (flat config) + typescript-eslint | |
| Prettier | 3.x | |

## 2. Shared package (`shared/`)

| Library | Purpose |
|---|---|
| `zod` 3.x | Protocol schemas, used by both sides |
| `circomlibjs` 0.1.x | Poseidon in JS, matching circomlib's circuit Poseidon |

## 3. Client (`client/`)

| Library | Version | Purpose |
|---|---|---|
| Vite | 6.x or later | Dev server + build; serves `/zk/*` artefacts as static files |
| Vanilla TS + Canvas 2D | — | Game rendering fallback (`?renderer=2d`); no game engine — the sim stays fully under our control and deterministic |
| `snarkjs` | 0.7.x | `groth16.fullProve` / `plonk.fullProve` inside a Web Worker |
| `three` | 0.186.1 (+ `@types/three` 0.186.0) | 3D renderer (Phase 4.5): a second `GameRenderer` behind the renderer seam; loaded lazily; presentation only |
| `chart.js` | 4.x | Benchmark charts |
| Fonts | Inter, JetBrains Mono (Google Fonts) | |

No UI framework is required: screens are small. If preferred, **Preact 10.x** is allowed for screens/HUD only — never inside the game loop.

## 4. Server (`server/`)

| Library | Version | Purpose |
|---|---|---|
| Fastify | 5.x | REST |
| `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` | Matching Fastify 5 | Hardening |
| `ws` | 8.x | WebSocket server (attached to Fastify's HTTP server) |
| `snarkjs` | 0.7.x | Proof verification in `worker_threads` |
| `better-sqlite3` | latest major | SQLite driver (synchronous, fast) |
| `jsonwebtoken` | 9.x | JWT sign/verify |
| `pino` (bundled with Fastify, not a direct dependency) | 9.x | Structured logging |
| `dotenv` | 16.x | Env loading in dev |

## 5. Circuits (`circuits/`)

| Item | Version / Source | Purpose |
|---|---|---|
| `circomlib` | 2.0.x | `Poseidon`, `LessThan`, `LessEqThan`, `IsZero`, `IsEqual`, `Num2Bits`, `Mux1` |
| Powers of Tau | Hermez/Polygon public ceremony files. The power is computed per variant from its **real** constraint count (Groth16: 2^p ≥ R1CS constraints; PLONK: 2^p ≥ snarkjs PLONK constraint count, which is larger) and the smallest file that fits is used; recorded in `info.json` | Phase 1 for Groth16 and the universal setup for PLONK |
| `circom_tester` | latest | Circuit unit tests (witness checks) |
| circomspect | latest | Static analysis for under-constrained signals |

Curve: **BN254** (snarkjs default `bn128`). Hash: **Poseidon** (circomlib parameters) everywhere — never SHA-256 inside the circuit.

## 6. Testing

| Tool | Purpose |
|---|---|
| Vitest 2.x+ | Unit tests (shared, client, server) |
| circom_tester + Mocha (via Vitest wrapper) | Circuit tests |
| Playwright 1.x | E2E: two browser contexts play a scripted match; browser benchmarks |
| `fast-check` | Property tests: random legal input sequences always prove; mutated ones never do |

## 7. Infrastructure

| Item | Choice |
|---|---|
| Container | Docker, `node:22-bookworm-slim` base |
| Reverse proxy / TLS | Caddy 2.x (automatic HTTPS) |
| CI | GitHub Actions |
| Hosting (demo) | Localhost / LAN laptop; optional single small VM (2 vCPU, 4 GB) |
| Database | SQLite file on a Docker volume |

## 8. Explicitly not used (and why)

| Not used | Reason |
|---|---|
| Unity / Godot / Phaser | Unnecessary weight; harder to keep a deterministic integer sim aligned with the circuit |
| Socket.IO | Plain `ws` is enough; fewer layers to reason about in benchmarks |
| Postgres / Redis | Single-node prototype |
| Blockchain / smart contracts | Verification happens on the game server; on-chain verification is not a research objective here |
| Noir, Halo2, RISC0 | Valid alternatives; kept as future work to limit scope. Groth16 vs PLONK in snarkjs is enough for the comparison |

## 9. Hardware assumptions for benchmarks

Record exact hardware for every run in `benchmark_runs.device_label`. Baseline target: a mid-range laptop (4–8 cores, 8–16 GB RAM) in Chrome. Also run once on the strongest available machine to bound results.
