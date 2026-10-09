/** Frame-time instrumentation (NFR-2: < 20 ms p95). Keeps the last N samples. */
export class FrameStats {
  private intervals: number[] = [];
  private work: number[] = [];
  private last: number | null = null;

  constructor(private readonly cap = 3600) {}

  /** Call at the start of each rAF callback. */
  frame(now: number): void {
    if (this.last !== null) this.push(this.intervals, now - this.last);
    this.last = now;
  }

  /** Record how long this frame's sim + render work took. */
  addWork(ms: number): void {
    this.push(this.work, ms);
  }

  reset(): void {
    this.intervals = [];
    this.work = [];
    this.last = null;
  }

  private push(arr: number[], v: number): void {
    if (arr.length >= this.cap) arr.shift();
    arr.push(v);
  }

  static pct(arr: readonly number[], p: number): number {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  }

  summary(): {
    frames: number;
    fps: number;
    intervalP50: number;
    intervalP95: number;
    intervalMax: number;
    workP50: number;
    workP95: number;
    workMax: number;
  } {
    const n = this.intervals.length;
    const mean = n ? this.intervals.reduce((a, b) => a + b, 0) / n : 0;
    return {
      frames: n,
      fps: mean ? 1000 / mean : 0,
      intervalP50: FrameStats.pct(this.intervals, 0.5),
      intervalP95: FrameStats.pct(this.intervals, 0.95),
      intervalMax: n ? Math.max(...this.intervals) : 0,
      workP50: FrameStats.pct(this.work, 0.5),
      workP95: FrameStats.pct(this.work, 0.95),
      workMax: this.work.length ? Math.max(...this.work) : 0,
    };
  }
}
