/**
 * WindowRecorder (ARCHITECTURE §7, FEATURES F9): freezes each window of a round once it is final
 * — the server's `state` for its last tick arrived and the local sim reached it, or `round_end`
 * with endTick inside it (truncated + padded) — draws a fresh saltOut, computes the commitment to
 * the window's last hidden state, and chains prev / hidden state / salt into the next window.
 * The frozen jobs (full private input) are kept by the ProofClient until the audit ends.
 * DOM-free: shared by the browser and the Node bots.
 */
import type { PlayerIndex } from '@zkduel/shared/constants';
import { INITIAL_HIDDEN, truncateAndPad, type Hidden, type TickRecord } from '@zkduel/shared/sim';
import { commitOf, randomSalt, type Tuple4, type WindowContext } from '@zkduel/shared/zkInput';

export interface WindowJob {
  roundNo: number;
  windowIndex: number;
  ctx: WindowContext;
  /** Exactly N records (padded at round end). */
  records: TickRecord[];
  commitOut: string;
  padded: boolean;
}

export class WindowRecorder {
  private roundNo = 0;
  private next = 0;
  private prev: Tuple4 = [0, 0, 0, 0];
  private hiddenIn: Hidden = { ...INITIAL_HIDDEN };
  private saltIn = '0';
  private endTick: number | null = null;
  private stopped = false;

  constructor(
    private readonly matchField: string,
    private readonly playerIndex: PlayerIndex,
    private readonly n: number,
    /** Salt source — randomSalt (crypto.getRandomValues) unless a test pins it. */
    private readonly salt: () => string = randomSalt,
  ) {}

  /** A new round: fresh chain from the public initial state (ARCHITECTURE §5.4). */
  startRound(roundNo: number, prevSnapshot: Tuple4): void {
    this.roundNo = roundNo;
    this.next = 0;
    this.prev = [...prevSnapshot] as Tuple4;
    this.hiddenIn = { ...INITIAL_HIDDEN };
    this.saltIn = '0';
    this.endTick = null;
    this.stopped = false;
  }

  /** round_end for the current round. */
  endRound(roundNo: number, endTick: number): void {
    if (roundNo === this.roundNo) this.endTick = endTick;
  }

  /** The chain is broken for the rest of this round (resume): commit nothing more. */
  stopRound(roundNo: number): void {
    if (roundNo === this.roundNo) this.stopped = true;
  }

  get currentRound(): number {
    return this.roundNo;
  }

  /** Index of the next window to freeze in the current round. */
  get nextWindow(): number {
    return this.next;
  }

  /**
   * Freeze every window that is final. `records` = the round's records in tick order (index =
   * tick); `serverTick` = highest live tick the server sent a state for; `selfTick` = local tick.
   */
  async freezeReady(
    records: readonly TickRecord[],
    serverTick: number,
    selfTick: number,
  ): Promise<WindowJob[]> {
    const out: WindowJob[] = [];
    const n = this.n;
    for (;;) {
      if (this.stopped) return out;
      const k = this.next;
      const first = k * n;
      const last = first + n - 1;
      const end = this.endTick;
      if (end !== null && first > end) return out; // windows after endTick do not exist
      let recs: TickRecord[];
      let padded = false;
      if (end !== null && last >= end) {
        if (selfTick < end || records.length <= end) return out;
        recs = truncateAndPad(records.slice(first, end + 1), end, n);
        padded = end < last;
      } else {
        if (serverTick < last || selfTick < last || records.length <= last) return out;
        recs = records.slice(first, last + 1);
      }
      const lastRec = recs[recs.length - 1] as TickRecord;
      const saltOut = this.salt();
      const ctx: WindowContext = {
        matchField: this.matchField,
        playerIndex: this.playerIndex,
        roundNo: this.roundNo,
        windowIndex: k,
        prev: this.prev,
        hiddenIn: this.hiddenIn,
        saltIn: this.saltIn,
        saltOut,
      };
      const commitOut = await commitOf(lastRec, saltOut);
      out.push({ roundNo: this.roundNo, windowIndex: k, ctx, records: recs, commitOut, padded });
      this.next = k + 1;
      this.prev = [lastRec.x, lastRec.y, lastRec.angle, lastRec.fired];
      this.hiddenIn = {
        ammo: lastRec.ammo,
        cooldown: lastRec.cooldown,
        reloadTimer: lastRec.reloadTimer,
      };
      this.saltIn = saltOut;
    }
  }
}
