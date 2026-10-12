/**
 * Deterministic, integer-only game rules (docs/ARCHITECTURE.md §3).
 *
 * Used by the client sim, the server, bots, tests and (Phase 2) the circuit test-vector
 * generator. The circuit enforces exactly these rules; `checkTick` is the JS mirror of the
 * circuit's per-tick constraints and must stay in lock-step with it.
 */
import {
  ANGLE_UNITS,
  ARENA_H,
  ARENA_W,
  FIRE_COOLDOWN,
  MAG_SIZE,
  MAX_SPEED,
  MAX_TURN,
  PLAYER_RADIUS,
  RELOAD_TICKS,
  SPAWNS,
  type PlayerIndex,
} from './constants';

/** Public per-tick snapshot — the only per-tick data that ever leaves the client. */
export interface PublicSnap {
  x: number;
  y: number;
  angle: number;
  fired: number;
}

/** Hidden weapon state — never leaves the client in plaintext. */
export interface Hidden {
  ammo: number;
  cooldown: number;
  reloadTimer: number;
}

/** One player's state after a tick. */
export interface PlayerState {
  pub: PublicSnap;
  hidden: Hidden;
}

/** Per-tick input (what the player asked for; the rules decide what happens). */
export interface TickInput {
  /** −1, 0 or +1 per axis: a full MAX_SPEED step on each held axis (arena-aligned WASD). */
  moveX: number;
  moveY: number;
  /**
   * Optional exact integer step (first-person, facing-relative WASD). Overrides moveX/moveY;
   * each axis is clamped to [−MAX_SPEED, MAX_SPEED] — the same per-axis bound `checkTick` and the
   * circuit enforce, so any such step is legal.
   */
  step?: { dx: number; dy: number };
  /** Desired aim angle (any integer; normalised). The turn is clamped to MAX_TURN. */
  aimTarget: number;
  fire: boolean;
  reload: boolean;
}

/**
 * The WindowRecorder shape: public snapshot + private witness for one tick.
 * `ammo/cooldown/reloadTimer` are the hidden state AFTER this tick; `reloadPress` is this
 * tick's input. Matches the circuit's per-tick private inputs (ARCHITECTURE §5.2).
 */
export interface TickRecord extends PublicSnap, Hidden {
  tick: number;
  reloadPress: number;
}

export type WeaponRow = 'W1' | 'W2' | 'W3' | 'W4' | 'W5';

export const INITIAL_HIDDEN: Readonly<Hidden> = Object.freeze({
  ammo: MAG_SIZE,
  cooldown: 0,
  reloadTimer: 0,
});

export const X_MIN = PLAYER_RADIUS;
export const X_MAX = ARENA_W - PLAYER_RADIUS;
export const Y_MIN = PLAYER_RADIUS;
export const Y_MAX = ARENA_H - PLAYER_RADIUS;

export class IllegalTransitionError extends Error {}

/** A player's spawn as a public snapshot with fired = 0 (also the round's `prevSnapshot`). */
export function spawnSnapshot(p: PlayerIndex): PublicSnap {
  const s = SPAWNS[p];
  return { x: s.x, y: s.y, angle: s.angle, fired: 0 };
}

export function spawnState(p: PlayerIndex): PlayerState {
  return { pub: spawnSnapshot(p), hidden: { ...INITIAL_HIDDEN } };
}

