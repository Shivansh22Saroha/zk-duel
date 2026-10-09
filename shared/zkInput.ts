/**
 * JS reference for the circuit (circuits/window.circom): builds the exact circuit input object
 * for one window and the expected public signals (bind, digest, commitIn, commitOut).
 * Client (proof worker), server (digest/bind/commit checks), tests and tools all use this file.
 */
import { MAG_SIZE, SALT_BITS, type PlayerIndex } from './constants';
import { BN254_P } from './field';
import { poseidon } from './poseidon';
import {
  INITIAL_HIDDEN,
  truncateAndPad,
  type Hidden,
  type PublicSnap,
  type TickRecord,
} from './sim';
import type { TickLogLine } from './ticklog';

/** Logical names of the 4 public signals. Their order in `publicSignals` comes from info.json. */
export const PUBLIC_SIGNAL_NAMES = ['bind', 'digest', 'commitIn', 'commitOut'] as const;
export type PublicSignalName = (typeof PUBLIC_SIGNAL_NAMES)[number];
export type PublicValues = Record<PublicSignalName, string>;

export type Tuple4 = [number, number, number, number];

/** Everything about a window except its tick records. */
export interface WindowContext {
  matchField: string;
  playerIndex: PlayerIndex;
  roundNo: number;
  windowIndex: number;
  /** Last public snapshot before the window (round start: spawn with fired = 0). */
  prev: Tuple4;
  /** Hidden state entering the window (round start: INITIAL_HIDDEN). */
  hiddenIn: Hidden;
  /** Salt of the commitment entering the window ('0' for the first window of a round). */
  saltIn: string;
  /** Fresh salt for the commitment leaving the window. */
  saltOut: string;
}

/** The circuit's input object: every value a decimal field-element string. */
export interface CircuitInput {
  bind: string;
  digest: string;
  commitIn: string;
  matchField: string;
  playerIndex: string;
  roundNo: string;
  windowIndex: string;
  prev: string[];
  x: string[];
  y: string[];
  angle: string[];
  fired: string[];
  reloadPress: string[];
  ammo0: string;
  cooldown0: string;
  reload0: string;
  saltIn: string;
  ammo: string[];
  cooldown: string[];
  reloadT: string[];
  saltOut: string;
  [k: string]: string | string[];
}

/** Integer (possibly negative, e.g. in a cheating log) → canonical field element string. */
export function toField(v: number | bigint | string): string {
  const b = BigInt(v);
  return (((b % BN254_P) + BN254_P) % BN254_P).toString();
}

/** Fresh random salt: SALT_BITS (248) random bits — always < p. */
export function randomSalt(): string {
  const bytes = new Uint8Array(SALT_BITS / 8);
  globalThis.crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v.toString();
}

export function bindOf(
  matchField: string,
  playerIndex: number,
  roundNo: number,
  windowIndex: number,
): Promise<string> {
  return poseidon([matchField, playerIndex, roundNo, windowIndex].map(toField));
}

export function commitOf(h: Hidden, salt: string): Promise<string> {
  return poseidon([h.ammo, h.cooldown, h.reloadTimer, salt].map(toField));
}

/** Poseidon chain over public snapshots, seeded with Poseidon4(prev) (ARCHITECTURE §5.3 rule 1). */
export async function digestOf(prev: Tuple4, snaps: readonly PublicSnap[]): Promise<string> {
  let h = await poseidon(prev.map(toField));
  for (const s of snaps) h = await poseidon([h, s.x, s.y, s.angle, s.fired].map(toField));
  return h;
}

/** The round's public initial commitment: Poseidon4(MAG_SIZE, 0, 0, 0). */
export function initialCommitOf(): Promise<string> {
  return commitOf({ ammo: MAG_SIZE, cooldown: 0, reloadTimer: 0 }, '0');
}

/** Build the circuit input and the expected public values for one window of N records. */
export async function buildWindowInput(
  ctx: WindowContext,
  records: readonly TickRecord[],
): Promise<{ input: CircuitInput; expected: PublicValues }> {
  const last = records[records.length - 1];
  if (!last) throw new Error('buildWindowInput: empty window');
  const [bind, digest, commitIn, commitOut] = await Promise.all([
    bindOf(ctx.matchField, ctx.playerIndex, ctx.roundNo, ctx.windowIndex),
    digestOf(ctx.prev, records),
    commitOf(ctx.hiddenIn, ctx.saltIn),
    commitOf(last, ctx.saltOut),
  ]);
  const col = (k: keyof TickRecord): string[] => records.map((r) => toField(r[k]));
  const input: CircuitInput = {
    bind,
    digest,
    commitIn,
    matchField: toField(ctx.matchField),
    playerIndex: toField(ctx.playerIndex),
    roundNo: toField(ctx.roundNo),
    windowIndex: toField(ctx.windowIndex),
    prev: ctx.prev.map(toField),
    x: col('x'),
    y: col('y'),
    angle: col('angle'),
    fired: col('fired'),
    reloadPress: col('reloadPress'),
    ammo0: toField(ctx.hiddenIn.ammo),
    cooldown0: toField(ctx.hiddenIn.cooldown),
    reload0: toField(ctx.hiddenIn.reloadTimer),
    saltIn: toField(ctx.saltIn),
    ammo: col('ammo'),
    cooldown: col('cooldown'),
    reloadT: col('reloadTimer'),
    saltOut: toField(ctx.saltOut),
  };
  return { input, expected: { bind, digest, commitIn, commitOut } };
}

