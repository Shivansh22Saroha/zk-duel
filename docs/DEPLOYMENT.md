# DEPLOYMENT — ZK-Duel

Primary target: **a single laptop on a LAN** for the seminar demo. Optional: a small VM with HTTPS for remote play.

## 1. Build

```bash
npm ci
npm run circuits:build:all      # all 6 variants (slow: minutes; needs ~2 GB disk, 8 GB RAM recommended)
npm run build                   # tsc for server/shared, vite build for client
```

Outputs:
```
circuits/build/<scheme>_<N>/{window.wasm, window_final.zkey, verification_key.json, info.json}
client/dist/                     # static site
server/dist/                     # compiled server
```

Circuit artefacts are **build outputs, not source**: they are not committed. CI builds them and publishes them as a release asset (tarball + SHA-256), so every machine uses byte-identical zkeys — otherwise benchmark results and proofs aren't comparable.

## 2. LAN demo (recommended for the viva)

```bat
:: On the host laptop (Windows cmd)
copy server\.env.example server\.env   & :: set ALLOWED_ORIGINS to include http://<laptop-ip>:5173
npm run db:migrate
npm run dev -- --host                  & :: server :8080, client :5173 exposed on LAN
```
Both players open `http://<laptop-ip>:5173`. Before the demo: disable sleep, plug in power (proving is CPU-heavy and slows on battery), close other heavy apps, and pre-load the zkey once in each browser so it is cached.

## 3. Docker

### `Dockerfile` (multi-stage)
```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY client/package.json client/ ; COPY server/package.json server/
COPY shared/package.json shared/ ; COPY bench/package.json bench/
COPY circuits/package.json circuits/
RUN npm ci
COPY . .
# Circuit artefacts are copied in from the CI release, not rebuilt here
COPY circuits/build circuits/build
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production SERVE_CLIENT=true
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/shared shared
RUN npm ci --omit=dev --workspace server --workspace shared
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY --from=build /app/circuits/build circuits/build
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
```
`better-sqlite3` builds a native addon; if `npm ci` fails in the slim image, add `python3 make g++` to the build stage.

### `docker-compose.yml`
```yaml
services:
  app:
    build: .
    env_file: server/.env
    environment:
      HOST: 0.0.0.0
      DB_PATH: /data/zkduel.db
      ZK_ARTEFACT_DIR: /app/circuits/build
    volumes:
      - zkdata:/data
    restart: unless-stopped
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [app]
volumes:
  zkdata:
  caddy_data:
```

### `Caddyfile`
```
zkduel.example.com {
  encode zstd gzip
  @zk path /zk/*
  header @zk Cache-Control "public, max-age=31536000, immutable"
  reverse_proxy app:8080
}
```
Caddy handles HTTPS certificates and proxies WebSocket upgrades automatically.

## 4. Production checklist

- [ ] `NODE_ENV=production`, strong `JWT_SECRET`, `BENCH_TOKEN` set
- [ ] `DEV_CHEATS=false` and client built with `VITE_DEV_CHEATS=false`
- [ ] `ALLOWED_ORIGINS` = the HTTPS origin only; client `VITE_WS_URL` uses `wss://`
- [ ] Artefact SHA-256 in `/api/circuit/info` matches the release asset
- [ ] `npm run db:migrate` runs on container start (entrypoint) before the server listens
- [ ] Volume backup for `/data` (SQLite file) — `sqlite3 zkduel.db ".backup backup.db"` daily
- [ ] `/api/health` monitored

## 5. CI/CD (GitHub Actions)

### `ci.yml` — on every push / PR
1. Checkout, setup Node 22, cache npm.
2. Install circom (pinned release binary) and circomspect.
3. `npm ci`
4. `npm run lint && npm run typecheck`
5. Build test circuit (N=4) → `npm test` → `npm run test:int`
6. `circomspect` (fail on warnings) and `npm audit --omit=dev --audit-level=high`

### `circuits.yml` — on tag `circuits-v*` or manual dispatch
1. Download ptau, verify SHA-256.
2. `npm run circuits:build:all`
3. Generate `info.json` per variant (constraints, publicSignalOrder, zkeySha256).
4. Upload `circuits-build.tar.gz` + `SHA256SUMS` as a GitHub Release asset.

### `release.yml` — on tag `v*`
1. Download the referenced circuits release asset and verify checksums.
2. Build the Docker image, push to GHCR (`ghcr.io/<user>/zk-duel:<tag>`).
3. (Optional) SSH to the VM: `docker compose pull && docker compose up -d`.

E2E and benchmarks are run manually on the baseline laptop, not in CI (CI runners are not representative hardware).

## 6. Rollback

- App: redeploy the previous image tag.
- Circuits: a circuit change makes old proofs unverifiable with the new vkey. Matches record `circuit_hash`, so historical results stay interpretable; never overwrite a released circuits asset — publish a new tag.
- DB: migrations are forward-only; restore from the daily backup if needed.
