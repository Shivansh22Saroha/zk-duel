import { describe, expect, it } from 'vitest';
import {
  BENCH_LOG_TICKS,
  BENCH_SAMPLES,
  BENCH_SEED,
  BENCH_WARMUPS,
  BENCH_WINDOW_TICKS,
} from './constants';
import { benchLogSha256, benchWindows, generateBenchLog } from './benchLog';
import { checkSequence, spawnState, type TickRecord } from './sim';

describe('benchmark input log', () => {
  const log = generateBenchLog(BENCH_SEED);
  const ticks = log.filter((l) => l.type === 'tick') as unknown as TickRecord[];

  it('is deterministic for a seed and differs across seeds', async () => {
    expect(await benchLogSha256(generateBenchLog(BENCH_SEED))).toBe(await benchLogSha256(log));
    expect(await benchLogSha256(generateBenchLog(BENCH_SEED + 1))).not.toBe(
      await benchLogSha256(log),
    );
  });

  it('obeys every rule (checkSequence = circuit mirror) and exercises the weapon', () => {
    expect(ticks).toHaveLength(BENCH_LOG_TICKS);
    expect(checkSequence(spawnState(0), ticks)).toBeNull();
    expect(ticks.filter((t) => t.fired === 1).length).toBeGreaterThan(50);
    expect(ticks.some((t) => t.reloadTimer > 0)).toBe(true);
    expect(new Set(ticks.map((t) => `${t.x},${t.y}`)).size).toBeGreaterThan(200);
  });

  it('yields warm-up + sample windows for every benchmark N, all unpadded', () => {
    for (const n of BENCH_WINDOW_TICKS) {
      const w = benchWindows(log, n, BENCH_SEED);
      expect(w).toHaveLength(BENCH_WARMUPS + BENCH_SAMPLES);
      expect(w.every((x) => !x.padded && x.records.length === n)).toBe(true);
    }
  });
});
