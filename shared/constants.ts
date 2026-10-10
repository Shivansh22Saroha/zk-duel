/**
 * Single source of truth for every ZK-Duel constant (docs/PRD.md §5).
 *
 * Imported by the client, the server and the circuit build script (which templates
 * the rule constants into circuits/main_<N>.circom). Never redefine these anywhere else.
 *
 * Every exported constant must also appear in `CONSTANTS` below: that object is what
 * `/api/circuit/info` returns and what `constantsHash` is computed over
 * (shared/constants.test.ts enforces this).
 */

// ---------------------------------------------------------------- simulation
/** Simulation ticks per second. */
export const TICK_RATE = 60;
/** Arena width in integer units. */
export const ARENA_W = 1000;
/** Arena height in integer units. */
export const ARENA_H = 600;
/** Player collision radius. Positions are kept within [R, W−R] × [R, H−R]. */
export const PLAYER_RADIUS = 12;
/** Max |Δx| and max |Δy| per tick. The honest client steps exactly this per held axis. */
export const MAX_SPEED = 4;
/** Angle units per full turn (tenths of a degree, 0–3599). */
export const ANGLE_UNITS = 3600;
/** Max shortest-arc angle change per tick (15°). */
export const MAX_TURN = 150;

// ---------------------------------------------------------------- weapon (hidden state)
/** Rounds per magazine. */
export const MAG_SIZE = 10;
/** Ticks between shots: a shot at tick t allows the next at exactly t + FIRE_COOLDOWN. */
export const FIRE_COOLDOWN = 12;
/** Reload duration in ticks (1.5 s). */
export const RELOAD_TICKS = 90;

// ---------------------------------------------------------------- combat & match
/** Health per round. */
export const MAX_HP = 100;
/** Damage per hit (4 hits to kill). */
export const DAMAGE = 25;
/** Rounds needed to win (best of 5). */
export const ROUNDS_TO_WIN = 3;
/** Fixed spawns per player index; also each round's `prevSnapshot` (with fired = 0). */
export const SPAWNS = [
  { x: 150, y: 300, angle: 0 },
  { x: 850, y: 300, angle: 1800 },
] as const;
/** Hit-scan ray length (arena diagonal is ≈ 1166). */
export const RAY_LENGTH = 1200;
/** Scale of the integer sin/cos table used for rays and the aim line. */
export const TRIG_SCALE = 1024;
/** Pause between rounds in ticks (1.5 s). No input applied, no windows counted. */
export const ROUND_PAUSE_TICKS = 90;
/** Pre-match countdown (3-2-1). */
export const COUNTDOWN_SECONDS = 3;

// ---------------------------------------------------------------- proofs
/** Default proof window in ticks. */
export const WINDOW_TICKS = 60;
/** Window sizes that may exist as circuit variants (4 = test variant). */
export const WINDOW_TICKS_VARIANTS = [4, 30, 60, 120] as const;
/** Window sizes used for benchmarks. */
export const BENCH_WINDOW_TICKS = [30, 60, 120] as const;
/** Proof schemes. */
export const SCHEMES = ['groth16', 'plonk'] as const;
/** Window k's proof must arrive before window k + PROOF_GRACE_WINDOWS ends. */
export const PROOF_GRACE_WINDOWS = 2;
/** Salts are random field elements of this many bits (< p). */
export const SALT_BITS = 248;
/**
 * A challenged window's proof must arrive within this time, else `timeout` (server env
 * PROOF_DEADLINE_MS overrides). Owner's default. Measured on AC (Phase 3): Chrome prove p95 at N=60
 * is 1.48 s alone, 2.78 s with two clients proving on one laptop.
 */
export const PROOF_DEADLINE_MS = 15_000;
/** Audit proofs are accepted this long after match_end (server env AUDIT_TIMEOUT_MIN overrides). */
export const AUDIT_TIMEOUT_MIN = 60;

