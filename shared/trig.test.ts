import { describe, expect, it } from 'vitest';
import { ANGLE_UNITS, TRIG_SCALE } from './constants';
import { COS_TABLE, SIN_TABLE, icos, isin } from './trig';

describe('integer trig table', () => {
  it('has the cardinal values', () => {
    expect([icos(0), isin(0)]).toEqual([TRIG_SCALE, 0]);
    expect([icos(900), isin(900)]).toEqual([0, TRIG_SCALE]);
    expect([icos(1800), isin(1800)]).toEqual([-TRIG_SCALE, 0]);
    expect([icos(2700), isin(2700)]).toEqual([0, -TRIG_SCALE]);
    expect(icos(3600)).toBe(icos(0));
    expect(isin(-900)).toBe(isin(2700));
  });

  it('no entry is within 1e-6 of a rounding boundary (engine-independent)', () => {
    for (let a = 0; a < ANGLE_UNITS; a++) {
      for (const f of [Math.sin, Math.cos]) {
        const v = f((a * 2 * Math.PI) / ANGLE_UNITS) * TRIG_SCALE;
        const frac = Math.abs(v - Math.trunc(v));
        expect(Math.abs(frac - 0.5)).toBeGreaterThan(1e-6);
      }
    }
  });

  it('magnitude stays within ±1 of TRIG_SCALE', () => {
    for (let a = 0; a < ANGLE_UNITS; a++) {
      const m = Math.hypot(COS_TABLE[a] as number, SIN_TABLE[a] as number);
      expect(Math.abs(m - TRIG_SCALE)).toBeLessThan(1);
    }
  });
});
