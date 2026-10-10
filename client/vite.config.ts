import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'circuits', 'build');
const FIXTURES_DIR = join(ROOT, 'circuits', 'test', 'fixtures');

/** Only these artefacts are ever served (never r1cs/sym/intermediate zkeys). */
const SERVED = new Set(['window.wasm', 'window_final.zkey', 'info.json']);
const VARIANT_RE = /^(groth16|plonk)_\d{1,3}$/;

/**
 * Serves circuits/build/<variant>/{window.wasm, window_final.zkey, info.json} at /zk/<variant>/…
 * (ENVIRONMENT §2), octet-stream + long cache headers — in the dev server and in `vite preview`
 * (production build, used for the perf runs). Dev server only: the committed Phase 1 fixture logs
 * at /__dev/fixtures/ for the browser proving bench page (bench.html).
 */
function zkMiddleware(withFixtures: boolean) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): unknown => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const zk = /^\/zk\/([^/]+)\/([^/]+)$/.exec(url);
    if (zk) {
      const [, variant, file] = zk as unknown as [string, string, string];
      const path = join(BUILD_DIR, variant, file);
      if (!VARIANT_RE.test(variant) || !SERVED.has(file) || !existsSync(path)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader(
        'Content-Type',
        file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      );
      res.setHeader('Content-Length', String(statSync(path).size));
      // info.json can change on rebuild; the big artefacts are content-addressed by sha256
      res.setHeader(
        'Cache-Control',
        file.endsWith('.json') ? 'no-cache' : 'public, max-age=31536000, immutable',
      );
      return void createReadStream(path).pipe(res);
    }
    if (!withFixtures) return next();
    if (url === '/__dev/fixtures/') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.jsonl'))));
    }
    const fx = /^\/__dev\/fixtures\/([A-Za-z0-9_.-]+\.jsonl)$/.exec(url);
    if (fx && existsSync(join(FIXTURES_DIR, fx[1] as string))) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      return void createReadStream(join(FIXTURES_DIR, fx[1] as string)).pipe(res);
    }
    next();
  };
}

function zkArtefacts(): Plugin {
  return {
    name: 'zk-artefacts',
    configureServer(server) {
      server.middlewares.use(zkMiddleware(true));
    },
    configurePreviewServer(server) {
      server.middlewares.use(zkMiddleware(false));
    },
  };
}

/**
 * `vite build --mode perf`: a production build that still accepts the bot automation URL params
 * and exposes window.__zkd (Playwright perf/e2e runs). Plain `vite build` has neither.
 */
export default defineConfig(({ mode }) => ({
  define: mode === 'perf' ? { 'import.meta.env.VITE_PERF_AUTOMATION': JSON.stringify('true') } : {},
  plugins: [zkArtefacts()],
  resolve: {
    alias: {
      // shared/poseidon.ts only needs buildPoseidon. circomlibjs's index also pulls in EdDSA,
      // MiMC contracts and blake-hash (Node Buffer), which break in the browser.
      circomlibjs: join(ROOT, 'node_modules', 'circomlibjs', 'src', 'poseidon_wasm.js'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['..'] },
  },
  preview: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
}));
