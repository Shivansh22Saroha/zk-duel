/**
 * DigestBuilder (ARCHITECTURE §4/§6): one per player per round. The same Poseidon chain as the
 * circuit (circuits/src/digest.circom, shared/zkInput.ts digestOf), fed with the snapshots the
 * client actually sent.
 *
 * Tick t is hashed only when both hold:
 *  - t is known to belong to the round: t ≤ `limit` (the server has processed t; at round end
 *    the limit becomes endTick) — so ticks a client sent past endTick never enter the digest;
 *  - t's value is final: its snapshot arrived, or a later snapshot arrived (snapshots arrive in
 *    order, so t was skipped by the client), or t is past the late bound (it can no longer be
 *    accepted). Skipped / never-arrived ticks are filled with the previous snapshot and
 *    fired = 0 — exactly how the client fills them locally.
 * So a late honest snapshot is always part of the digest even when hit detection held it.
 * Only the running hash, the last snapshot, a few pending snapshots and the per-window digests
 * are kept.
 */
import { poseidonSync } from '@zkduel/shared/poseidon';
import type { PublicSnap } from '@zkduel/shared/sim';
import { toField } from '@zkduel/shared/zkInput';

const seedOf = (s: PublicSnap): string => poseidonSync([s.x, s.y, s.angle, s.fired].map(toField));

export class DigestBuilder {
  private h: string;
  private next = 0;
  private last: PublicSnap;
  private readonly pending = new Map<number, PublicSnap>();
  private maxRecv = -1;
  private limit = -1;
  private lateBound = -1;
  private endTick: number | null = null;
  /** true: the match ended mid-window (forfeit/disconnect) — the partial window is not padded. */
  private cutoff = false;
  private closed = false;

  /**
   * @param n window size in ticks
   * @param prev the round's `prevSnapshot` (spawn, fired = 0)
   * @param onFinal called once per window, in order, with its digest
   * @param onHold called once per run of gap-filled ticks (skipped or never arrived), not for
   *   round-end padding
   */
  constructor(
    private readonly n: number,
    prev: PublicSnap,
    private readonly onFinal: (windowIndex: number, digest: string) => void,
    private readonly onHold?: (fromTick: number, count: number) => void,
  ) {
    this.last = prev;
    this.h = seedOf(prev);
  }

  /** Next tick the chain expects. */
  get nextTick(): number {
    return this.next;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** A snapshot the client sent for `tick` (callers deliver ticks in increasing order). */
  push(tick: number, s: PublicSnap): void {
    if (this.closed || tick < this.next) return;
    if (this.endTick !== null && tick > this.endTick) return;
    this.pending.set(tick, { x: s.x, y: s.y, angle: s.angle, fired: s.fired });
    if (tick > this.maxRecv) this.maxRecv = tick;
    this.advance();
  }

  /** The server processed tick `t`: every tick ≤ t belongs to the round. */
  setLimit(t: number): void {
    if (this.endTick !== null) return;
    if (t > this.limit) this.limit = t;
    this.advance();
  }

  /** Ticks ≤ `t` can no longer be accepted (late bound): their values are final. */
  setLateBound(t: number): void {
    if (t > this.lateBound) this.lateBound = t;
    this.advance();
  }

  /** The round ended at `endTick`: its window is padded and finalised once ticks ≤ endTick are final. */
  setEndTick(endTick: number): void {
    if (this.endTick !== null) return;
    this.endTick = endTick;
    this.limit = endTick;
    for (const t of this.pending.keys()) if (t > endTick) this.pending.delete(t);
    this.advance();
  }

  /**
   * The match ended mid-round after tick `lastTick`: complete windows up to it still finalise
   * (late snapshots welcome); the unfinished window after it does not exist.
   */
  stopAt(lastTick: number): void {
    if (this.endTick !== null) return;
    this.cutoff = true;
    this.setEndTick(lastTick);
  }

  /** Finalise whatever is still open (the next round started): missing ticks are held. */
  close(): void {
    if (this.closed) return;
    if (this.endTick === null) {
      this.closed = true; // the round never ended: its open window does not exist
      return;
    }
    this.setLateBound(this.endTick);
  }

  private hold(): PublicSnap {
    return { x: this.last.x, y: this.last.y, angle: this.last.angle, fired: 0 };
  }

  private advance(): void {
    let holdFrom = -1;
    const flush = (): void => {
      if (holdFrom >= 0) this.onHold?.(holdFrom, this.next - holdFrom);
      holdFrom = -1;
    };
    while (!this.closed && this.next <= this.limit) {
      const s = this.pending.get(this.next);
      if (s) {
        flush();
        this.pending.delete(this.next);
        this.add(s);
      } else if (this.maxRecv > this.next || this.next <= this.lateBound) {
        if (holdFrom < 0) holdFrom = this.next;
        this.add(this.hold());
      } else {
        break; // may still arrive
      }
    }
    flush();
    this.maybeClose();
  }

  private add(s: PublicSnap): void {
    const t = this.next++;
    this.h = poseidonSync([this.h, s.x, s.y, s.angle, s.fired].map(toField));
    this.last = s;
    if (t % this.n === this.n - 1) {
      this.onFinal(Math.floor(t / this.n), this.h);
      this.h = seedOf(s);
    }
  }

  private maybeClose(): void {
    if (this.closed || this.endTick === null || this.next <= this.endTick) return;
    // round-end padding: hold the snapshot at endTick (fired = 0) up to the window's end
    if (!this.cutoff) while (this.next % this.n !== 0) this.add(this.hold());
    this.closed = true;
    this.pending.clear();
  }
}
