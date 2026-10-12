/**
 * Deterministic benchmark input log (Phase 5, FEATURES F15, NFR-7).
 *
 * One long round of a seeded bot (player 0 from its spawn) stepped through the real rules in
 * `sim.ts`: it wanders, turns towards random aim targets, holds fire (cooldown, ammo and the
 * auto-reload are all exercised) and sometimes presses reload. The log is a normal client tick
 * log, so benchmark windows are cut by the same `sliceLogWindows` path as real matches.
 *
 * Node (`bench/run.ts`) and the browser (`/bench`) generate it from the same seed, and both
 * report its SHA-256 — identical inputs are checked, not assumed. The log holds private state;
 * it is generated locally and never sent anywhere (only its hash and name are uploaded).
 */
import {
  ANGLE_UNITS,
  BENCH_LOG_TICKS,
  BENCH_RELOAD_CHANCE,
  BENCH_SAMPLES,
  BENCH_TURN_CHANCE,
  BENCH_WARMUPS,
  WINDOW_TICKS,
} from './constants';
import { sha256Hex } from './canonical';
import { mulberry32, randInt } from './rng';
import { spawnState, stepPlayer, toRecord, toTuple } from './sim';
import { TICKLOG_VERSION, type TickLogLine } from './ticklog';
import { sliceLogWindows, testSalt, type LogWindow } from './zkInput';

export function benchLogName(seed: number, ticks: number = BENCH_LOG_TICKS): string {
  return `bench-seed${seed}-${ticks}t.jsonl`;
}

export function generateBenchLog(seed: number, ticks: number = BENCH_LOG_TICKS): TickLogLine[] {
  const rng = mulberry32(seed);
  const start = spawnState(0);
  const lines: TickLogLine[] = [
    {
      type: 'header',
      version: TICKLOG_VERSION,
      source: 'client',
      matchId: benchLogName(seed, ticks),
      matchField: String(seed),
      playerIndex: 0,
      windowTicks: WINDOW_TICKS,
      constantsHash: '',
      createdAt: 0,
    },
    { type: 'round_start', roundNo: 1, prevSnapshot: toTuple(start.pub), initialCommit: '0' },
  ];
  let s = start;
  let moveX = 1;
  let moveY = 0;
  let aimTarget = start.pub.angle;
  for (let t = 0; t < ticks; t++) {
    if (rng() < BENCH_TURN_CHANCE) {
      moveX = randInt(rng, -1, 1);
      moveY = randInt(rng, -1, 1);
      aimTarget = randInt(rng, 0, ANGLE_UNITS - 1);
    }
    const r = stepPlayer(s, {
      moveX,
      moveY,
      aimTarget,
      fire: true,
      reload: rng() < BENCH_RELOAD_CHANCE,
    });
    s = r.state;
    lines.push({ type: 'tick', roundNo: 1, ...toRecord(t, s, r.reloadPress) });
  }
  lines.push({ type: 'round_end', roundNo: 1, endTick: ticks - 1, winnerIndex: 0 });
  return lines;
}

export function benchLogText(lines: readonly TickLogLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function benchLogSha256(lines: readonly TickLogLine[]): Promise<string> {
  return sha256Hex(benchLogText(lines));
}

/** The warm-up + sample windows of size `n` (same seed → same windows everywhere). */
export function benchWindows(lines: readonly TickLogLine[], n: number, seed: number): LogWindow[] {
  const all = sliceLogWindows(lines, n, testSalt(seed));
  const want = BENCH_WARMUPS + BENCH_SAMPLES;
  if (all.length < want)
    throw new Error(`bench log has ${all.length} windows of ${n}, need ${want}`);
  return all.slice(0, want);
}
