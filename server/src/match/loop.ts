/**
 * Fixed-step loop using a performance.now() accumulator (ARCHITECTURE §6: no setInterval).
 * Each wake-up runs as many steps as are due (capped), then sleeps until the next step.
 */
import { performance } from 'node:perf_hooks';

const MAX_CATCH_UP_STEPS = 10;

export class FixedLoop {
  private timer: NodeJS.Timeout | null = null;
  private next = 0;

  constructor(
    private readonly hz: number,
    private readonly step: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    const dt = 1000 / this.hz;
    this.next = performance.now();
    const run = (): void => {
      const now = performance.now();
      let n = 0;
      while (now >= this.next && n < MAX_CATCH_UP_STEPS) {
        this.step();
        this.next += dt;
        n++;
      }
      if (now - this.next > 1000) this.next = now; // fell far behind (e.g. debugger): resync
      this.timer = setTimeout(run, Math.max(0, this.next - performance.now()));
    };
    run();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
