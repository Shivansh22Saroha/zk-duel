/** Rolling timing samples (ms) for server tick processing — NFR-1 (< 2 ms per tick). */
export class TimingStats {
  private samples: number[] = [];
  constructor(private readonly cap = 200_000) {}

  record(ms: number): void {
    if (this.samples.length >= this.cap) this.samples.shift();
    this.samples.push(ms);
  }

  reset(): void {
    this.samples = [];
  }

  summary(): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } {
    const s = [...this.samples].sort((a, b) => a - b);
    const n = s.length;
    const q = (p: number): number => (n ? (s[Math.min(n - 1, Math.floor(p * n))] as number) : 0);
    return {
      n,
      mean: n ? s.reduce((a, b) => a + b, 0) / n : 0,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      max: n ? (s[n - 1] as number) : 0,
    };
  }
}

/** Process-wide collector of per-tick processing time across all rooms. */
export const tickTiming = new TimingStats();
