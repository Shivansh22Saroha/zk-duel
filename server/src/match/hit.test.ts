import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, RAY_LENGTH } from '@zkduel/shared/constants';
import { clampForHit, rayHitsCircle, shotHits } from './hit';

const R = PLAYER_RADIUS;

describe('ray vs circle (TESTING §2)', () => {
  it('dead centre', () => expect(rayHitsCircle(100, 300, 0, 600, 300)).toBe(true));
  it('tangent counts as a hit, one unit further is a miss', () => {
    expect(rayHitsCircle(100, 300, 0, 600, 300 + R)).toBe(true);
    expect(rayHitsCircle(100, 300, 0, 600, 300 + R + 1)).toBe(false);
    expect(rayHitsCircle(100, 300, 0, 600, 300 - R - 1)).toBe(false);
  });
  it('target behind the shooter misses', () =>
    expect(rayHitsCircle(600, 300, 0, 100, 300)).toBe(false));
  it('point-blank overlap hits regardless of angle', () =>
    expect(rayHitsCircle(500, 300, 1800, 505, 300)).toBe(true));
  it('respects ray length', () => {
    expect(rayHitsCircle(0, 0, 0, RAY_LENGTH, 0, R, RAY_LENGTH)).toBe(true);
    expect(rayHitsCircle(0, 0, 0, RAY_LENGTH + 1, 0, R, RAY_LENGTH)).toBe(false);
  });
  it.each([
    [0, 800, 300],
    [900, 500, 550],
    [1800, 200, 300],
    [2700, 500, 50],
    [3599, 800, 300],
  ])('angle %i hits a target straight along it', (angle, tx, ty) => {
    expect(rayHitsCircle(500, 300, angle, tx, ty)).toBe(true);
  });
  it('angle 3599 and 1 both hit a target at angle 0 (wrap)', () => {
    expect(rayHitsCircle(100, 300, 3599, 600, 300)).toBe(true);
    expect(rayHitsCircle(100, 300, 1, 600, 300)).toBe(true);
  });
  it('a 2° error at long range misses', () =>
    expect(rayHitsCircle(100, 300, 20, 900, 300)).toBe(false));
});

describe('shotHits', () => {
  it('only fired === 1 is a shot', () => {
    const t = { x: 600, y: 300, angle: 0, fired: 0 };
    expect(shotHits({ x: 100, y: 300, angle: 0, fired: 0 }, t)).toBe(false);
    expect(shotHits({ x: 100, y: 300, angle: 0, fired: 1 }, t)).toBe(true);
    expect(shotHits({ x: 100, y: 300, angle: 0, fired: 2 }, t)).toBe(false);
  });
  it('clamps out-of-range snapshots before ray-casting', () => {
    expect(clampForHit({ x: -50, y: 9999, angle: 3605, fired: 1 })).toEqual({
      x: R,
      y: 600 - R,
      angle: 5,
      fired: 1,
    });
  });
});
