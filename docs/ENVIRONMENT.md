# ENVIRONMENT — ZK-Duel

Two env files: `server/.env` (secret, never committed) and `client/.env` (public, Vite exposes only `VITE_*`). Templates live in `server/.env.example` and `client/.env.example`. The server validates its env with zod at boot and exits with a clear message if anything is missing or invalid.

## 1. Server (`server/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `HOST` | no | `0.0.0.0` | Bind address (use `0.0.0.0` for LAN play) |
| `PORT` | no | `8080` | HTTP + WS port |
| `ALLOWED_ORIGINS` | yes | — | Comma-separated, e.g. `http://localhost:5173,http://192.168.1.20:5173` |
| `JWT_SECRET` | yes | — | ≥ 32 random bytes (hex/base64). Boot fails in production if it equals the example value |
| `JWT_TTL_HOURS` | no | `24` | Session token lifetime |
| `DB_PATH` | no | `./data/zkduel.db` | SQLite file |
| `ZK_ARTEFACT_DIR` | no | `../circuits/build` | Where variant folders live |
| `ACTIVE_VARIANT` | no | `groth16_60` | Variant used for matches (`<scheme>_<N>`) |
| `PROOF_GRACE_WINDOWS` | no | `2` | Late-snapshot bound and digest-finalisation grace, in windows |
| `PROOF_DEADLINE_MS` | no | `15000` (`shared/constants.ts`) | Time a challenged window's proof may take before `timeout`. Measured on AC (Phase 3): Chrome prove p95 at N=60 1.48 s with one client per machine, 2.78 s with two clients proving on one laptop (worst case) |
| `AUDIT_TIMEOUT_MIN` | no | `60` (`shared/constants.ts`) | How long after `match_end` audit proofs are accepted; then remaining windows are `unaudited` |
| `DEFAULT_ENFORCEMENT` | no | `observe` | `observe` \| `strict` for queue matches |
| `VERIFIER_THREADS` | no | `2` | `worker_threads` for verification |
| `VERIFY_TIMEOUT_MS` | no | `2000` | Per-proof verify timeout |
| `DEV_CHEATS` | no | `false` | Accept `cheat_toggle`. **Must be false in production** |
| `STORE_PROOFS` | no | `false` | Persist proof JSON in `proof_windows` |
| `LOG_SNAPSHOTS` | no | `false` | Write snapshot JSONL logs of what the server received (public only — see "Tick logs" below) |
| `PUBLIC_MATCHES` | no | `false` | Let anyone read match summaries |
| `BENCH_TOKEN` | yes (if bench uploads used) | — | Shared secret for `POST /api/bench/runs` |
| `LOG_LEVEL` | no | `info` | pino level. Logs go to stdout and are appended to `logs/server-<YYYY-MM-DD>.log` next to the DB (default `server/data/logs/`; date taken at boot) |

### `server/.env.example`
```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=8080
ALLOWED_ORIGINS=http://localhost:5173
JWT_SECRET=change-me-generate-with-openssl-rand-hex-32
JWT_TTL_HOURS=24
DB_PATH=./data/zkduel.db
ZK_ARTEFACT_DIR=../circuits/build
ACTIVE_VARIANT=groth16_60
PROOF_GRACE_WINDOWS=2
PROOF_DEADLINE_MS=15000
AUDIT_TIMEOUT_MIN=60
DEFAULT_ENFORCEMENT=observe
VERIFIER_THREADS=2
VERIFY_TIMEOUT_MS=2000
DEV_CHEATS=true
STORE_PROOFS=false
LOG_SNAPSHOTS=false
PUBLIC_MATCHES=false
BENCH_TOKEN=change-me
LOG_LEVEL=info
```
Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (works on Windows without OpenSSL).

