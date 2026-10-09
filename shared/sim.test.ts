import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARENA_H,
  ARENA_W,
  FIRE_COOLDOWN,
  MAG_SIZE,
  MAX_SPEED,
  MAX_TURN,
  PLAYER_RADIUS,
  RELOAD_TICKS,
} from './constants';
import { mulberry32, randInt } from './rng';
import {
  IllegalTransitionError,
  INITIAL_HIDDEN,
  canFire,
  checkSequence,
  checkTick,
  fromRecord,
  holdTick,
  signedTurn,
  spawnState,
  stateHash,
  stepAim,
  stepMovement,
  stepPlayer,
  stepWeapon,
  toRecord,
  truncateAndPad,
  truncateAndPadPublic,
  turnDelta,
  weaponRow,
  type Hidden,
  type PlayerState,
  type TickInput,
  type TickRecord,
} from './sim';

const H = (ammo: number, cooldown: number, reloadTimer: number): Hidden => ({
  ammo,
  cooldown,
  reloadTimer,
});
const idle: TickInput = { moveX: 0, moveY: 0, aimTarget: 0, fire: false, reload: false };

describe('movement', () => {
  it('steps exactly MAX_SPEED per held axis (diagonal included)', () => {
    expect(stepMovement(500, 300, 1, 0)).toEqual({ x: 500 + MAX_SPEED, y: 300 });
    expect(stepMovement(500, 300, -1, 1)).toEqual({ x: 500 - MAX_SPEED, y: 300 + MAX_SPEED });
    expect(stepMovement(500, 300, 0, 0)).toEqual({ x: 500, y: 300 });
  });
  it('treats any positive/negative axis value as ±1 (per-axis speed clamp)', () => {
    expect(stepMovement(500, 300, 7, -9)).toEqual({ x: 504, y: 296 });
  });
  it('clamps at all four arena edges', () => {
    const R = PLAYER_RADIUS;
    expect(stepMovement(R + 1, 300, -1, 0).x).toBe(R);
    expect(stepMovement(ARENA_W - R - 1, 300, 1, 0).x).toBe(ARENA_W - R);
    expect(stepMovement(500, R + 2, 0, -1).y).toBe(R);
    expect(stepMovement(500, ARENA_H - R, 0, 1).y).toBe(ARENA_H - R);
  });
});

describe('aim', () => {
  it('turnDelta wraps (TESTING §2 vectors)', () => {
    expect(turnDelta(3590, 10)).toBe(20);
    expect(turnDelta(10, 3590)).toBe(20);
    expect(turnDelta(0, 1800)).toBe(1800);
    expect(turnDelta(5, 5)).toBe(0);
  });
  it('signedTurn picks the shortest arc', () => {
    expect(signedTurn(3590, 10)).toBe(20);
    expect(signedTurn(10, 3590)).toBe(-20);
    expect(signedTurn(0, 1800)).toBe(1800);
  });
  it('stepAim clamps to MAX_TURN and wraps', () => {
    expect(stepAim(0, 1000)).toBe(MAX_TURN);
    expect(stepAim(0, 3000)).toBe(3600 - MAX_TURN);
    expect(stepAim(3550, 50)).toBe(50);
    expect(stepAim(100, 120)).toBe(120);
  });
});

