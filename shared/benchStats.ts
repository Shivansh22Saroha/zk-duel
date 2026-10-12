/**
 * Benchmark aggregates (Phase 5) — one implementation for the server API, the Node runner's
 * console summary and the /bench dashboard.
 */
import { TICK_RATE, type Scheme } from './constants';

export interface BenchSample {
  scheme: Scheme;
  windowTicks: number;
  constraints: number;
  sampleNo: number;
  witnessMs: number;
  proveMs: number;
  verifyMs: number;
  proofBytes: number;
  valid: boolean;
  peakMemMb?: number | null;
}

export interface Dist {
  mean: number;
  p5: number;
  p50: number;
  p95: number;
}

export interface VariantAggregate {
  scheme: Scheme;
  windowTicks: number;
  constraints: number;
  n: number;
  valid: number;
  witnessMs: Dist;
  proveMs: Dist;
  verifyMs: Dist;
  proofBytes: number;
  peakMemMb: number | null;
  /** Play time covered by one window (N / TICK_RATE), ms. */
  playMs: number;
  /** Mean prove time / play time: < 1 means one prover keeps up with live play. */
  proveToPlay: number;
  /**
   * Max sustainable challenge rate for one prover: window duration / mean prove time (fraction
   * of windows that can be proven as fast as they are played; ≥ 1 = every window).
   */
  rMax: number;
}

/** Nearest-rank percentile (p in [0, 1]) of an unsorted list. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i] as number;
}

export function dist(values: readonly number[]): Dist {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    mean,
    p5: percentile(values, 0.05),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

export function aggregate(samples: readonly BenchSample[]): VariantAggregate[] {
  const groups = new Map<string, BenchSample[]>();
  for (const s of samples) {
    const k = `${s.scheme}_${s.windowTicks}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups.values()]
    .map((g) => {
      const first = g[0] as BenchSample;
      const proveMs = dist(g.map((s) => s.proveMs));
      const playMs = (first.windowTicks / TICK_RATE) * 1000;
      const mem = g.map((s) => s.peakMemMb).filter((m): m is number => typeof m === 'number');
      return {
        scheme: first.scheme,
        windowTicks: first.windowTicks,
        constraints: first.constraints,
        n: g.length,
        valid: g.filter((s) => s.valid).length,
        witnessMs: dist(g.map((s) => s.witnessMs)),
        proveMs,
        verifyMs: dist(g.map((s) => s.verifyMs)),
        proofBytes: Math.round(g.reduce((a, s) => a + s.proofBytes, 0) / g.length),
        peakMemMb: mem.length ? Math.max(...mem) : null,
        playMs,
        proveToPlay: proveMs.mean / playMs,
        rMax: playMs / proveMs.mean,
      };
    })
    .sort((a, b) => a.scheme.localeCompare(b.scheme) || a.windowTicks - b.windowTicks);
}

export const BENCH_CSV_COLUMNS = [
  'run_id',
  'environment',
  'device_label',
  'scheme',
  'window_ticks',
  'constraints',
  'sample_no',
  'witness_ms',
  'prove_ms',
  'verify_ms',
  'proof_bytes',
  'valid',
  'peak_mem_mb',
] as const;

/** RFC 4180 field: quoted when it contains a comma, quote or newline. */
export function csvField(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
