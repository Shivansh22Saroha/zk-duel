/**
 * Phase 5 CSV export (ARCHITECTURE §8) from the server database (read-only):
 *  - bench/out/results.csv        every benchmark sample of every run (+ environment, device)
 *  - bench/out/match-metrics.csv  per-match research metrics: challenge count, challenge rate r,
 *                                 detection latency, audit duration, audit status, verdict
 *
 *   npm run bench:export   (DB_PATH from server/.env, default server/data/zkduel.db)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_CSV_COLUMNS, csvField } from '@zkduel/shared/benchStats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// better-sqlite3 is a server dependency; load it from there (no second native build)
const Database = createRequire(join(ROOT, 'server', 'package.json'))('better-sqlite3') as new (
  path: string,
  opts: { readonly: boolean },
) => { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void };

function dbPath(): string {
  let p = './data/zkduel.db';
  try {
    p =
      /^DB_PATH=(.+)$/m.exec(readFileSync(join(ROOT, 'server', '.env'), 'utf8'))?.[1]?.trim() ?? p;
  } catch {
    // no server/.env: default path
  }
  return resolve(ROOT, 'server', p);
}

function toCsv(columns: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join(',')];
  for (const r of rows)
    lines.push(columns.map((c) => csvField(r[c] as string | number | null)).join(','));
  return lines.join('\r\n') + '\r\n';
}

const db = new Database(dbPath(), { readonly: true });
const out = join(ROOT, 'bench', 'out');
mkdirSync(out, { recursive: true });

const results = db
  .prepare(
    `SELECT r.run_id, b.environment, b.device_label, r.scheme, r.window_ticks, r.constraints,
       r.sample_no, r.witness_ms, r.prove_ms, r.verify_ms, r.proof_bytes, r.valid, r.peak_mem_mb
     FROM benchmark_results r JOIN benchmark_runs b ON b.id = r.run_id
     ORDER BY b.created_at, r.scheme, r.window_ticks, r.sample_no`,
  )
  .all();
writeFileSync(join(out, 'results.csv'), toCsv(BENCH_CSV_COLUMNS, results));

const METRIC_COLUMNS = [
  'match_id',
  'mode',
  'enforcement',
  'scheme',
  'window_ticks',
  'status',
  'end_reason',
  'started_at',
  'total_ticks',
  'player_index',
  'windows',
  'windows_committed',
  'challenges',
  'challenges_passed',
  'challenge_rate',
  'detection_latency_windows',
  'detection_latency_ms',
  'audit_ms',
  'player_audit_status',
  'match_audit_status',
  'result_verdict',
  'overturned',
] as const;
const metrics = db
  .prepare(
    `SELECT m.id AS match_id, m.mode, m.enforcement, m.scheme, m.window_ticks, m.status,
       m.end_reason, m.started_at, m.total_ticks, p.player_index, p.windows, p.windows_committed,
       p.challenges, p.challenges_passed, p.challenge_rate, p.detection_latency_windows,
       p.detection_latency_ms, p.audit_ms, p.audit_status AS player_audit_status,
       m.audit_status AS match_audit_status, m.result_verdict, m.overturned
     FROM match_players p JOIN matches m ON m.id = p.match_id
     WHERE m.status = 'finished' ORDER BY m.started_at, p.player_index`,
  )
  .all();
writeFileSync(join(out, 'match-metrics.csv'), toCsv(METRIC_COLUMNS, metrics));
db.close();
console.log(
  `wrote bench/out/results.csv (${results.length} samples), bench/out/match-metrics.csv (${metrics.length} player rows)`,
);
