import { describe, expect, it } from 'vitest';
import { FrameStats } from './frameStats';
import { lerpPose, opponentPose } from './interp';
import type { OpponentSample } from './session';

describe('lerpPose', () => {
  it('interpolates position and takes the short way round for angles', () => {
    expect(lerpPose({ x: 0, y: 0, angle: 0 }, { x: 10, y: 20, angle: 100 }, 0.5)).toEqual({
      x: 5,
      y: 10,
      angle: 50,
    });
    const p = lerpPose({ x: 0, y: 0, angle: 3590 }, { x: 0, y: 0, angle: 10 }, 0.5);
    expect(p.angle).toBeCloseTo(0);
  });
});

describe('opponentPose', () => {
  const s = (tick: number, at: number, x: number): OpponentSample => ({
    tick,
    at,
    snap: { x, y: 0, angle: 0, fired: 0 },
  });
  it('returns null without samples', () => expect(opponentPose([], 100, 50)).toBeNull());
  it('interpolates between samples by arrival time, delayed', () => {
    const buf = [s(0, 0, 0), s(1, 100, 100)];
    expect(opponentPose(buf, 100, 50)?.x).toBeCloseTo(50);
  });
  it('clamps before the first and after the last sample', () => {
    const buf = [s(0, 100, 10), s(1, 200, 20)];
    expect(opponentPose(buf, 120, 50)?.x).toBe(10);
    expect(opponentPose(buf, 1000, 50)?.x).toBe(20);
  });
});

describe('FrameStats', () => {
  it('summarises intervals and work', () => {
    const f = new FrameStats(100);
    for (let i = 0; i <= 10; i++) f.frame(i * 10);
    f.addWork(1);
    f.addWork(3);
    const s = f.summary();
    expect(s.frames).toBe(10);
    expect(s.fps).toBeCloseTo(100);
    expect(s.intervalP95).toBe(10);
    expect(s.workMax).toBe(3);
    f.reset();
    expect(f.summary().frames).toBe(0);
  });
  it('keeps at most cap samples', () => {
    const f = new FrameStats(5);
    for (let i = 0; i < 50; i++) f.frame(i);
    expect(f.summary().frames).toBe(5);
  });
});
