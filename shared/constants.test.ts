import { describe, expect, it } from 'vitest';
import * as C from './constants';
import { CONSTANTS } from './constants';

/**
 * Benchmark parameters (Phase 5): exported for the bench tools but deliberately not game rules,
 * so not hashed into constantsHash (changing them must not invalidate circuit builds).
 */
const NOT_HASHED = new Set([
  'BENCH_SEED',
  'BENCH_SAMPLES',
  'BENCH_WARMUPS',
  'BENCH_LOG_TICKS',
  'BENCH_TURN_CHANCE',
  'BENCH_RELOAD_CHANCE',
  'BENCH_MAX_RESULTS',
  'BENCH_UPLOAD_MAX_BYTES',
]);

describe('shared/constants', () => {
  it('CONSTANTS contains every exported constant (and nothing else) except the bench parameters', () => {
    const exported = Object.entries(C)
      .filter(([k]) => k !== 'CONSTANTS' && !NOT_HASHED.has(k))
      .map(([k]) => k)
      .sort();
    expect(Object.keys(CONSTANTS).sort()).toEqual(exported);
    for (const k of exported) {
      expect(CONSTANTS[k as keyof typeof CONSTANTS]).toBe((C as Record<string, unknown>)[k]);
    }
  });

  it('PRD §5 values', () => {
    expect(CONSTANTS).toMatchObject({
      TICK_RATE: 60,
      ARENA_W: 1000,
      ARENA_H: 600,
      PLAYER_RADIUS: 12,
      MAX_SPEED: 4,
      ANGLE_UNITS: 3600,
      MAX_TURN: 150,
      MAG_SIZE: 10,
      FIRE_COOLDOWN: 12,
      RELOAD_TICKS: 90,
      MAX_HP: 100,
      DAMAGE: 25,
      ROUNDS_TO_WIN: 3,
      WINDOW_TICKS: 60,
      PROOF_GRACE_WINDOWS: 2,
      RAY_LENGTH: 1200,
      TRIG_SCALE: 1024,
      ROUND_PAUSE_TICKS: 90,
      STALL_TICKS: 6,
      RECONNECT_TIMEOUT_MS: 10_000,
    });
    expect(CONSTANTS.SPAWNS).toEqual([
      { x: 150, y: 300, angle: 0 },
      { x: 850, y: 300, angle: 1800 },
    ]);
  });

  it('every numeric constant is an integer (no floats in game state)', () => {
    const walk = (v: unknown): void => {
      if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(CONSTANTS);
  });

  it('spawns are inside the legal arena bounds', () => {
    for (const s of CONSTANTS.SPAWNS) {
      expect(s.x).toBeGreaterThanOrEqual(C.PLAYER_RADIUS);
      expect(s.x).toBeLessThanOrEqual(C.ARENA_W - C.PLAYER_RADIUS);
      expect(s.y).toBeGreaterThanOrEqual(C.PLAYER_RADIUS);
      expect(s.y).toBeLessThanOrEqual(C.ARENA_H - C.PLAYER_RADIUS);
      expect(s.angle).toBeGreaterThanOrEqual(0);
      expect(s.angle).toBeLessThan(C.ANGLE_UNITS);
    }
  });

  it('derived relations hold', () => {
    expect(C.DAMAGE * 4).toBe(C.MAX_HP); // 4 hits to kill
    expect(C.TICK_RATE / C.FIRE_COOLDOWN).toBe(5); // 5 shots/s
    expect(C.RELOAD_TICKS / C.TICK_RATE).toBe(1.5);
    expect(C.ROUND_PAUSE_TICKS / C.TICK_RATE).toBe(1.5);
    expect(C.RAY_LENGTH ** 2).toBeGreaterThan(C.ARENA_W ** 2 + C.ARENA_H ** 2); // ray spans the arena
    expect(C.SALT_BITS).toBeLessThan(254); // salts always < p
    expect(
      new RegExp(C.ROOM_CODE_PATTERN).test(C.ROOM_CODE_ALPHABET.slice(0, C.ROOM_CODE_LENGTH)),
    ).toBe(true);
    for (const ch of '01OI') expect(C.ROOM_CODE_ALPHABET).not.toContain(ch);
    expect(C.WINDOW_TICKS_VARIANTS).toContain(C.WINDOW_TICKS);
  });
});