## 2. Client (`client/.env`)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://<page host>:8080` | REST base. Empty = derived from the host the page was loaded from, so LAN play works without edits |
| `VITE_WS_URL` | `ws://<page host>:8080/ws` | WebSocket URL. Empty = derived like `VITE_API_URL` |
| `VITE_ZK_BASE` | `/zk` | Base path for artefacts |
| `VITE_DEV_CHEATS` | `false` | Include the cheat panel in the bundle |
| `VITE_SHOW_DEBUG` | `false` | FPS / frame-time / tick / RTT overlay |
| `VITE_LOG_TICKS` | `false` | Dev only: keep this player's per-tick log (public **and private** state) in browser memory and offer "Download tick log (dev)" on the results screen. Never sent over the network. Used to produce real-match logs for offline circuit tests |

### `client/.env.example`
```dotenv
VITE_API_URL=
VITE_WS_URL=
VITE_ZK_BASE=/zk
VITE_DEV_CHEATS=true
VITE_SHOW_DEBUG=true
VITE_LOG_TICKS=true
```

`VITE_PERF_AUTOMATION` is not an env-file variable: `vite build --mode perf` (`npm run build:perf -w client`, used by `npm run perf:serve`) defines it as `true` (`client/vite.config.ts`), which keeps the dev-only automation (`?bot=`, `window.__zkd`) in that production build. Plain `vite build` has neither.

### Tick logs (Phase 2 inputs)
The server never sees hidden state, so `LOG_SNAPSHOTS=true` server logs (`server/data/logs/<matchId>.jsonl`) contain **public snapshots only** (received values plus `held` fills). Logs with private state are written on the client side only: Node bots (`npm run bots`) write `server/data/logs/clients/<matchId>-p<i>-<name>.jsonl`; browsers with `VITE_LOG_TICKS=true` offer a download. Format: `shared/ticklog.ts`.

In dev, Vite serves `circuits/build/*` at `/zk/*` via a small `server.fs.allow` + middleware entry in `vite.config.ts`. Large artefacts must be served with `Content-Type: application/octet-stream` and long cache headers.

## 3. Circuit build configuration (`circuits/build.config.json`)

```json
{
  "variants": [
    { "scheme": "groth16", "windowTicks": 60 },
    { "scheme": "groth16", "windowTicks": 30 },
    { "scheme": "groth16", "windowTicks": 120 },
    { "scheme": "plonk",   "windowTicks": 30 },
    { "scheme": "plonk",   "windowTicks": 60 },
    { "scheme": "plonk",   "windowTicks": 120 }
  ],
  "ptau": {
    "baseUrl": "<official Hermez/Polygon ptau URL — confirm current location at setup>",
    "files": { "<power>": { "file": "powersOfTau28_hez_final_<power>.ptau", "sha256": "<record after verifying>" } }
  }
}
```
The build script picks the smallest power that fits each variant's real constraint count (TECH_STACK §5), downloads/verifies that file if missing, and records `ptauPower`, `ptauFile`, `ptauSha256` in the variant's `info.json`. The `groth16_4` test variant is not listed here.
`npm run circuits:build` builds `groth16_60` (live play) and `groth16_4` (tests) — fixed in `circuits/scripts/build.ts`, independent of `ACTIVE_VARIANT`; `npm run circuits:build -- --all` builds the 6 variants listed here; `-- --n <N> [--scheme plonk]` builds one.

## 4. External services

None required. Everything runs on one machine. Internet is needed once to download npm packages, the circom binary and the ptau file.

## 5. Environment matrix

| Setting | Local dev | LAN demo | Production (optional VM) |
|---|---|---|---|
| `HOST` | `0.0.0.0` | `0.0.0.0` | `127.0.0.1` (behind Caddy) |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | add `http://<laptop-ip>:5173` | `https://zkduel.example.com` |
| WS URL | `ws://localhost:8080/ws` | `ws://<laptop-ip>:8080/ws` | `wss://zkduel.example.com/ws` |
| `DEV_CHEATS` | `true` | `true` (demo) | `false` |
| `VITE_DEV_CHEATS` | `true` | `true` | `false` |

## 6. Ports & firewall (LAN demo)

Open TCP 8080 (server) and 5173 (Vite dev) on the host laptop's firewall for the local network profile only. Both players' browsers must reach the same host IP.