describe('weapon transition table (ARCHITECTURE §3)', () => {
  it('W1: fire with ammo → ammo−1, cooldown = FIRE_COOLDOWN−1, reload press ignored', () => {
    expect(weaponRow(H(10, 0, 0), 1, 1)).toBe('W1');
    expect(stepWeapon(H(10, 0, 0), 1, 0)).toEqual(H(9, FIRE_COOLDOWN - 1, 0));
    expect(stepWeapon(H(3, 0, 0), 1, 1)).toEqual(H(2, FIRE_COOLDOWN - 1, 0)); // fire wins
  });
  it('W1 illegal: ammo 0, cooldown > 0, or reloading', () => {
    expect(() => stepWeapon(H(0, 0, 0), 1, 0)).toThrow(IllegalTransitionError);
    expect(() => stepWeapon(H(5, 1, 0), 1, 0)).toThrow(IllegalTransitionError);
    expect(() => stepWeapon(H(5, 0, 30), 1, 0)).toThrow(IllegalTransitionError);
    expect(canFire(H(1, 0, 0))).toBe(true);
  });
  it('W2: reload in progress → timer−1, cooldown decrements, presses ignored', () => {
    expect(weaponRow(H(4, 3, 50), 0, 1)).toBe('W2');
    expect(stepWeapon(H(4, 3, 50), 0, 1)).toEqual(H(4, 2, 49));
    expect(stepWeapon(H(4, 0, 2), 0, 0)).toEqual(H(4, 0, 1));
  });
  it('W3: last reload tick → ammo = MAG_SIZE, timer 0', () => {
    expect(weaponRow(H(2, 0, 1), 0, 0)).toBe('W3');
    expect(stepWeapon(H(2, 0, 1), 0, 1)).toEqual(H(MAG_SIZE, 0, 0));
  });
  it('W4: press with a non-full magazine starts a reload', () => {
    expect(weaponRow(H(9, 5, 0), 0, 1)).toBe('W4');
    expect(stepWeapon(H(9, 5, 0), 0, 1)).toEqual(H(9, 4, RELOAD_TICKS));
    expect(stepWeapon(H(0, 0, 0), 0, 1)).toEqual(H(0, 0, RELOAD_TICKS));
  });
  it('W5: idle, or press with a full magazine (reload blocked while full)', () => {
    expect(weaponRow(H(MAG_SIZE, 0, 0), 0, 1)).toBe('W5');
    expect(stepWeapon(H(MAG_SIZE, 0, 0), 0, 1)).toEqual(H(MAG_SIZE, 0, 0));
    expect(stepWeapon(H(7, 4, 0), 0, 0)).toEqual(H(7, 3, 0));
    expect(stepWeapon(H(7, 0, 0), 0, 0)).toEqual(H(7, 0, 0));
  });

  it('next shot is possible exactly FIRE_COOLDOWN ticks after a shot (5 shots/s)', () => {
    let h = stepWeapon(H(10, 0, 0), 1, 0); // shot at tick 0
    let t = 0;
    while (!canFire(h)) {
      h = stepWeapon(h, 0, 0);
      t++;
    }
    // state after tick 11 allows firing on tick 12
    expect(t + 1).toBe(FIRE_COOLDOWN);
  });

  it('reload started at tick t completes at t+RELOAD_TICKS; earliest shot t+RELOAD_TICKS+1', () => {
    let h = stepWeapon(H(3, 0, 0), 0, 1); // press at tick t (=0)
    let t = 0;
    while (h.ammo !== MAG_SIZE) {
      expect(canFire(h)).toBe(false);
      h = stepWeapon(h, 0, 0);
      t++;
    }
    expect(t).toBe(RELOAD_TICKS);
    expect(h.reloadTimer).toBe(0);
    expect(canFire(h)).toBe(true); // so the shot happens at tick t+RELOAD_TICKS+1
  });

  it('empties the magazine with held fire and auto-reloads', () => {
    let s: PlayerState = spawnState(0);
    const shotTicks: number[] = [];
    const fire: TickInput = { ...idle, fire: true };
    for (let t = 0; t < 215; t++) {
      const r = stepPlayer(s, fire);
      if (r.state.pub.fired) shotTicks.push(t);
      if (t === 109) expect(r.reloadPress).toBe(1); // auto-reload the tick after the last round
      s = r.state;
    }
    const lastOfMag = (MAG_SIZE - 1) * FIRE_COOLDOWN; // 108
    const reloadPress = lastOfMag + 1; // 109
    const firstNew = reloadPress + RELOAD_TICKS + 1; // 200
    expect(shotTicks).toEqual([
      ...Array.from({ length: MAG_SIZE }, (_, i) => i * FIRE_COOLDOWN),
      firstNew,
      firstNew + FIRE_COOLDOWN,
    ]);
  });
});

