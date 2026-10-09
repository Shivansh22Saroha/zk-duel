/** The renderer seam: FrameBuilder output is plain data, independent of any renderer. */
import { describe, expect, it } from 'vitest';
import { ARENA_H, ARENA_W } from '@zkduel/shared/constants';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { GameSession } from './session';
import { FrameBuilder } from './view';

function setup(playerIndex: 0 | 1) {
  let now = 0;
  const game = new GameSession(
    { send: () => undefined },
    {
      sample: (c) => ({
        moveX: 1,
        moveY: 0,
        aimTarget: c.self.pub.angle,
        fire: true,
        reload: false,
      }),
    },
    { now: () => now, constantsHash: 'h' },
  );
  const spawns: [{ x: number; y: number; angle: number }, { x: number; y: number; angle: number }] =
    [
      { x: 150, y: 300, angle: 0 },
      { x: 850, y: 300, angle: 1800 },
    ];
  const mf: ServerMessage = {
    t: 'match_found',
    matchId: '3b241101-e2bb-4255-8caf-4136c566a962',
    matchField: '1',
    playerIndex,
    opponentName: 'other',
    scheme: 'groth16',
    windowTicks: 60,
    enforcement: 'observe',
    spawns,
    initialCommit: '2',
    prevSnapshot: [150, 300, 0, 0],
  };
  game.handle(mf);
  game.handle({ t: 'start', roundNo: 1, startTick: 0, serverTime: 0 });
  return { game, frames: new FrameBuilder(game), setNow: (v: number) => (now = v) };
}

describe('FrameBuilder', () => {
  it('builds a plain frame indexed by player index, with own tracers from the local sim', () => {
    const { game, frames, setNow } = setup(1);
    setNow(17);
    game.update(17);
    const f = frames.build(17);
    expect(f.arena).toEqual({ width: ARENA_W, height: ARENA_H });
    expect(f.players[1]?.isSelf).toBe(true);
    expect(f.players[0]).toBeNull(); // no opponent state yet
    expect(f.tracers.length).toBeGreaterThan(0);
    expect(frames.build(17).tracers).toEqual([]); // tracers are drawn once
  });

  it('opponent tracers and hit flashes come from server state', () => {
    const { game, frames } = setup(0);
    game.handle({
      t: 'state',
      roundNo: 1,
      phase: 'live',
      tick: 0,
      players: [
        { x: 150, y: 300, angle: 0, fired: 0, hp: 75 },
        { x: 850, y: 300, angle: 1800, fired: 1, hp: 100 },
      ],
      hits: [{ shooter: 1, target: 0, tick: 0 }],
    });
    const f = frames.build(1);
    expect(f.tracers).toContainEqual({ x: 850, y: 300, angle: 1800, player: 1 });
    expect(f.players[0]?.flashing).toBe(true);
    expect(f.players[0]?.hp).toBe(75);
    for (let i = 0; i < 4; i++) frames.build(2 + i);
    expect(frames.build(10).players[0]?.flashing).toBe(false);
  });
});