export function toTuple(s: PublicSnap): [number, number, number, number] {
  return [s.x, s.y, s.angle, s.fired];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Normalise an integer angle into [0, ANGLE_UNITS). */
export function normAngle(a: number): number {
  return ((a % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
}

// ------------------------------------------------------------------ movement

/** Honest movement: each held axis steps exactly `speed`, then clamps to the arena. */
export function stepMovement(
  x: number,
  y: number,
  moveX: number,
  moveY: number,
  speed: number = MAX_SPEED,
): { x: number; y: number } {
  return {
    x: clamp(x + sign(moveX) * speed, X_MIN, X_MAX),
    y: clamp(y + sign(moveY) * speed, Y_MIN, Y_MAX),
  };
}

/** Exact step: each axis rounded and clamped to ±`speed`, then clamped to the arena. */
export function stepExact(
  x: number,
  y: number,
  dx: number,
  dy: number,
  speed: number = MAX_SPEED,
): { x: number; y: number } {
  return {
    x: clamp(x + clamp(Math.round(dx), -speed, speed), X_MIN, X_MAX),
    y: clamp(y + clamp(Math.round(dy), -speed, speed), Y_MIN, Y_MAX),
  };
}

// ------------------------------------------------------------------ aim

/** Shortest-arc angle difference magnitude in [0, ANGLE_UNITS/2]. */
export function turnDelta(from: number, to: number): number {
  const d = normAngle(to - from);
  return Math.min(d, ANGLE_UNITS - d);
}

/** Signed shortest-arc difference in (−ANGLE_UNITS/2, ANGLE_UNITS/2]. */
export function signedTurn(from: number, to: number): number {
  const d = normAngle(to - from);
  return d > ANGLE_UNITS / 2 ? d - ANGLE_UNITS : d;
}

/** Turn toward `target` along the shortest arc, at most `maxTurn` units. */
export function stepAim(angle: number, target: number, maxTurn: number = MAX_TURN): number {
  const d = signedTurn(angle, target);
  return normAngle(angle + clamp(d, -maxTurn, maxTurn));
}

// ------------------------------------------------------------------ weapon (table W1–W5)

export function canFire(h: Hidden): boolean {
  return h.ammo > 0 && h.cooldown === 0 && h.reloadTimer === 0;
}

/** Which row of the ARCHITECTURE §3 weapon table applies (W1 does not imply legality). */
export function weaponRow(h: Hidden, fired: number, reloadPress: number): WeaponRow {
  if (fired === 1) return 'W1';
  if (h.reloadTimer > 1) return 'W2';
  if (h.reloadTimer === 1) return 'W3';
  if (reloadPress === 1 && h.ammo < MAG_SIZE) return 'W4';
  return 'W5';
}

/** Apply the weapon transition table. Throws IllegalTransitionError on an illegal shot. */
export function stepWeapon(h: Hidden, fired: number, reloadPress: number): Hidden {
  const cd = Math.max(h.cooldown - 1, 0);
  switch (weaponRow(h, fired, reloadPress)) {
    case 'W1':
      if (!canFire(h))
        throw new IllegalTransitionError('fire while ammo=0, cooldown>0 or reloading');
      return { ammo: h.ammo - 1, cooldown: FIRE_COOLDOWN - 1, reloadTimer: 0 };
    case 'W2':
      return { ammo: h.ammo, cooldown: cd, reloadTimer: h.reloadTimer - 1 };
    case 'W3':
      return { ammo: MAG_SIZE, cooldown: cd, reloadTimer: 0 };
    case 'W4':
      return { ammo: h.ammo, cooldown: cd, reloadTimer: RELOAD_TICKS };
    case 'W5':
      return { ammo: h.ammo, cooldown: cd, reloadTimer: 0 };
  }
}

// ------------------------------------------------------------------ full tick

/**
 * One honest tick for one player. The client clamps every input to a legal value, so the
 * result always satisfies `checkTick` (and therefore the circuit).
 */
export function stepPlayer(
  prev: PlayerState,
  input: TickInput,
): { state: PlayerState; reloadPress: number } {
  const { x, y } = input.step
    ? stepExact(prev.pub.x, prev.pub.y, input.step.dx, input.step.dy)
    : stepMovement(prev.pub.x, prev.pub.y, input.moveX, input.moveY);
  const angle = stepAim(prev.pub.angle, input.aimTarget);
  const autoReload = prev.hidden.ammo === 0 && prev.hidden.reloadTimer === 0;
  const reloadPress = input.reload || autoReload ? 1 : 0;
  const fired = input.fire && canFire(prev.hidden) ? 1 : 0;
  const hidden = stepWeapon(prev.hidden, fired, reloadPress);
  return { state: { pub: { x, y, angle, fired }, hidden }, reloadPress };
}

/**
 * "Hold" tick: same position and angle, fired = 0, reloadPress = 0, hidden state rolled
 * forward. Used for the client's own gap fill and for round-end window padding — the server
 * fills missing ticks with exactly the same public values.
 */
export function holdTick(prev: PlayerState): PlayerState {
  return {
    pub: { x: prev.pub.x, y: prev.pub.y, angle: prev.pub.angle, fired: 0 },
    hidden: stepWeapon(prev.hidden, 0, 0),
  };
}

export function toRecord(tick: number, s: PlayerState, reloadPress: number): TickRecord {
  return { tick, ...s.pub, reloadPress, ...s.hidden };
}

export function fromRecord(r: TickRecord): PlayerState {
  return {
    pub: { x: r.x, y: r.y, angle: r.angle, fired: r.fired },
    hidden: { ammo: r.ammo, cooldown: r.cooldown, reloadTimer: r.reloadTimer },
  };
}

// ------------------------------------------------------------------ checker (circuit mirror)

export type Violation =
  | 'x_bounds'
  | 'y_bounds'
  | 'angle_range'
  | 'fired_bool'
  | 'reload_bool'
  | 'speed_x'
  | 'speed_y'
  | 'turn'
  | 'fire_illegal'
  | 'weapon_transition';

/**
 * Every per-tick rule the circuit enforces (ARCHITECTURE §5.3, excluding hashing).
 * Returns the list of violated rules; empty means the tick is legal.
 */
export function checkTick(prev: PlayerState, rec: TickRecord): Violation[] {
  const v: Violation[] = [];
  if (!(rec.x >= X_MIN && rec.x <= X_MAX)) v.push('x_bounds');
  if (!(rec.y >= Y_MIN && rec.y <= Y_MAX)) v.push('y_bounds');
  if (!(rec.angle >= 0 && rec.angle < ANGLE_UNITS)) v.push('angle_range');
  if (rec.fired !== 0 && rec.fired !== 1) v.push('fired_bool');
  if (rec.reloadPress !== 0 && rec.reloadPress !== 1) v.push('reload_bool');
  if (Math.abs(rec.x - prev.pub.x) > MAX_SPEED) v.push('speed_x');
  if (Math.abs(rec.y - prev.pub.y) > MAX_SPEED) v.push('speed_y');
  if (turnDelta(prev.pub.angle, rec.angle) > MAX_TURN) v.push('turn');
  if (rec.fired === 1 && !canFire(prev.hidden)) {
    v.push('fire_illegal');
  } else if (
    (rec.fired === 0 || rec.fired === 1) &&
    (rec.reloadPress === 0 || rec.reloadPress === 1)
  ) {
    const e = stepWeapon(prev.hidden, rec.fired, rec.reloadPress);
    if (e.ammo !== rec.ammo || e.cooldown !== rec.cooldown || e.reloadTimer !== rec.reloadTimer) {
      v.push('weapon_transition');
    }
  }
  return v;
}

/** Check a whole sequence starting from `initial`; returns the first failing tick, if any. */
export function checkSequence(
  initial: PlayerState,
  records: readonly TickRecord[],
): { index: number; violations: Violation[] } | null {
  let prev = initial;
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as TickRecord;
    const violations = checkTick(prev, r);
    if (violations.length) return { index: i, violations };
    prev = fromRecord(r);
  }
  return null;
}

// ------------------------------------------------------------------ windows

export function windowIndexOf(tick: number, windowTicks: number): number {
  return Math.floor(tick / windowTicks);
}

/**
 * Build the window containing `endTick` the way client and server must both do at round end
 * (ARCHITECTURE §4): drop ticks > endTick, then pad to N ticks by holding the snapshot at
 * endTick (fired = 0, reloadPress = 0, hidden state rolled forward).
 * `records` are the window's records in tick order, starting at windowIndex·N.
 */
export function truncateAndPad(
  records: readonly TickRecord[],
  endTick: number,
  windowTicks: number,
): TickRecord[] {
  const kept = records.filter((r) => r.tick <= endTick);
  const last = kept[kept.length - 1];
  if (!last) throw new Error('truncateAndPad: window has no tick ≤ endTick');
  const start = last.tick - (last.tick % windowTicks);
  if (kept.length !== last.tick - start + 1) throw new Error('truncateAndPad: missing ticks');
  const out = kept.slice();
  let s = fromRecord(last);
  for (let t = last.tick + 1; t < start + windowTicks; t++) {
    s = holdTick(s);
    out.push(toRecord(t, s, 0));
  }
  return out;
}

/** Public-only version of the padding, used by the server (which never sees hidden state). */
export function truncateAndPadPublic<T extends PublicSnap & { tick: number }>(
  snaps: readonly T[],
  endTick: number,
  windowTicks: number,
): (PublicSnap & { tick: number })[] {
  const kept: (PublicSnap & { tick: number })[] = snaps
    .filter((s) => s.tick <= endTick)
    .map((s) => ({ tick: s.tick, x: s.x, y: s.y, angle: s.angle, fired: s.fired }));
  const last = kept[kept.length - 1];
  if (!last) throw new Error('truncateAndPadPublic: window has no tick ≤ endTick');
  const start = last.tick - (last.tick % windowTicks);
  for (let t = last.tick + 1; t < start + windowTicks; t++) {
    kept.push({ tick: t, x: last.x, y: last.y, angle: last.angle, fired: 0 });
  }
  return kept;
}

// ------------------------------------------------------------------ hashing (determinism tests)

/** FNV-1a 32-bit over the integer fields of a record sequence. */
export function stateHash(records: readonly TickRecord[]): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    // fold a 32-bit signed integer, byte by byte
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const r of records) {
    mix(r.tick);
    mix(r.x);
    mix(r.y);
    mix(r.angle);
    mix(r.fired);
    mix(r.reloadPress);
    mix(r.ammo);
    mix(r.cooldown);
    mix(r.reloadTimer);
  }
  return h >>> 0;
}
