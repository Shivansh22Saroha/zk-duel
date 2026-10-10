/**
 * WindowRecorder (TESTING §2 client): windows equal the Phase 2 reference slicing (sliceLogWindows),
 * the round-end window is truncated + padded like the server pads it (the server DigestBuilder
 * produces exactly the digest in the client's circuit input), commitments chain, salts < p.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BN254_P } from '@zkduel/shared/field';
import { mulberry32, randInt } from '@zkduel/shared/rng';
import { poseidonReady } from '@zkduel/shared/poseidon';
import {
  spawnState,
  spawnSnapshot,
  stepPlayer,
  toRecord,
  toTuple,
  type TickRecord,
} from '@zkduel/shared/sim';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import {
  buildWindowInput,
  commitOf,
  randomSalt,
  sliceLogWindows,
  testSalt,
} from '@zkduel/shared/zkInput';
import { DigestBuilder } from '../../../server/src/zk/digest';
import { WindowRecorder } from './recorder';

beforeAll(() => poseidonReady());

const N = 4;
const MF = '987654321';

function playRound(seed: number, ticks: number): TickRecord[] {
  const rng = mulberry32(seed);
  let s = spawnState(1);
  const out: TickRecord[] = [];
  for (let t = 0; t < ticks; t++) {
    const r = stepPlayer(s, {
      moveX: randInt(rng, -1, 1),
      moveY: randInt(rng, -1, 1),
      aimTarget: randInt(rng, 0, 3599),
      fire: rng() < 0.4,
      reload: rng() < 0.05,
    });
    s = r.state;
    out.push(toRecord(t, s, r.reloadPress));
  }
  return out;
}

describe('WindowRecorder', () => {
  it('freezes exactly the windows of sliceLogWindows (same records, ctx chaining, padding) over two rounds', async () => {
    const rounds = [
      { roundNo: 1, endTick: 13, recs: playRound(1, 16) }, // client ran 2 ticks past endTick
      { roundNo: 2, endTick: 11, recs: playRound(2, 12) }, // round ends on a window boundary
    ];
    // reference: the tick log the client writes, sliced the Phase 2 way
    const lines: TickLogLine[] = [
      {
        type: 'header',
        version: 1,
        source: 'client',
        matchId: 'm',
        matchField: MF,
        playerIndex: 1,
        windowTicks: N,
        constantsHash: 'h',
        createdAt: 0,
      },
    ];
    for (const r of rounds) {
      lines.push({
        type: 'round_start',
        roundNo: r.roundNo,
        prevSnapshot: toTuple(spawnSnapshot(1)),
        initialCommit: '0',
      });
      for (const rec of r.recs) lines.push({ type: 'tick', roundNo: r.roundNo, ...rec });
      lines.push({ type: 'round_end', roundNo: r.roundNo, endTick: r.endTick, winnerIndex: 0 });
    }
    const salts = testSalt(5);
    const ref = sliceLogWindows(lines, N, salts);

    let w = 0;
    const rec = new WindowRecorder(MF, 1, N, () => ref[w++]?.ctx.saltOut as string);
    const got = [];
    for (const r of rounds) {
      rec.startRound(r.roundNo, toTuple(spawnSnapshot(1)));
      // play: windows become final as the server's states arrive (serverTick) — never past endTick
      for (let t = 0; t <= r.endTick; t++) got.push(...(await rec.freezeReady(r.recs, t, t)));
      rec.endRound(r.roundNo, r.endTick);
      got.push(...(await rec.freezeReady(r.recs, r.endTick, r.recs.length - 1)));
      expect(await rec.freezeReady(r.recs, 1000, 1000)).toEqual([]); // nothing after endTick
    }
    expect(got.map((j) => [j.roundNo, j.windowIndex, j.padded])).toEqual(
      ref.map((x) => [x.ctx.roundNo, x.ctx.windowIndex, x.padded]),
    );
    for (const [i, j] of got.entries()) {
      const x = ref[i];
      expect(j.ctx).toEqual(x?.ctx);
      expect(j.records).toEqual(x?.records);
      const last = j.records[N - 1] as TickRecord;
      expect(j.commitOut).toBe(await commitOf(last, j.ctx.saltOut));
      const { expected } = await buildWindowInput(j.ctx, j.records);
      expect(expected.commitOut).toBe(j.commitOut);
    }
  });

  it('a window is not frozen before the server state for its last tick, nor before the local sim reached it', async () => {
    const recs = playRound(3, 8);
    const rec = new WindowRecorder(MF, 1, N);
    rec.startRound(1, toTuple(spawnSnapshot(1)));
    expect(await rec.freezeReady(recs, 2, 7)).toEqual([]); // server not there yet
    expect(await rec.freezeReady(recs.slice(0, 3), 7, 2)).toEqual([]); // client lags
    expect((await rec.freezeReady(recs, 3, 3)).map((j) => j.windowIndex)).toEqual([0]);
    rec.stopRound(1); // resume: chain broken → nothing more this round
    expect(await rec.freezeReady(recs, 7, 7)).toEqual([]);
  });

  it('server DigestBuilder digest = the digest in the client circuit input, incl. the padded round-end window', async () => {
    const recs = playRound(4, 14);
    const endTick = 9;
    const rec = new WindowRecorder(MF, 1, N);
    rec.startRound(1, toTuple(spawnSnapshot(1)));
    rec.endRound(1, endTick);
    const jobs = await rec.freezeReady(recs, endTick, recs.length - 1);
    const server: string[] = [];
    const b = new DigestBuilder(N, spawnSnapshot(1), (_k, d) => server.push(d));
    // the client sent ticks up to 13 (ran ahead); the server processed only up to endTick
    for (const r of recs) b.push(r.tick, r);
    b.setLimit(endTick);
    b.setEndTick(endTick);
    expect(server).toHaveLength(jobs.length);
    for (const [i, j] of jobs.entries()) {
      expect((await buildWindowInput(j.ctx, j.records)).expected.digest).toBe(server[i]);
    }
  });

  it('salts are 248-bit, always < p', () => {
    for (let i = 0; i < 200; i++) {
      const s = BigInt(randomSalt());
      expect(s < BN254_P).toBe(true);
      expect(s < 1n << 248n).toBe(true);
    }
  });
});
