/**
 * First-person WASD: forward/back/strafe rotate with the aim yaw (integer sin/cos table) and every
 * resulting step is legal for the rule checker (|dx|, |dy| <= MAX_SPEED per axis).
 */
import { describe, expect, it } from 'vitest';
import { ANGLE_UNITS, MAX_SPEED, SPAWNS, TRIG_SCALE } from '@zkduel/shared/constants';
import { checkTick, spawnState, stepPlayer, toRecord } from '@zkduel/shared/sim';
import { icos, isin } from '@zkduel/shared/trig';
import { relativeStep } from './facing';
import { stepFromKeysFacing } from './input';

const YAWS = [0, 900, 1800, 2700, 450, 1234, 3150];
/** Integer steps of at most MAX_SPEED per axis can't point exactly anywhere; this is the worst case. */
const MAX_DIR_ERR_DEG = 15;

/** Expected arena direction for keys at yaw a (float reference): forward (cos, sin), right (−sin, cos). */
function expected(keys: string[], a: number): { x: number; y: number } {
  const r = (a * 2 * Math.PI) / ANGLE_UNITS;
  const f = (keys.includes('w') ? 1 : 0) - (keys.includes('s') ? 1 : 0);
  const s = (keys.includes('d') ? 1 : 0) - (keys.includes('a') ? 1 : 0);
  return { x: f * Math.cos(r) - s * Math.sin(r), y: f * Math.sin(r) + s * Math.cos(r) };
}

function errDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const d = Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x);
  return Math.abs((((d * 180) / Math.PI + 540) % 360) - 180);
}

const COMBOS: string[][] = [
  ['w'],
  ['s'],
  ['a'],
  ['d'],
  ['w', 'd'],
  ['w', 'a'],
  ['s', 'd'],
  ['s', 'a'],
];

describe('first-person facing-relative WASD', () => {
  for (const yaw of YAWS) {
    for (const keys of COMBOS) {
      it(`${keys.join('+').toUpperCase()} at yaw ${yaw}: legal step in the right direction`, () => {
        const step = stepFromKeysFacing(new Set(keys), yaw);
        expect(Number.isInteger(step.dx) && Number.isInteger(step.dy)).toBe(true);
        expect(Math.abs(step.dx)).toBeLessThanOrEqual(MAX_SPEED);
        expect(Math.abs(step.dy)).toBeLessThanOrEqual(MAX_SPEED);
        expect(step.dx !== 0 || step.dy !== 0).toBe(true);
        expect(errDeg({ x: step.dx, y: step.dy }, expected(keys, yaw))).toBeLessThan(
          MAX_DIR_ERR_DEG,
        );

        // the sim applies it unchanged (away from walls) and the checker accepts it
        const prev = spawnState(0);
        prev.pub.angle = yaw;
        const { state, reloadPress } = stepPlayer(prev, {
          moveX: 0,
          moveY: 0,
          step,
          aimTarget: yaw,
          fire: false,
          reload: false,
        });
        expect(state.pub.x - prev.pub.x).toBe(step.dx);
        expect(state.pub.y - prev.pub.y).toBe(step.dy);
        expect(checkTick(prev, toRecord(1, state, reloadPress))).toEqual([]);
      });
    }
  }

  it('exact cardinal steps at yaw 0 / 900 / 1800 / 2700', () => {
    const w = (yaw: number) => stepFromKeysFacing(new Set(['w']), yaw);
    expect(w(0)).toEqual({ dx: MAX_SPEED, dy: 0 });
    expect(w(900)).toEqual({ dx: 0, dy: MAX_SPEED });
    expect(w(1800)).toEqual({ dx: -MAX_SPEED, dy: 0 });
    expect(w(2700)).toEqual({ dx: 0, dy: -MAX_SPEED });
    // facing +x (P0 spawn): D strafes to +y (screen down = the player's right), A to −y
    expect(stepFromKeysFacing(new Set(['d']), 0)).toEqual({ dx: 0, dy: MAX_SPEED });
    expect(stepFromKeysFacing(new Set(['a']), 0)).toEqual({ dx: 0, dy: -MAX_SPEED });
  });

  it('S is the reverse of W and A of D; opposite keys cancel', () => {
    for (let yaw = 0; yaw < ANGLE_UNITS; yaw += 37) {
      const w = relativeStep(1, 0, yaw);
      const s = relativeStep(-1, 0, yaw);
      const d = relativeStep(0, 1, yaw);
      const a = relativeStep(0, -1, yaw);
      expect([s.dx + w.dx, s.dy + w.dy]).toEqual([0, 0]);
      expect([a.dx + d.dx, a.dy + d.dy]).toEqual([0, 0]);
      expect(stepFromKeysFacing(new Set(['w', 's', 'a', 'd']), yaw)).toEqual({ dx: 0, dy: 0 });
    }
  });

  it('every yaw and key combination gives a legal step (all 3600 angles)', () => {
    for (let yaw = 0; yaw < ANGLE_UNITS; yaw++) {
      for (let f = -1; f <= 1; f++) {
        for (let r = -1; r <= 1; r++) {
          const { dx, dy } = relativeStep(f, r, yaw);
          expect(Math.abs(dx) <= MAX_SPEED && Math.abs(dy) <= MAX_SPEED).toBe(true);
          // uses the integer table: same result as the table formula
          expect(dx).toBe(
            Math.max(
              -MAX_SPEED,
              Math.min(
                MAX_SPEED,
                Math.round((MAX_SPEED * (f * icos(yaw) - r * isin(yaw))) / TRIG_SCALE) || 0,
              ),
            ),
          );
        }
      }
    }
  });

  it('a long first-person walk near the walls stays legal (arena clamp)', () => {
    let s = spawnState(0);
    let yaw = SPAWNS[0].angle;
    for (let t = 1; t <= 2000; t++) {
      yaw = (yaw + 7) % ANGLE_UNITS;
      const step = stepFromKeysFacing(
        new Set(t % 300 < 150 ? ['w', 'd'] : ['s', 'a']),
        s.pub.angle,
      );
      const r = stepPlayer(s, {
        moveX: 0,
        moveY: 0,
        step,
        aimTarget: yaw,
        fire: t % 9 === 0,
        reload: false,
      });
      expect(checkTick(s, toRecord(t, r.state, r.reloadPress))).toEqual([]);
      s = r.state;
    }
  });
});
