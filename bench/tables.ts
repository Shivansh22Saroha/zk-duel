/**
 * Phase 5: Markdown tables for bench/RESULTS.md from the raw run files in bench/out/raw/
 * (bench/out/excluded/ is never read). One row per environment × variant, latest run wins.
 *
 *   npx tsx bench/tables.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, type BenchSample } from '@zkduel/shared/benchStats';

const RAW = join(resolve(dirname(fileURLToPath(import.meta.url))), 'out', 'raw');

interface RawRun {
  id: string;
  ok: boolean;
  error?: string;
  samples?: BenchSample[];
}

const rows = new Map<string, { env: string; file: string; run: RawRun }>();
for (const file of readdirSync(RAW)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const raw = JSON.parse(readFileSync(join(RAW, file), 'utf8')) as {
    environment?: string;
    runs?: RawRun[];
    variants?: RawRun[];
  };
  const env = raw.environment ?? (file.startsWith('browser') ? 'browser' : 'node');
  for (const run of raw.runs ?? raw.variants ?? [])
    rows.set(`${env}|${run.id}`, { env, file, run });
}

const s = (ms: number): string => (ms / 1000).toFixed(2);
console.log(
  '| env | variant | constraints | n (valid) | witness p50 ms | prove mean s | p5 | p50 | p95 | verify p50 ms | proof B | peak MiB | prove/play | r_max | file |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const { env, file, run } of [...rows.values()].sort((a, b) =>
  `${a.env}${a.run.id}`.localeCompare(`${b.env}${b.run.id}`, 'en', { numeric: true }),
)) {
  const a = run.samples?.length ? aggregate(run.samples)[0] : undefined;
  if (!run.ok || !a) {
    console.log(
      `| ${env} | ${run.id} | | 0 | | **failed:** ${run.error ?? 'no samples'} | | | | | | | | | ${file} |`,
    );
    continue;
  }
  console.log(
    `| ${env} | ${run.id} | ${a.constraints.toLocaleString('en')} | ${a.n} (${a.valid}) | ${a.witnessMs.p50.toFixed(0)} | ${s(a.proveMs.mean)} | ${s(a.proveMs.p5)} | ${s(a.proveMs.p50)} | ${s(a.proveMs.p95)} | ${a.verifyMs.p50.toFixed(1)} | ${a.proofBytes} | ${a.peakMemMb?.toFixed(0) ?? '–'} | ${a.proveToPlay.toFixed(2)} | ${a.rMax.toFixed(2)} | ${file} |`,
  );
}
