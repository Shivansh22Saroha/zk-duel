/** TimingStats: rolling samples and their summary (server tick time, verify time). */
import { describe, expect, it } from 'vitest';
import { TimingStats } from './stats';

describe('TimingStats', () => {
  it('summary of no samples is all zero', () => {
    expect(new TimingStats().summary()).toEqual({ n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it('mean, nearest-rank percentiles and max, independent of insertion order', () => {
    const t = new TimingStats();
    for (const ms of [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]) t.record(ms);
    expect(t.summary()).toEqual({ n: 10, mean: 5.5, p50: 6, p95: 10, p99: 10, max: 10 });
  });

  it('keeps only the newest `cap` samples', () => {
    const t = new TimingStats(3);
    for (const ms of [100, 1, 2, 3]) t.record(ms);
    expect(t.summary()).toMatchObject({ n: 3, max: 3, mean: 2 });
  });

  it('reset() clears the samples', () => {
    const t = new TimingStats();
    t.record(5);
    t.reset();
    expect(t.summary().n).toBe(0);
  });
});
