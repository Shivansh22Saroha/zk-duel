/** Builds the Fastify app + WS gateway + match manager + fixed-step loop. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { TICK_RATE } from '@zkduel/shared/constants';
import { constantsHash } from '@zkduel/shared/canonical';
import { initialCommit, poseidonReady } from '@zkduel/shared/poseidon';
import { Auth } from './auth/jwt';
import type { Config } from './config';
import { openDb, type DB } from './db/index';
import { Repo } from './db/repo';
import { BenchStore, registerBenchRoutes } from './http/bench';
import { registerRoutes, sendError } from './http/routes';
import { FixedLoop } from './match/loop';
import { MatchManager } from './match/manager';
import { Gateway } from './ws/gateway';
import { loadVariant } from './zk/variant';
import { VerifierPool } from './zk/verifierPool';

/** server/package.json version (sent in `welcome`; informational — compatibility is constantsHash). */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export interface AppHandle {
  app: FastifyInstance;
  db: DB;
  repo: Repo;
  auth: Auth;
  manager: MatchManager;
  gateway: Gateway;
  verifier: VerifierPool;
  constantsHash: string;
}

export interface BuildOptions {
  onClientFrame?: (playerId: string | null, raw: string) => void;
}

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<AppHandle> {
  const db = openDb(cfg.dbPath);
  const repo = new Repo(db);
  repo.pruneSessions();
  const auth = new Auth(repo, cfg.JWT_SECRET, cfg.JWT_TTL_HOURS);
  const hash = await constantsHash();
  // Build Poseidon once at boot: a cold build takes seconds and would delay the first match_found
  // (and the per-tick DigestBuilder uses the synchronous hasher).
  await poseidonReady();
  await initialCommit();
  const variant = loadVariant(cfg.artefactDir, cfg.ACTIVE_VARIANT);
  const verifier = new VerifierPool(
    variant.vkeyPath,
    cfg.scheme,
    cfg.VERIFIER_THREADS,
    cfg.VERIFY_TIMEOUT_MS,
  );
  await verifier.ready();

  const app = Fastify({
    logger: cfg.LOG_LEVEL === 'silent' ? false : { level: cfg.LOG_LEVEL },
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'wss:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
      },
    },
    hsts: cfg.NODE_ENV === 'production',
  });
  await app.register(cors, { origin: cfg.ALLOWED_ORIGINS });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      message: `Too many requests; retry in ${ctx.after}.`,
    }),
  });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    const message = err.message ?? 'Error.';
    if (status === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message } });
    if (status >= 400 && status < 500) return sendError(reply, 400, 'INVALID_BODY', message);
    app.log.error(err);
    return sendError(reply, 500, 'INTERNAL', 'Internal error.');
  });

  // gateway and manager reference each other; the gateway reads the manager lazily
  const ref: { manager?: MatchManager } = {};
  const gateway = new Gateway(auth, () => ref.manager as MatchManager, {
    allowedOrigins: cfg.ALLOWED_ORIGINS,
    devCheats: cfg.DEV_CHEATS,
    constantsHash: hash,
    serverVersion: SERVER_VERSION,
    onClientFrame: opts.onClientFrame,
    log: app.log,
  });
  const manager = new MatchManager(repo, (pid) => gateway.linkOf(pid), {
    scheme: cfg.scheme,
    windowTicks: cfg.windowTicks,
    defaultEnforcement: cfg.DEFAULT_ENFORCEMENT,
    logSnapshots: cfg.LOG_SNAPSHOTS,
    logger: app.log,
    errorLog: app.log,
    snapshotLogDir: cfg.snapshotLogDir,
    constantsHash: hash,
    proofGraceWindows: cfg.PROOF_GRACE_WINDOWS,
    variant: variant.info,
    verifier,
    proofDeadlineMs: cfg.PROOF_DEADLINE_MS,
    auditTimeoutMs: cfg.AUDIT_TIMEOUT_MIN * 60_000,
    storeProofs: cfg.STORE_PROOFS,
    now: () => performance.now(),
  });
  ref.manager = manager;

  registerRoutes(app, { cfg, repo, auth, manager, constantsHash: hash, startedAt: Date.now() });
  registerBenchRoutes(app, new BenchStore(db), cfg.BENCH_TOKEN);

  app.server.on('upgrade', gateway.handleUpgrade);
  const loop = new FixedLoop(TICK_RATE, () => manager.tick());
  app.addHook('onReady', async () => loop.start());
  app.addHook('onClose', async () => {
    loop.stop();
    gateway.close();
    await verifier.close();
    db.close();
  });

  return { app, db, repo, auth, manager, gateway, verifier, constantsHash: hash };
}
