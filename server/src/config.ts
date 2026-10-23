/**
 * Server configuration from environment (docs/ENVIRONMENT.md §1), validated with zod at boot.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AUDIT_TIMEOUT_MIN,
  PROOF_DEADLINE_MS,
  PROOF_GRACE_WINDOWS,
  SCHEMES,
  WINDOW_TICKS_VARIANTS,
} from '@zkduel/shared/constants';

/** Server package root; relative paths in env are resolved against it. */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_JWT_SECRET = 'change-me-generate-with-openssl-rand-hex-32';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const variantRe = new RegExp(`^(${SCHEMES.join('|')})_(\\d+)$`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_HOURS: z.coerce.number().positive().default(24),
  DB_PATH: z.string().default('./data/zkduel.db'),
  ZK_ARTEFACT_DIR: z.string().default('../circuits/build'),
  ACTIVE_VARIANT: z
    .string()
    .regex(variantRe, 'ACTIVE_VARIANT must look like groth16_60')
    .refine((v) => (WINDOW_TICKS_VARIANTS as readonly number[]).includes(Number(v.split('_')[1])), {
      message: 'unsupported window size in ACTIVE_VARIANT',
    })
    .default('groth16_60'),
  PROOF_GRACE_WINDOWS: z.coerce.number().int().min(1).default(PROOF_GRACE_WINDOWS),
  PROOF_DEADLINE_MS: z.coerce.number().int().min(100).default(PROOF_DEADLINE_MS),
  AUDIT_TIMEOUT_MIN: z.coerce.number().positive().default(AUDIT_TIMEOUT_MIN),
  DEFAULT_ENFORCEMENT: z.enum(['observe', 'strict']).default('observe'),
  VERIFIER_THREADS: z.coerce.number().int().min(1).default(2),
  VERIFY_TIMEOUT_MS: z.coerce.number().int().min(1).default(2000),
  DEV_CHEATS: bool.default('false'),
  STORE_PROOFS: bool.default('false'),
  LOG_SNAPSHOTS: bool.default('false'),
  PUBLIC_MATCHES: bool.default('false'),
  BENCH_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export interface Config extends Env {
  scheme: (typeof SCHEMES)[number];
  windowTicks: number;
  /** Absolute paths. */
  dbPath: string;
  artefactDir: string;
  snapshotLogDir: string;
  /** Server log file, `<logs>/server-<local date at boot>.log`; written alongside stdout. */
  logFile: string;
}

/** Local calendar date as YYYY-MM-DD. */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function abs(p: string): string {
  return p === ':memory:' || isAbsolute(p) ? p : resolve(SERVER_ROOT, p);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = envSchema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(
      `Invalid server environment:\n${msg}\nSee docs/ENVIRONMENT.md and server/.env.example.`,
    );
  }
  const e = r.data;
  if (e.NODE_ENV === 'production') {
    if (e.JWT_SECRET === EXAMPLE_JWT_SECRET)
      throw new Error('JWT_SECRET is the example value; refusing to boot in production.');
    if (e.DEV_CHEATS) throw new Error('DEV_CHEATS must be false in production.');
  }
  const [scheme, n] = e.ACTIVE_VARIANT.split('_') as [Config['scheme'], string];
  const dbPath = abs(e.DB_PATH);
  const logDir =
    dbPath === ':memory:' ? resolve(SERVER_ROOT, 'data/logs') : resolve(dirname(dbPath), 'logs');
  return {
    ...e,
    scheme,
    windowTicks: Number(n),
    dbPath,
    artefactDir: abs(e.ZK_ARTEFACT_DIR),
    snapshotLogDir: logDir,
    logFile: join(logDir, `server-${localDate(new Date())}.log`),
  };
}
