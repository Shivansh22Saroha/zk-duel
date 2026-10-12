/**
 * Per-connection WS rate limits (SECURITY §4): one token bucket per message category, refilled at
 * the category's rate (messages per second) up to its burst capacity.
 *
 * Snapshots get a large burst (RATE_LIMIT_SNAPSHOT_BURST): the tick checks in MatchRoom already
 * bound how many snapshots a client can get accepted, and a dropped honest snapshot breaks that
 * player's window digest. The previous fixed 1-second windows (cap 70 at 60 ticks/s) dropped the
 * catch-up burst after a ~170 ms browser stall.
 */
import {
  RATE_LIMIT_COMMITS_PER_S,
  RATE_LIMIT_OTHER_PER_S,
  RATE_LIMIT_PROOFS_PER_S,
  RATE_LIMIT_SNAPSHOT_BURST,
  RATE_LIMIT_SNAPSHOTS_PER_S,
} from '@zkduel/shared/constants';

export type Category = 'snapshot' | 'proof' | 'commit' | 'other';

const SPEC: Record<Category, { perS: number; burst: number }> = {
  snapshot: { perS: RATE_LIMIT_SNAPSHOTS_PER_S, burst: RATE_LIMIT_SNAPSHOT_BURST },
  proof: { perS: RATE_LIMIT_PROOFS_PER_S, burst: RATE_LIMIT_PROOFS_PER_S },
  commit: { perS: RATE_LIMIT_COMMITS_PER_S, burst: RATE_LIMIT_COMMITS_PER_S },
  other: { perS: RATE_LIMIT_OTHER_PER_S, burst: RATE_LIMIT_OTHER_PER_S },
};

export class RateLimiter {
  private readonly tokens: Record<Category, number>;
  private readonly at: Record<Category, number>;

  constructor(now: number) {
    this.tokens = {
      snapshot: SPEC.snapshot.burst,
      proof: SPEC.proof.burst,
      commit: SPEC.commit.burst,
      other: SPEC.other.burst,
    };
    this.at = { snapshot: now, proof: now, commit: now, other: now };
  }

  /** Takes one token; false when the bucket is empty (message over the limit). */
  allow(cat: Category, now: number): boolean {
    const { perS, burst } = SPEC[cat];
    const t = Math.min(burst, this.tokens[cat] + (Math.max(0, now - this.at[cat]) * perS) / 1000);
    this.at[cat] = now;
    if (t < 1) {
      this.tokens[cat] = t;
      return false;
    }
    this.tokens[cat] = t - 1;
    return true;
  }
}
