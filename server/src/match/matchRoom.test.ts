/** MatchRoom logic with a fake clock and in-memory links (no sockets). */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COUNTDOWN_SECONDS,
  DAMAGE,
  MAX_HP,
  READY_TIMEOUT_MS,
  RECONNECT_TIMEOUT_MS,
  ROUND_PAUSE_TICKS,
  STALL_TICKS,
  TICK_RATE,
} from '@zkduel/shared/constants';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { openDb } from '../db/index';
import { Repo } from '../db/repo';
import { NULL_LOG } from '../log/snapshotLog';
import { MatchRoom } from './matchRoom';

const MS = 1000 / TICK_RATE;

function setup() {
  let now = 0;
  const repo = new Repo(openDb(':memory:'));
  repo.createPlayer('a', 'alice');
  repo.createPlayer('b', 'bobby');
  repo.createMatch({
    id: 'm1',
    matchField: '1',
    mode: 'queue',
    enforcement: 'observe',
    scheme: 'groth16',
    windowTicks: 60,
    circuitHash: 'none',
    roomCode: null,
    players: ['a', 'b'],
  });
  const inbox: [ServerMessage[], ServerMessage[]] = [[], []];
  let finished = false;
  const room = new MatchRoom(
    {
      id: 'm1',
      matchField: '1',
      initialCommit: '2',
      mode: 'queue',
      enforcement: 'observe',
      scheme: 'groth16',
      windowTicks: 60,
      constantsHash: 'h',
    },
    [
      {
        playerId: 'a',
        displayName: 'alice',
        link: { send: (m) => inbox[0].push(m) },
        ready: false,
        disconnectedAt: null,
      },
      {
        playerId: 'b',
        displayName: 'bobby',
        link: { send: (m) => inbox[1].push(m) },
        ready: false,
        disconnectedAt: null,
      },
    ],
    { repo, log: NULL_LOG, now: () => now, onFinished: () => (finished = true) },
  );
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + MS);
      room.onWall();
    }
  };
  const last = (p: 0 | 1, t: ServerMessage['t']) => [...inbox[p]].reverse().find((m) => m.t === t);
  const goLive = () => {
    room.start();
    room.onReady(0);
    room.onReady(1);
    advance(COUNTDOWN_SECONDS * 1000 + MS);
    expect(room.phase).toBe('live');
  };
  const snap = (
    p: 0 | 1,
    tick: number,
    s: Partial<{ x: number; y: number; angle: number; fired: number }> = {},
  ) => room.onSnapshot(p, { tick, x: p ? 850 : 150, y: 300, angle: p ? 1800 : 0, fired: 0, ...s });
  return {
    room,
    repo,
    inbox,
    advance,
    last,
    goLive,
    snap,
    isFinished: () => finished,
    setNow: (v: number) => (now = v),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('MatchRoom', () => {
  it('match_found → ready → countdown 3,2,1 → start round 1', () => {
    t.room.start();
    expect(t.last(0, 'match_found')).toMatchObject({
      playerIndex: 0,
      opponentName: 'bobby',
      prevSnapshot: [150, 300, 0, 0],
    });
    expect(t.last(1, 'match_found')).toMatchObject({
      playerIndex: 1,
      prevSnapshot: [850, 300, 1800, 0],
    });
    t.room.onReady(0);
    expect(t.room.phase).toBe('waiting_ready');
    t.room.onReady(1);
    t.advance(COUNTDOWN_SECONDS * 1000 + MS);
    const cds = t.inbox[0]
      .filter((m) => m.t === 'countdown')
      .map((m) => (m as { secondsLeft: number }).secondsLeft);
    expect(cds).toEqual([3, 2, 1]);
    expect(t.last(0, 'start')).toMatchObject({ roundNo: 1, startTick: 0 });
  });

  it('aborts if a player never sends ready', () => {
    t.room.start();
    t.room.onReady(0);
    t.advance(READY_TIMEOUT_MS + MS);
    expect(t.last(0, 'match_end')).toMatchObject({ reason: 'abort', winnerIndex: null });
  });

  it('processes a tick only when both snapshots are in', () => {
    t.goLive();
    t.snap(0, 0);
    expect(t.room.processedTick).toBe(-1);
    t.snap(1, 0);
    expect(t.room.processedTick).toBe(0);
    expect(t.last(0, 'state')).toMatchObject({ tick: 0, phase: 'live' });
  });

  it('holds a missing snapshot once the leader is STALL_TICKS ahead, and reports stalled', () => {
    t.goLive();
    t.advance(30 * MS);
    for (let k = 0; k < STALL_TICKS; k++) t.snap(0, k, { x: 150 + 4 * k });
    expect(t.room.processedTick).toBe(-1);
    t.snap(0, STALL_TICKS, { x: 150 + 4 * STALL_TICKS });
    expect(t.room.processedTick).toBe(0);
    const st = t.last(0, 'state') as Extract<ServerMessage, { t: 'state' }>;
    expect(st.players[1]).toMatchObject({ x: 850, y: 300, angle: 1800, fired: 0 }); // held spawn
    expect(t.last(0, 'opponent_status')).toMatchObject({ status: 'stalled' });
    t.snap(1, 1);
    expect(t.last(0, 'opponent_status')).toMatchObject({ status: 'connected' });
  });

  it('drops duplicate / out-of-order ticks and strikes ticks from the future', () => {
    t.goLive();
    t.snap(0, 0);
    expect(t.snap(0, 0)).toBe('drop');
    expect(t.snap(0, 1000)).toBe('strike_future');
  });

  it('accepts integer out-of-range values but flags them for a strike', () => {
    t.goLive();
    expect(t.snap(0, 0, { x: -40 })).toBe('strike_range');
    expect(t.snap(0, 1, { fired: 2 })).toBe('strike_range');
  });

  it('hits apply DAMAGE; 4 hits end the round; pause; next round; 3 rounds win', () => {
    t.goLive();
    let tick = 0;
    const playRoundP0Wins = () => {
      for (let h = 0; h < MAX_HP / DAMAGE; h++) {
        t.snap(0, tick, { fired: 1 }); // P0 at (150,300) angle 0 faces P1 at (850,300)
        t.snap(1, tick);
        tick++;
      }
    };
    playRoundP0Wins();
    expect(t.last(0, 'round_end')).toMatchObject({
      roundNo: 1,
      endTick: 3,
      winnerIndex: 0,
      score: [1, 0],
      pauseTicks: ROUND_PAUSE_TICKS,
      prevSnapshot: [150, 300, 0, 0],
    });
    expect(t.last(1, 'round_end')).toMatchObject({ prevSnapshot: [850, 300, 1800, 0] });
    expect(t.room.phase).toBe('pause');
    expect(t.snap(0, 4)).toBe('drop'); // ticks after endTick are dropped
    t.advance(ROUND_PAUSE_TICKS * MS + MS);
    expect(t.last(0, 'start')).toMatchObject({ roundNo: 2 });
    for (const r of [2, 3]) {
      tick = 0;
      playRoundP0Wins();
      if (r < 3) t.advance(ROUND_PAUSE_TICKS * MS + MS);
    }
    expect(t.last(1, 'match_end')).toMatchObject({
      reason: 'rounds',
      winnerIndex: 0,
      score: [3, 0],
    });
    const s = t.repo.getMatchSummary('m1');
    expect(s?.status).toBe('finished');
    expect(s?.players.map((p) => [p.roundsWon, p.hits, p.shots])).toEqual([
      [3, 12, 12],
      [0, 0, 0],
    ]);
    expect(s?.rounds.map((r) => [r.startTick, r.endTick])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]); // match-absolute
    expect(s?.totalTicks).toBe(12);
    expect(t.isFinished()).toBe(true);
  });

  it('simultaneous lethal hits → both survive at 1 HP', () => {
    t.goLive();
    for (let k = 0; k < 3; k++) {
      t.snap(0, k, { fired: 1 });
      t.snap(1, k, { fired: 1 });
    }
    expect(t.room.hp).toEqual([MAX_HP - 3 * DAMAGE, MAX_HP - 3 * DAMAGE]);
    t.snap(0, 3, { fired: 1 });
    t.snap(1, 3, { fired: 1 });
    expect(t.room.hp).toEqual([1, 1]);
    expect(t.room.phase).toBe('live');
  });

  it('forfeit ends the match for the opponent', () => {
    t.goLive();
    t.room.onForfeit(1);
    expect(t.last(0, 'match_end')).toMatchObject({ reason: 'forfeit', winnerIndex: 0 });
    expect(t.repo.getMatchSummary('m1')?.endReason).toBe('forfeit');
  });

  it('disconnect for RECONNECT_TIMEOUT_MS → disconnect forfeit', () => {
    t.goLive();
    t.room.onDisconnect(1);
    expect(t.last(0, 'opponent_status')).toMatchObject({ status: 'reconnecting' });
    // the connected player keeps playing; the absent one is held
    for (let k = 0; k < 20; k++) t.snap(0, k);
    t.advance(RECONNECT_TIMEOUT_MS + MS);
    expect(t.last(0, 'match_end')).toMatchObject({ reason: 'disconnect', winnerIndex: 0 });
  });

  it('connected but silent for RECONNECT_TIMEOUT_MS → disconnect forfeit', () => {
    t.goLive();
    for (let k = 0; k < 600; k++) {
      t.advance(MS);
      t.snap(0, k);
    }
    t.advance(RECONNECT_TIMEOUT_MS);
    expect(t.last(0, 'match_end')).toMatchObject({ reason: 'disconnect', winnerIndex: 0 });
  });
});
