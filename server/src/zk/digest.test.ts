/** DigestBuilder equals the JS reference (shared/zkInput digestOf = the circuit's DigestChain). */
import { beforeAll, describe, expect, it } from 'vitest';
import { poseidonReady } from '@zkduel/shared/poseidon';
import { truncateAndPadPublic, type PublicSnap } from '@zkduel/shared/sim';
import { digestOf, type Tuple4 } from '@zkduel/shared/zkInput';
import { DigestBuilder } from './digest';

beforeAll(() => poseidonReady());

const N = 4;
const PREV: PublicSnap = { x: 150, y: 300, angle: 0, fired: 0 };
const tup = (s: PublicSnap): Tuple4 => [s.x, s.y, s.angle, s.fired];
const snapAt = (t: number): PublicSnap => ({
  x: 150 + 4 * t,
  y: 300 - (t % 3),
  angle: (t * 37) % 3600,
  fired: t % 5 === 0 ? 1 : 0,
});

/** Reference: per-window digests from a full list of per-tick public snapshots. */
async function reference(ticks: (PublicSnap & { tick: number })[]): Promise<string[]> {
  const out: string[] = [];
  let prev = tup(PREV);
  for (let k = 0; k * N < ticks.length; k++) {
    const w = ticks.slice(k * N, k * N + N);
    out.push(await digestOf(prev, w));
    const last = w[w.length - 1] as PublicSnap;
    prev = tup(last);
  }
  return out;
}

function build(): { b: DigestBuilder; got: [number, string][] } {
  const got: [number, string][] = [];
  const b = new DigestBuilder(N, PREV, (k, d) => got.push([k, d]));
  b.setLimit(1000); // the server has processed every tick these tests use (unless stated)
  return { b, got };
}

describe('DigestBuilder', () => {
  it('equals digestOf window by window for a complete stream', async () => {
    const ticks = Array.from({ length: 12 }, (_, t) => ({ tick: t, ...snapAt(t) }));
    const { b, got } = build();
    for (const s of ticks) b.push(s.tick, s);
    expect(got.map(([k]) => k)).toEqual([0, 1, 2]);
    expect(got.map(([, d]) => d)).toEqual(await reference(ticks));
  });

  it('fills ticks the client never sent with the previous snapshot and fired = 0', async () => {
    const sent = [0, 1, 4, 5, 6, 7].map((t) => ({ tick: t, ...snapAt(t) }));
    const { b, got } = build();
    for (const s of sent) b.push(s.tick, s);
    const s1 = snapAt(1);
    const full = [
      { tick: 0, ...snapAt(0) },
      { tick: 1, ...s1 },
      { tick: 2, ...s1, fired: 0 },
      { tick: 3, ...s1, fired: 0 },
      ...sent.slice(2),
    ];
    expect(got.map(([, d]) => d)).toEqual(await reference(full));
  });

  it('waits for late snapshots; the late bound finalises only ticks that can no longer arrive', async () => {
    const { b, got } = build();
    b.push(0, snapAt(0));
    b.push(1, snapAt(1));
    expect(got).toHaveLength(0);
    b.setLateBound(1); // nothing new
    expect(got).toHaveLength(0);
    b.push(2, snapAt(2)); // a late snapshot (hit detection may have held it) still counts
    b.setLateBound(3); // tick 3 is past the late bound
    const s2 = snapAt(2);
    expect(got.map(([, d]) => d)).toEqual(
      await reference([
        { tick: 0, ...snapAt(0) },
        { tick: 1, ...snapAt(1) },
        { tick: 2, ...s2 },
        { tick: 3, ...s2, fired: 0 },
      ]),
    );
  });

  it('only hashes ticks the server has processed; round end truncates + pads like truncateAndPadPublic', async () => {
    const ticks = Array.from({ length: 7 }, (_, t) => ({ tick: t, ...snapAt(t) }));
    const got: [number, string][] = [];
    const b = new DigestBuilder(N, PREV, (k, d) => got.push([k, d]));
    for (const s of ticks) b.push(s.tick, s); // tick 6 arrives before the server processed 5
    b.setLimit(5);
    expect(got).toHaveLength(1);
    b.setEndTick(5); // the round ended at 5: tick 6 (client ran ahead) must be ignored
    expect(b.isClosed).toBe(true);
    const lastWindow = truncateAndPadPublic(ticks.slice(4), 5, N);
    expect(got.map(([, d]) => d)).toEqual(await reference([...ticks.slice(0, 4), ...lastWindow]));
    b.push(7, snapAt(7));
    expect(got).toHaveLength(2);
  });

  it('round end before the last snapshots arrived: closes when they do (or on close())', async () => {
    const ticks = Array.from({ length: 6 }, (_, t) => ({ tick: t, ...snapAt(t) }));
    const a = build();
    for (const s of ticks.slice(0, 5)) a.b.push(s.tick, s);
    a.b.setEndTick(5);
    expect(a.got).toHaveLength(1);
    a.b.push(5, ticks[5] as PublicSnap); // late, during the pause
    expect(a.got).toHaveLength(2);
    const ref = await reference([
      ...ticks.slice(0, 4),
      ...truncateAndPadPublic(ticks.slice(4), 5, N),
    ]);
    expect(a.got.map(([, d]) => d)).toEqual(ref);
    // never arrives → close() at the next round start holds tick 5
    const c = build();
    for (const s of ticks.slice(0, 5)) c.b.push(s.tick, s);
    c.b.setEndTick(5);
    c.b.close();
    const s4 = snapAt(4);
    expect(c.got.map(([, d]) => d)).toEqual(
      await reference([
        ...ticks.slice(0, 5),
        ...truncateAndPadPublic([{ tick: 5, ...s4, fired: 0 }], 5, N),
      ]),
    );
  });

  it('processing held a lagging player (STALL): the real snapshots arriving later are what is hashed', async () => {
    const ticks = Array.from({ length: 4 }, (_, t) => ({ tick: t, ...snapAt(t) }));
    const got: [number, string][] = [];
    const b = new DigestBuilder(N, PREV, (k, d) => got.push([k, d]));
    b.push(0, ticks[0] as PublicSnap);
    b.setLimit(3); // server processed 1..3 with held values for this player
    expect(got).toHaveLength(0);
    for (const s of ticks.slice(1)) b.push(s.tick, s);
    expect(got.map(([, d]) => d)).toEqual(await reference(ticks));
  });

  it('stopAt (match ended mid-window): complete windows finalise, the partial one never does', () => {
    const { b, got } = build();
    for (let t = 0; t < 6; t++) b.push(t, snapAt(t));
    b.stopAt(5);
    expect(got.map(([k]) => k)).toEqual([0]);
    expect(b.isClosed).toBe(true);
  });

  it('out-of-range integers enter the digest as sent (reduced mod p, like the circuit input)', async () => {
    const odd = [
      { tick: 0, x: -40, y: 300, angle: 3600, fired: 2 },
      ...[1, 2, 3].map((t) => ({ tick: t, ...snapAt(t) })),
    ];
    const { b, got } = build();
    for (const s of odd) b.push(s.tick, s);
    expect(got[0]?.[1]).toBe(await digestOf(tup(PREV), odd));
  });
});