describe('stepPlayer / checkTick', () => {
  it('honest ticks always pass checkTick (property, 300 ticks × 100 runs)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = mulberry32(seed);
        let s = spawnState(seed & 1 ? 1 : 0);
        for (let t = 0; t < 300; t++) {
          const input: TickInput = {
            moveX: randInt(rng, -1, 1),
            moveY: randInt(rng, -1, 1),
            aimTarget: randInt(rng, -5000, 5000),
            fire: rng() < 0.5,
            reload: rng() < 0.05,
          };
          const { state, reloadPress } = stepPlayer(s, input);
          const rec = toRecord(t, state, reloadPress);
          if (checkTick(s, rec).length) return false;
          s = state;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  const base = (): { prev: PlayerState; rec: TickRecord } => {
    const prev: PlayerState = {
      pub: { x: 500, y: 300, angle: 3590, fired: 0 },
      hidden: H(5, 0, 0),
    };
    const { state, reloadPress } = stepPlayer(prev, idle);
    return { prev, rec: toRecord(1, state, reloadPress) };
  };
  const mutate = (patch: Partial<TickRecord>) => {
    const { prev, rec } = base();
    return checkTick(prev, { ...rec, ...patch });
  };

  it('accepts an idle tick', () => expect(mutate({})).toEqual([]));
  it('speed: |Δx| = MAX_SPEED passes, MAX_SPEED+1 fails (both signs)', () => {
    expect(mutate({ x: 500 + MAX_SPEED })).toEqual([]);
    expect(mutate({ x: 500 + MAX_SPEED + 1 })).toEqual(['speed_x']);
    expect(mutate({ x: 500 - MAX_SPEED - 1 })).toEqual(['speed_x']);
    expect(mutate({ y: 300 - MAX_SPEED - 1 })).toEqual(['speed_y']);
  });
  it('bounds: R−1 and W−R+1 fail', () => {
    const prev: PlayerState = {
      pub: { x: PLAYER_RADIUS, y: 300, angle: 0, fired: 0 },
      hidden: H(5, 0, 0),
    };
    const ok = toRecord(1, holdTick(prev), 0);
    expect(checkTick(prev, { ...ok, x: PLAYER_RADIUS - 1 })).toEqual(['x_bounds']);
    const prev2: PlayerState = {
      pub: { x: ARENA_W - PLAYER_RADIUS, y: 300, angle: 0, fired: 0 },
      hidden: H(5, 0, 0),
    };
    expect(
      checkTick(prev2, { ...toRecord(1, holdTick(prev2), 0), x: ARENA_W - PLAYER_RADIUS + 1 }),
    ).toEqual(['x_bounds']);
  });
  it('turn: MAX_TURN across 3599→0 passes, MAX_TURN+1 fails', () => {
    expect(mutate({ angle: (3590 + MAX_TURN) % 3600 })).toEqual([]);
    expect(mutate({ angle: 3590 - MAX_TURN })).toEqual([]);
    expect(mutate({ angle: (3590 + MAX_TURN + 1) % 3600 })).toEqual(['turn']);
    expect(mutate({ angle: 3600 })).toContain('angle_range');
  });
  it('booleans: fired = 2 / reloadPress = 2 fail', () => {
    expect(mutate({ fired: 2 })).toContain('fired_bool');
    expect(mutate({ reloadPress: 2 })).toContain('reload_bool');
  });
  it('weapon: fire illegal / ammo not decremented / wrong reload result fail', () => {
    const prev: PlayerState = { pub: { x: 500, y: 300, angle: 0, fired: 0 }, hidden: H(0, 0, 0) };
    expect(checkTick(prev, { ...toRecord(1, holdTick(prev), 0), fired: 1 })).toEqual([
      'fire_illegal',
    ]);
    const p2: PlayerState = { pub: prev.pub, hidden: H(5, 0, 0) };
    const fired = toRecord(1, stepPlayer(p2, { ...idle, fire: true }).state, 0);
    expect(checkTick(p2, fired)).toEqual([]);
    expect(checkTick(p2, { ...fired, ammo: 5 })).toEqual(['weapon_transition']);
    const p3: PlayerState = { pub: prev.pub, hidden: H(2, 0, 1) };
    const done = toRecord(1, holdTick(p3), 0);
    expect(done.ammo).toBe(MAG_SIZE);
    expect(checkTick(p3, done)).toEqual([]);
    expect(checkTick(p3, { ...done, ammo: MAG_SIZE - 1 })).toEqual(['weapon_transition']);
  });
  it('checkSequence reports the first failing tick', () => {
    const recs: TickRecord[] = [];
    let s = spawnState(0);
    for (let t = 0; t < 10; t++) {
      const r = stepPlayer(s, { ...idle, moveX: 1 });
      recs.push(toRecord(t, r.state, r.reloadPress));
      s = r.state;
    }
    expect(checkSequence(spawnState(0), recs)).toBeNull();
    const bad = recs.map((r) => ({ ...r }));
    (bad[6] as TickRecord).x += 9;
    expect(checkSequence(spawnState(0), bad)).toEqual({ index: 6, violations: ['speed_x'] });
  });
});

describe('determinism', () => {
  it('same input log → same per-tick state hash (1000 runs)', () => {
    const rng = mulberry32(42);
    const inputs: TickInput[] = Array.from({ length: 600 }, () => ({
      moveX: randInt(rng, -1, 1),
      moveY: randInt(rng, -1, 1),
      aimTarget: randInt(rng, 0, 3599),
      fire: rng() < 0.4,
      reload: rng() < 0.02,
    }));
    const run = (): number => {
      let s = spawnState(1);
      const recs: TickRecord[] = [];
      inputs.forEach((inp, t) => {
        const r = stepPlayer(s, inp);
        recs.push(toRecord(t, r.state, r.reloadPress));
        s = r.state;
      });
      return stateHash(recs);
    };
    const first = run();
    for (let i = 0; i < 999; i++) expect(run()).toBe(first);
  });
});

describe('round-end truncate + pad', () => {
  const N = 60;
  const recordsFor = (from: number, to: number): TickRecord[] => {
    let s: PlayerState = {
      pub: { x: 400, y: 300, angle: 0, fired: 0 },
      hidden: { ...INITIAL_HIDDEN },
    };
    const out: TickRecord[] = [];
    for (let t = from; t <= to; t++) {
      const r = stepPlayer(s, { moveX: 1, moveY: 0, aimTarget: 900, fire: true, reload: false });
      out.push(toRecord(t, r.state, r.reloadPress));
      s = r.state;
    }
    return out;
  };

  it('drops ticks after endTick and pads to N by holding the endTick snapshot', () => {
    const recs = recordsFor(60, 100); // window 1, client ran past endTick
    const padded = truncateAndPad(recs, 75, N);
    expect(padded).toHaveLength(N);
    expect(padded.map((r) => r.tick)).toEqual(Array.from({ length: N }, (_, i) => 60 + i));
    const end = padded[15] as TickRecord;
    for (const r of padded.slice(16)) {
      expect([r.x, r.y, r.angle, r.fired, r.reloadPress]).toEqual([end.x, end.y, end.angle, 0, 0]);
    }
    expect(checkSequence(fromRecord(recs[0] as TickRecord), padded.slice(1))).toBeNull();
  });

  it('client padding matches the server public padding', () => {
    const recs = recordsFor(120, 150);
    const full = truncateAndPad(recs, 133, N);
    const pub = truncateAndPadPublic(recs, 133, N);
    expect(pub).toEqual(full.map(({ tick, x, y, angle, fired }) => ({ tick, x, y, angle, fired })));
  });

  it('endTick on the last tick of a window needs no padding', () => {
    expect(truncateAndPad(recordsFor(0, 59), 59, N)).toHaveLength(N);
  });
});