// ---------------------------------------------------------------- network / liveness
/** Max ticks a missing snapshot is held before the player is `stalled`. */
export const STALL_TICKS = 6;
/** A disconnect longer than this forfeits the match. */
export const RECONNECT_TIMEOUT_MS = 10_000;
/** Client reconnect backoff schedule. */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000] as const;
/** The first WS message must be `hello` within this time. */
export const HELLO_TIMEOUT_MS = 5_000;
/** If a player has not sent `ready` this long after `match_found`, the match is cancelled. */
export const READY_TIMEOUT_MS = 30_000;
/** Invalid messages before the socket is closed with 4400. */
export const MAX_STRIKES = 5;
/** Per-connection WS rate limits (messages per second). */
export const RATE_LIMIT_SNAPSHOTS_PER_S = 70;
export const RATE_LIMIT_PROOFS_PER_S = 4;
/**
 * window_commit has its own budget: one per window, i.e. TICK_RATE / N per second — 15/s for the
 * N=4 test variant, 1/s at N=60 — plus slack for bursts after a reconnect.
 */
export const RATE_LIMIT_COMMITS_PER_S = 20;
export const RATE_LIMIT_OTHER_PER_S = 10;
/** Max WS message size in bytes. */
export const MAX_WS_PAYLOAD_BYTES = 65_536;
/** Integers in snapshots must satisfy |v| < this (so field encoding is unambiguous). */
export const SNAPSHOT_INT_LIMIT = 2 ** 31;

// ---------------------------------------------------------------- identity & rooms
export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 16;
export const DISPLAY_NAME_PATTERN = '^[A-Za-z0-9_]{3,16}$';
export const ROOM_CODE_LENGTH = 6;
/** Room code alphabet: no 0/O/1/I. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PATTERN = '^[A-HJ-NP-Z2-9]{6}$';
/** Unused private rooms expire after this. */
export const ROOM_EXPIRY_MS = 600_000;
/** Max length of the informational `proof_failed.reason`. */
export const PROOF_FAILED_REASON_MAX = 200;

/**
 * Every constant above, as one object. This is the canonical set returned by
 * `/api/circuit/info` and hashed into `constantsHash`.
 */
export const CONSTANTS = {
  TICK_RATE,
  ARENA_W,
  ARENA_H,
  PLAYER_RADIUS,
  MAX_SPEED,
  ANGLE_UNITS,
  MAX_TURN,
  MAG_SIZE,
  FIRE_COOLDOWN,
  RELOAD_TICKS,
  MAX_HP,
  DAMAGE,
  ROUNDS_TO_WIN,
  SPAWNS,
  RAY_LENGTH,
  TRIG_SCALE,
  ROUND_PAUSE_TICKS,
  COUNTDOWN_SECONDS,
  WINDOW_TICKS,
  WINDOW_TICKS_VARIANTS,
  BENCH_WINDOW_TICKS,
  SCHEMES,
  PROOF_GRACE_WINDOWS,
  SALT_BITS,
  PROOF_DEADLINE_MS,
  AUDIT_TIMEOUT_MIN,
  STALL_TICKS,
  RECONNECT_TIMEOUT_MS,
  RECONNECT_BACKOFF_MS,
  HELLO_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  MAX_STRIKES,
  RATE_LIMIT_SNAPSHOTS_PER_S,
  RATE_LIMIT_PROOFS_PER_S,
  RATE_LIMIT_COMMITS_PER_S,
  RATE_LIMIT_OTHER_PER_S,
  MAX_WS_PAYLOAD_BYTES,
  SNAPSHOT_INT_LIMIT,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_PATTERN,
  ROOM_CODE_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_PATTERN,
  ROOM_EXPIRY_MS,
  PROOF_FAILED_REASON_MAX,
} as const;

export type Constants = typeof CONSTANTS;
export type Scheme = (typeof SCHEMES)[number];
export type WindowTicks = (typeof WINDOW_TICKS_VARIANTS)[number];
export type PlayerIndex = 0 | 1;
