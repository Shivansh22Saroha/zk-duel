/**
 * Benchmark REST API (API_SPEC §3, Phase 5): list runs, per-variant aggregates, raw CSV, and the
 * token-protected upload used by `bench/run.ts` and the /bench browser runner. Bench data is
 * self-reported; the server re-verifies nothing.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { benchUploadBody } from '@zkduel/shared/protocol';
import {
  aggregate,
  BENCH_CSV_COLUMNS,
  csvField,
  type BenchSample,
} from '@zkduel/shared/benchStats';
import { BENCH_UPLOAD_MAX_BYTES, type Scheme } from '@zkduel/shared/constants';
import type { DB } from '../db/index';
import { sendError } from './routes';

interface RunRow {
  id: string;
  createdAt: number;
  environment: 'node' | 'browser';
  deviceLabel: string;
  userAgent: string | null;
  cpuThreads: number | null;
  inputLog: string;
  inputLogSha256: string | null;
  seed: number;
  gitCommit: string | null;
  notes: string | null;
}

interface ResultRow {
  scheme: Scheme;
  windowTicks: number;
  constraints: number;
  sampleNo: number;
  witnessMs: number;
  proveMs: number;
  verifyMs: number;
  proofBytes: number;
  valid: number;
  peakMemMb: number | null;
}

const RUN_COLS = `id, created_at AS createdAt, environment, device_label AS deviceLabel,
  user_agent AS userAgent, cpu_threads AS cpuThreads, input_log AS inputLog,
  input_log_sha256 AS inputLogSha256, seed, git_commit AS gitCommit, notes`;

export class BenchStore {
  constructor(private readonly db: DB) {}

  insert(body: ReturnType<typeof benchUploadBody.parse>, now: number): string {
    const id = randomUUID();
    const run = this.db.prepare(
      `INSERT INTO benchmark_runs (id, created_at, environment, device_label, user_agent,
         cpu_threads, input_log, input_log_sha256, seed, git_commit, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const res = this.db.prepare(
      `INSERT INTO benchmark_results (run_id, scheme, window_ticks, constraints, sample_no,
         witness_ms, prove_ms, verify_ms, proof_bytes, valid, peak_mem_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      run.run(
        id,
        now,
        body.environment,
        body.deviceLabel,
        body.userAgent ?? null,
        body.cpuThreads ?? null,
        body.inputLog,
        body.inputLogSha256 ?? null,
        body.seed,
        body.gitCommit ?? null,
        body.notes ?? null,
      );
      for (const r of body.results) {
        res.run(
          id,
          r.scheme,
          r.windowTicks,
          r.constraints,
          r.sampleNo,
          r.witnessMs,
          r.proveMs,
          r.verifyMs,
          r.proofBytes,
          r.valid ? 1 : 0,
          r.peakMemMb ?? null,
        );
      }
    })();
    return id;
  }

  runs(): (RunRow & { samples: number })[] {
    return this.db
      .prepare(
        `SELECT ${RUN_COLS}, (SELECT COUNT(*) FROM benchmark_results r WHERE r.run_id = b.id) AS samples
         FROM benchmark_runs b ORDER BY created_at DESC`,
      )
      .all() as (RunRow & { samples: number })[];
  }

  run(id: string): RunRow | null {
    return (
      (this.db.prepare(`SELECT ${RUN_COLS} FROM benchmark_runs WHERE id = ?`).get(id) as
        RunRow | undefined) ?? null
    );
  }

  results(id: string): ResultRow[] {
    return this.db
      .prepare(
        `SELECT scheme, window_ticks AS windowTicks, constraints, sample_no AS sampleNo,
           witness_ms AS witnessMs, prove_ms AS proveMs, verify_ms AS verifyMs,
           proof_bytes AS proofBytes, valid, peak_mem_mb AS peakMemMb
         FROM benchmark_results WHERE run_id = ? ORDER BY scheme, window_ticks, sample_no`,
      )
      .all(id) as ResultRow[];
  }
}

const toSample = (r: ResultRow): BenchSample => ({ ...r, valid: r.valid === 1 });

function tokenOk(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerBenchRoutes(
  app: FastifyInstance,
  store: BenchStore,
  benchToken: string | undefined,
): void {
  app.get('/api/bench/runs', async () => ({ runs: store.runs() }));

  app.get<{ Params: { id: string } }>('/api/bench/runs/:id', async (req, reply) => {
    const run = store.run(req.params.id);
    if (!run) return sendError(reply, 404, 'NOT_FOUND', 'Benchmark run not found.');
    return { run, variants: aggregate(store.results(run.id).map(toSample)) };
  });

  app.get<{ Params: { id: string } }>('/api/bench/runs/:id/csv', async (req, reply) => {
    const run = store.run(req.params.id);
    if (!run) return sendError(reply, 404, 'NOT_FOUND', 'Benchmark run not found.');
    const lines = [BENCH_CSV_COLUMNS.join(',')];
    for (const r of store.results(run.id)) {
      lines.push(
        [
          run.id,
          run.environment,
          run.deviceLabel,
          r.scheme,
          r.windowTicks,
          r.constraints,
          r.sampleNo,
          r.witnessMs,
          r.proveMs,
          r.verifyMs,
          r.proofBytes,
          r.valid,
          r.peakMemMb,
        ]
          .map(csvField)
          .join(','),
      );
    }
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bench-${run.id}.csv"`)
      .send(lines.join('\r\n') + '\r\n');
  });

  app.post(
    '/api/bench/runs',
    {
      bodyLimit: BENCH_UPLOAD_MAX_BYTES,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const h = req.headers['x-bench-token'];
      if (!tokenOk(typeof h === 'string' ? h : undefined, benchToken))
        return sendError(reply, 401, 'UNAUTHORIZED', 'Missing or wrong X-Bench-Token.');
      const r = benchUploadBody.safeParse(req.body);
      if (!r.success)
        return sendError(reply, 400, 'INVALID_BODY', r.error.issues[0]?.message ?? 'invalid');
      return reply.code(201).send({ runId: store.insert(r.data, Date.now()) });
    },
  );
}
