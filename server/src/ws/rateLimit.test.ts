import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_PROOFS_PER_S,
  RATE_LIMIT_SNAPSHOT_BURST,
  RATE_LIMIT_SNAPSHOTS_PER_S,
  STALL_TICKS,
  TICK_RATE,
} from '@zkduel/shared/constants';
import { RateLimiter } from './rateLimit';

const MS = 1000 / TICK_RATE;

/**
 * Arrival times (ms) of an honest client's snapshots: 60/s with a browser stall of `stallMs` at
 * `stallAt`, after which the ticks that came due during the stall arrive at once (the client
 * catches up), then 60/s again.
 */
function honestTrace(totalS: number, stallAt: number, stallMs: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < totalS * TICK_RATE; k++) {
    const due = 1000 + k * MS; // first second: connection set-up
    out.push(due >= stallAt && due < stallAt + stallMs ? stallAt + stallMs : due);
  }
  return out;
}

/** The Phase 1–5 limiter: fixed 1-second windows, RATE_LIMIT_SNAPSHOTS_PER_S per window. */
function oldFixedWindowRejects(times: number[]): number {
  let start = 0;
  let count = 0;
  let rejected = 0;
  for (const now of times) {
    if (now - start >= 1000) {
      start = now;
      count = 0;
    }
    if (++count > RATE_LIMIT_SNAPSHOTS_PER_S) rejected++;
  }
  return rejected;
}

describe('RateLimiter (snapshots)', () => {
  // Phase 6 bug: two Chrome windows on one laptop stalled ~170 ms together; both clients' catch-up
  // bursts were rate-limited, the server held those ticks, and one window per player ended
  // mismatch_digest in an honest match.
  it('regression: a stall + catch-up burst of an honest client is never rate-limited', () => {
    for (const stallMs of [120, 170, 250, 400]) {
      for (let stallAt = 1500; stallAt < 3500; stallAt += 37) {
        const times = honestTrace(5, stallAt, stallMs);
        const rl = new RateLimiter(0);
        const rejected = times.filter((now) => !rl.allow('snapshot', now)).length;
        expect(rejected, `stall ${stallMs} ms at ${stallAt} ms`).toBe(0);
      }
    }
  });

  it('the old fixed-window limiter rejected those honest bursts (reproduces the bug)', () => {
    let worst = 0;
    for (let stallAt = 1500; stallAt < 3500; stallAt += 37)
      worst = Math.max(worst, oldFixedWindowRejects(honestTrace(5, stallAt, 170)));
    expect(worst).toBeGreaterThan(0);
  });

  it('the burst covers every tick the server can still accept (late limit + STALL_TICKS)', () => {
    expect(RATE_LIMIT_SNAPSHOT_BURST).toBeGreaterThanOrEqual(2 * 120 + STALL_TICKS);
  });

  it('a flood is still limited: burst, then RATE_LIMIT_SNAPSHOTS_PER_S per second', () => {
    const rl = new RateLimiter(0);
    let ok = 0;
    for (let i = 0; i < 1000; i++) if (rl.allow('snapshot', 0)) ok++;
    expect(ok).toBe(RATE_LIMIT_SNAPSHOT_BURST);
    ok = 0;
    for (let i = 0; i < 1000; i++) if (rl.allow('snapshot', 1000)) ok++;
    expect(ok).toBe(RATE_LIMIT_SNAPSHOTS_PER_S);
  });

  it('other categories keep their per-second budget', () => {
    const rl = new RateLimiter(0);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (rl.allow('proof', 0)) ok++;
    expect(ok).toBe(RATE_LIMIT_PROOFS_PER_S);
  });
});