/** Map snarkjs `publicSignals` to names using info.json's publicSignalOrder (never hard-coded). */
export function namePublicSignals(
  order: readonly PublicSignalName[],
  signals: readonly string[],
): PublicValues {
  if (order.length !== signals.length)
    throw new Error('publicSignals length does not match publicSignalOrder');
  const out = {} as PublicValues;
  order.forEach((name, i) => (out[name] = signals[i] as string));
  return out;
}

// ------------------------------------------------------------------ slicing tick logs into windows

export interface LogWindow {
  ctx: WindowContext;
  records: TickRecord[];
  /** True when this is the padded final window of a round. */
  padded: boolean;
}

type ClientTick = Extract<TickLogLine, { type: 'tick' }> & TickRecord;

/**
 * Slice a client tick log (shared/ticklog.ts) into N-tick windows per round, exactly as the
 * client will in Phase 3: ticks > endTick dropped, the final window truncated + padded, the
 * hidden state and salts chained window to window, and the chain restarted every round.
 * `saltFor(roundNo, windowIndex)` supplies each window's saltOut.
 */
export function sliceLogWindows(
  lines: readonly TickLogLine[],
  n: number,
  saltFor: (roundNo: number, windowIndex: number) => string,
): LogWindow[] {
  const header = lines.find((l) => l.type === 'header');
  if (
    !header ||
    header.type !== 'header' ||
    header.source !== 'client' ||
    header.playerIndex === undefined
  ) {
    throw new Error('not a client tick log (needs a client header with playerIndex)');
  }
  const out: LogWindow[] = [];
  for (const start of lines.filter((l) => l.type === 'round_start')) {
    if (start.type !== 'round_start') continue;
    const roundNo = start.roundNo;
    const end = lines.find((l) => l.type === 'round_end' && l.roundNo === roundNo);
    const ticks = lines
      .filter(
        (l): l is ClientTick => l.type === 'tick' && l.roundNo === roundNo && 'reloadPress' in l,
      )
      .sort((a, b) => a.tick - b.tick);
    if (!ticks.length) continue;
    const endTick =
      end && end.type === 'round_end' ? end.endTick : (ticks[ticks.length - 1] as ClientTick).tick;
    const recs: TickRecord[] = ticks
      .filter((t) => t.tick <= endTick)
      .map(({ tick, x, y, angle, fired, reloadPress, ammo, cooldown, reloadTimer }) => ({
        tick,
        x,
        y,
        angle,
        fired,
        reloadPress,
        ammo,
        cooldown,
        reloadTimer,
      }));
    recs.forEach((r, i) => {
      if (r.tick !== i) throw new Error(`round ${roundNo}: missing tick ${i}`);
    });
    let prev = start.prevSnapshot as Tuple4;
    let hiddenIn: Hidden = { ...INITIAL_HIDDEN };
    let saltIn = '0';
    for (let k = 0; k * n <= endTick; k++) {
      const slice = recs.slice(k * n, k * n + n);
      const padded = slice.length < n;
      const windowRecs = padded ? truncateAndPad(slice, endTick, n) : slice;
      const saltOut = saltFor(roundNo, k);
      out.push({
        ctx: {
          matchField: header.matchField,
          playerIndex: header.playerIndex,
          roundNo,
          windowIndex: k,
          prev,
          hiddenIn,
          saltIn,
          saltOut,
        },
        records: windowRecs,
        padded,
      });
      const last = windowRecs[windowRecs.length - 1] as TickRecord;
      prev = [last.x, last.y, last.angle, last.fired];
      hiddenIn = { ammo: last.ammo, cooldown: last.cooldown, reloadTimer: last.reloadTimer };
      saltIn = saltOut;
    }
  }
  return out;
}

/** Deterministic salts for tests/tools (NOT for real play — use randomSalt()). */
export function testSalt(seed: number): (roundNo: number, windowIndex: number) => string {
  return (r, k) => toField(BigInt(seed) * 1_000_003n + BigInt(r) * 10_007n + BigInt(k) + 1n);
}
