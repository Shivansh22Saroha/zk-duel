/**
 * Turn an honest client tick log into a cheating one (for offline negative tests, B6).
 *
 *   npm run circuits:mutate-log -- --log <in.jsonl> --out <out.jsonl> --cheat speed|rapid|ammo [--round 1] [--tick T]
 *
 * The cheat happens at ONE tick; the hidden state afterwards is re-derived with the normal rules
 * (as a cheating client's own sim would), so the log stays self-consistent except for the cheat:
 *  - speed : the player is displaced 2·MAX_SPEED for that tick (Δ > MAX_SPEED in and out)
 *  - rapid : a shot is fired while the cooldown is still running (ammo and cooldown updated as if legal)
 *  - ammo  : a shot does not decrement ammo (infinite ammo)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRE_COOLDOWN, MAX_SPEED } from '@zkduel/shared/constants';
import {
  canFire,
  INITIAL_HIDDEN,
  stepWeapon,
  type Hidden,
  type TickRecord,
} from '@zkduel/shared/sim';
import type { TickLogLine } from '@zkduel/shared/ticklog';

export type Cheat = 'speed' | 'rapid' | 'ammo';
type Tick = Extract<TickLogLine, { type: 'tick' }> & TickRecord;

/** Like stepWeapon, but lets a shot through regardless of legality (a cheating client). */
function lenientStep(h: Hidden, fired: number, press: number): Hidden {
  if (fired === 1 && !canFire(h))
    return { ammo: Math.max(0, h.ammo - 1), cooldown: FIRE_COOLDOWN - 1, reloadTimer: 0 };
  return stepWeapon(h, fired, press);
}

export interface MutationResult {
  lines: TickLogLine[];
  roundNo: number;
  tick: number;
}

export function mutateLog(
  lines: readonly TickLogLine[],
  cheat: Cheat,
  opts: { roundNo?: number; tick?: number; windowTicks?: number } = {},
): MutationResult {
  const roundNo = opts.roundNo ?? 1;
  const n = opts.windowTicks ?? 60;
  const out = lines.map((l) => ({ ...l })) as TickLogLine[];
  const ticks = out
    .filter((l): l is Tick => l.type === 'tick' && l.roundNo === roundNo && 'reloadPress' in l)
    .sort((a, b) => a.tick - b.tick);
  if (ticks.length < 3) throw new Error(`round ${roundNo} too short`);
  const hiddenBefore = (i: number): Hidden => {
    const p = ticks[i - 1];
    return p
      ? { ammo: p.ammo, cooldown: p.cooldown, reloadTimer: p.reloadTimer }
      : { ...INITIAL_HIDDEN };
  };
  // pick a tick that suits the cheat and is not the last tick of a window
  const suits = (i: number): boolean => {
    const t = ticks[i] as Tick;
    if (i === 0 || i >= ticks.length - 2 || t.tick % n === n - 1) return false;
    const h = hiddenBefore(i);
    if (cheat === 'speed') return true;
    if (cheat === 'rapid')
      return t.fired === 0 && h.cooldown > 0 && h.ammo > 0 && h.reloadTimer === 0;
    return t.fired === 1; // ammo
  };
  let i = opts.tick !== undefined ? ticks.findIndex((t) => t.tick === opts.tick) : -1;
  if (i < 0) i = ticks.findIndex((_, k) => k >= Math.floor(ticks.length / 3) && suits(k));
  if (i < 0) i = ticks.findIndex((_, k) => suits(k));
  if (i < 0) throw new Error(`no tick suitable for '${cheat}' in round ${roundNo}`);
  const t = ticks[i] as Tick;

  if (cheat === 'speed') {
    t.x += t.x < 500 ? 2 * MAX_SPEED : -2 * MAX_SPEED; // one-tick teleport, back on the next tick
    return { lines: out, roundNo, tick: t.tick };
  }
  // re-derive hidden state from the cheat tick onward
  let h = hiddenBefore(i);
  for (let k = i; k < ticks.length; k++) {
    const r = ticks[k] as Tick;
    if (k === i && cheat === 'rapid') r.fired = 1;
    let next = lenientStep(h, r.fired, r.reloadPress);
    if (k === i && cheat === 'ammo') next = { ...next, ammo: h.ammo }; // shot without using ammo
    r.ammo = next.ammo;
    r.cooldown = next.cooldown;
    r.reloadTimer = next.reloadTimer;
    h = next;
  }
  return { lines: out, roundNo, tick: t.tick };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string): string | undefined => {
    const j = process.argv.indexOf(`--${k}`);
    return j >= 0 ? process.argv[j + 1] : undefined;
  };
  const inPath = arg('log');
  const outPath = arg('out');
  const cheat = arg('cheat') as Cheat | undefined;
  if (!inPath || !outPath || !cheat || !['speed', 'rapid', 'ammo'].includes(cheat)) {
    console.error(
      'usage: --log <in.jsonl> --out <out.jsonl> --cheat speed|rapid|ammo [--round R] [--tick T] [--n 60]',
    );
    process.exit(2);
  }
  const base = process.env.INIT_CWD ?? process.cwd(); // npm runs workspace scripts inside circuits/
  const lines = readFileSync(resolve(base, inPath), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TickLogLine);
  const r = mutateLog(lines, cheat, {
    roundNo: arg('round') ? Number(arg('round')) : undefined,
    tick: arg('tick') ? Number(arg('tick')) : undefined,
    windowTicks: arg('n') ? Number(arg('n')) : undefined,
  });
  writeFileSync(resolve(base, outPath), r.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${cheat}: round ${r.roundNo}, tick ${r.tick} → ${outPath}`);
}
