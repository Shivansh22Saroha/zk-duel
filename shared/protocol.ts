/**
 * WebSocket message types + REST bodies, as zod schemas (docs/API_SPEC.md).
 *
 * Rules (docs/SECURITY.md §4):
 *  - every message is validated; unknown fields are stripped (zod default);
 *  - field elements are decimal strings < p (scalars) or < q (proof coordinates);
 *  - hidden state (ammo, cooldown, reload timer, salts) has NO field in any client→server
 *    schema — it can never be sent.
 */
import { z } from 'zod';
import {
  DISPLAY_NAME_PATTERN,
  MAX_HP,
  PROOF_FAILED_REASON_MAX,
  ROOM_CODE_PATTERN,
  ROUNDS_TO_WIN,
  SCHEMES,
  SNAPSHOT_INT_LIMIT,
  WINDOW_TICKS_VARIANTS,
  type WindowTicks,
} from './constants';
import { isBaseFieldElement, isFieldElement } from './field';

// ------------------------------------------------------------------ primitives

const MAX_ROUNDS = ROUNDS_TO_WIN * 2 - 1;
/** Generous upper bound for round-relative tick / window counters (≈ 9 h at 60 Hz). */
const MAX_COUNTER = 2_000_000;

export const fieldElement = z
  .string()
  .max(78)
  .refine(isFieldElement, { message: 'not a field element < p' });
export const baseFieldElement = z
  .string()
  .max(78)
  .refine(isBaseFieldElement, { message: 'not a base-field element < q' });

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');
export const displayName = z
  .string()
  .regex(new RegExp(DISPLAY_NAME_PATTERN), 'invalid display name');
/** Room codes are case-insensitive on entry: uppercased before validation. */
export const roomCode = z
  .string()
  .max(16)
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(new RegExp(ROOM_CODE_PATTERN), 'invalid room code'));

export const playerIndex = z.union([z.literal(0), z.literal(1)]);
export const scheme = z.enum(SCHEMES);
export const windowTicks = z
  .number()
  .int()
  .refine((n): n is WindowTicks => (WINDOW_TICKS_VARIANTS as readonly number[]).includes(n), {
    message: 'unsupported window size',
  });
export const enforcement = z.enum(['observe', 'strict']);
export const roundNo = z.number().int().min(1).max(MAX_ROUNDS);
export const windowIndex = z.number().int().min(0).max(MAX_COUNTER);
export const tick = z.number().int().min(0).max(MAX_COUNTER);
/** Snapshot integers: any integer with |v| < 2^31. Range legality is NOT checked here (API §4). */
const snapshotInt = z.number().int().gt(-SNAPSHOT_INT_LIMIT).lt(SNAPSHOT_INT_LIMIT);
const finiteNonNeg = z.number().finite().min(0);

/** Per-window status (API_SPEC §5). `committed` = claimed, not yet proven; `unaudited` = audit closed first. */
export const proofStatus = z.enum([
  'committed',
  'valid',
  'malformed',
  'mismatch_bind',
  'mismatch_digest',
  'mismatch_commit',
  'missing_commit',
  'invalid',
  'unprovable',
  'timeout',
  'chain_broken',
  'unaudited',
]);
/** Statuses that count as a failed window (a rule violation or a withheld proof/commit). */
export const FAILURE_STATUSES = [
  'malformed',
  'mismatch_bind',
  'mismatch_digest',
  'mismatch_commit',
  'missing_commit',
  'invalid',
  'unprovable',
  'timeout',
] as const satisfies readonly z.infer<typeof proofStatus>[];
export const auditStatus = z.enum(['audited_clean', 'audited_failed', 'audit_incomplete']);
export const cheatName = z.enum([
  'speedhack',
  'rapid_fire',
  'snap_aim',
  'smooth_aim',
  'infinite_ammo',
]);
/**
 * DB end_reason values plus 'forfeit' (voluntary `forfeit` message).
 * NOTE: 'forfeit' is not yet in DATABASE_SCHEMA `matches.end_reason` — flagged for decision.
 */
export const endReason = z.enum(['rounds', 'forfeit_proof', 'disconnect', 'abort', 'forfeit']);
export const wsErrorCode = z.enum([
  'INVALID_BODY',
  'INVALID_ROOM_CODE',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ALREADY_IN_MATCH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VERSION_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL',
]);

/** Public snapshot as a 4-tuple [x, y, angle, fired] (prevSnapshot). */
export const snapshotTuple = z.tuple([snapshotInt, snapshotInt, snapshotInt, snapshotInt]);
const spawn = z
  .object({ x: z.number().int(), y: z.number().int(), angle: z.number().int() })
  .strict();

// ------------------------------------------------------------------ proofs

const g1 = z.tuple([baseFieldElement, baseFieldElement, baseFieldElement]);
const g2 = z.tuple([
  z.tuple([baseFieldElement, baseFieldElement]),
  z.tuple([baseFieldElement, baseFieldElement]),
  z.tuple([baseFieldElement, baseFieldElement]),
]);

export const groth16Proof = z
  .object({
    pi_a: g1,
    pi_b: g2,
    pi_c: g1,
    protocol: z.literal('groth16'),
    curve: z.literal('bn128'),
  })
  .strict();

/** snarkjs 0.7.x PLONK proof (src/plonk_prove.js). Re-checked against a real proof in Phase 3. */
export const plonkProof = z
  .object({
    A: g1,
    B: g1,
    C: g1,
    Z: g1,
    T1: g1,
    T2: g1,
    T3: g1,
    Wxi: g1,
    Wxiw: g1,
    eval_a: fieldElement,
    eval_b: fieldElement,
    eval_c: fieldElement,
    eval_s1: fieldElement,
    eval_s2: fieldElement,
    eval_zw: fieldElement,
    protocol: z.literal('plonk'),
    curve: z.literal('bn128'),
  })
  .strict();

// ------------------------------------------------------------------ client → server

export const helloMsg = z.object({
  t: z.literal('hello'),
  token: z.string().min(1).max(4096),
  clientVersion: z.string().min(1).max(32),
  constantsHash: hex64,
});
export const queueJoinMsg = z.object({ t: z.literal('queue_join') });
export const queueLeaveMsg = z.object({ t: z.literal('queue_leave') });
export const roomJoinMsg = z.object({ t: z.literal('room_join'), roomCode });
export const readyMsg = z.object({ t: z.literal('ready'), artefactSha256: hex64 });
export const inputSnapshotMsg = z.object({
  t: z.literal('input_snapshot'),
  tick,
  x: snapshotInt,
  y: snapshotInt,
  angle: snapshotInt,
  fired: snapshotInt,
});
export const windowCommitMsg = z.object({
  t: z.literal('window_commit'),
  roundNo,
  windowIndex,
  commitOut: fieldElement,
});
/** Header of a window_proof — parsed first so a malformed body can still be attributed to a window. */
export const windowProofHeader = z.object({
  t: z.literal('window_proof'),
  matchId: z.string().uuid(),
  roundNo,
  windowIndex,
});
export const windowProofMsg = z
  .object({
    t: z.literal('window_proof'),
    matchId: z.string().uuid(),
    roundNo,
    windowIndex,
    scheme,
    proof: z.union([groth16Proof, plonkProof]),
    publicSignals: z.array(fieldElement).length(4),
    proveMs: finiteNonNeg.max(3_600_000),
  })
  .refine((m) => m.proof.protocol === m.scheme, {
    message: 'proof.protocol does not match scheme',
    path: ['proof', 'protocol'],
  });
export const proofFailedMsg = z.object({
  t: z.literal('proof_failed'),
  matchId: z.string().uuid(),
  roundNo,
  windowIndex,
  reason: z.string().max(PROOF_FAILED_REASON_MAX),
});
export const cheatToggleMsg = z.object({
  t: z.literal('cheat_toggle'),
  cheat: cheatName,
  enabled: z.boolean(),
  tick,
});
export const pingMsg = z.object({ t: z.literal('ping'), ts: z.number().finite() });
export const forfeitMsg = z.object({ t: z.literal('forfeit') });

/** window_proof is validated separately (header first, then full) — see windowProofHeader. */
// (`window_commit` carries only a commitment — a field element; never any hidden value.)
export const clientMessage = z.discriminatedUnion('t', [
  helloMsg,
  queueJoinMsg,
  queueLeaveMsg,
  roomJoinMsg,
  readyMsg,
  inputSnapshotMsg,
  windowCommitMsg,
  proofFailedMsg,
  cheatToggleMsg,
  pingMsg,
  forfeitMsg,
]);

// ------------------------------------------------------------------ server → client

const playerState = z.object({
  x: z.number().int(),
  y: z.number().int(),
  angle: z.number().int(),
  fired: z.number().int(),
  hp: z.number().int().min(0).max(MAX_HP),
});
const score = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

export const welcomeMsg = z.object({
  t: z.literal('welcome'),
  playerId: z.string().uuid(),
  serverVersion: z.string(),
});
export const queuedMsg = z.object({ t: z.literal('queued'), position: z.number().int().min(1) });
export const matchFoundMsg = z.object({
  t: z.literal('match_found'),
  matchId: z.string().uuid(),
  matchField: fieldElement,
  playerIndex,
  opponentName: displayName,
  scheme,
  windowTicks,
  enforcement,
  spawns: z.tuple([spawn, spawn]),
  initialCommit: fieldElement,
  prevSnapshot: snapshotTuple,
  /** Artefact id, e.g. groth16_60 (`/zk/<variant>/…`). */
  variant: z.string().regex(/^(groth16|plonk)_\d{1,3}$/),
});
export const countdownMsg = z.object({
  t: z.literal('countdown'),
  secondsLeft: z.number().int().min(0),
});
export const startMsg = z.object({
  t: z.literal('start'),
  roundNo,
  startTick: z.literal(0),
  serverTime: z.number().finite(),
});
export const stateMsg = z.object({
  t: z.literal('state'),
  roundNo,
  phase: z.enum(['live', 'pause']),
  tick,
  players: z.tuple([playerState, playerState]),
  hits: z.array(z.object({ shooter: playerIndex, target: playerIndex, tick })),
});
export const roundEndMsg = z.object({
  t: z.literal('round_end'),
  roundNo,
  endTick: tick,
  winnerIndex: playerIndex,
  score,
  pauseTicks: z.number().int().min(0),
  initialCommit: fieldElement,
  prevSnapshot: snapshotTuple,
});
export const challengeMsg = z.object({
  t: z.literal('challenge'),
  playerIndex,
  roundNo,
  windowIndex,
  deadlineMs: z.number().int().min(0),
});
export const proofResultMsg = z.object({
  t: z.literal('proof_result'),
  matchId: z.string().uuid(),
  playerIndex,
  roundNo,
  windowIndex,
  status: proofStatus,
  verifyMs: finiteNonNeg.nullable(),
  phase: z.enum(['live', 'audit']),
});
const auditCounts = z.object({
  /** This player's own audit result (a loser's failure is recorded without changing the result). */
  auditStatus: z.enum(['audited_clean', 'audited_failed', 'audit_incomplete']),
  valid: z.number().int().min(0),
  failed: z.number().int().min(0),
  unaudited: z.number().int().min(0),
  chainBroken: z.number().int().min(0),
});
export const auditEndMsg = z.object({
  t: z.literal('audit_end'),
  matchId: z.string().uuid(),
  auditStatus,
  overturned: z.boolean(),
  players: z.tuple([auditCounts, auditCounts]),
});
export const resumeMsg = z.object({
  t: z.literal('resume'),
  roundNo,
  nextWindowIndex: windowIndex,
  chainStatus: z.enum(['intact', 'broken']),
  /** Window indices of the current round whose commit the server holds. */
  committed: z.array(windowIndex).max(MAX_COUNTER),
  challenge: z.object({ roundNo, windowIndex, deadlineMs: z.number().int().min(0) }).nullable(),
});
export const cheatFlagMsg = z.object({
  t: z.literal('cheat_flag'),
  playerIndex,
  cheat: cheatName,
  enabled: z.boolean(),
});
export const opponentStatusMsg = z.object({
  t: z.literal('opponent_status'),
  status: z.enum(['connected', 'reconnecting', 'stalled']),
});
export const matchEndMsg = z.object({
  t: z.literal('match_end'),
  winnerIndex: playerIndex.nullable(),
  reason: endReason,
  score,
  resultsUrl: z.string().max(256),
  /** The post-match audit window that starts now (AUDIT_TIMEOUT_MIN). */
  auditTimeoutMs: z.number().int().min(0),
});
export const pongMsg = z.object({
  t: z.literal('pong'),
  ts: z.number().finite(),
  serverTime: z.number().finite(),
});
export const errorMsg = z.object({
  t: z.literal('error'),
  code: wsErrorCode,
  message: z.string().max(500),
});

export const serverMessage = z.discriminatedUnion('t', [
  welcomeMsg,
  queuedMsg,
  matchFoundMsg,
  countdownMsg,
  startMsg,
  stateMsg,
  roundEndMsg,
  challengeMsg,
  proofResultMsg,
  auditEndMsg,
  resumeMsg,
  cheatFlagMsg,
  opponentStatusMsg,
  matchEndMsg,
  pongMsg,
  errorMsg,
]);

// ------------------------------------------------------------------ REST bodies

export const guestAuthBody = z.object({ displayName });
export const createRoomBody = z.object({ enforcement: enforcement.optional() });

export const benchResultRow = z.object({
  scheme,
  windowTicks,
  constraints: z.number().int().min(1),
  sampleNo: z.number().int().min(1),
  witnessMs: finiteNonNeg,
  proveMs: finiteNonNeg,
  verifyMs: finiteNonNeg,
  proofBytes: z.number().int().min(1),
  valid: z.boolean(),
});
export const benchUploadBody = z.object({
  environment: z.enum(['node', 'browser']),
  deviceLabel: z.string().min(1).max(120),
  userAgent: z.string().max(512).optional(),
  cpuThreads: z.number().int().min(1).max(1024).optional(),
  inputLog: z.string().min(1).max(200),
  seed: z.number().int(),
  gitCommit: z.string().max(64).optional(),
  notes: z.string().max(1000).optional(),
  results: z.array(benchResultRow).min(1).max(2000),
});

export const restErrorCode = z.enum([
  'INVALID_NAME',
  'INVALID_BODY',
  'INVALID_ROOM_CODE',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ALREADY_IN_MATCH',
  'RATE_LIMITED',
  'INTERNAL',
]);
export const restError = z.object({
  error: z.object({ code: restErrorCode, message: z.string() }),
});

// ------------------------------------------------------------------ types

export type ClientMessage = z.infer<typeof clientMessage>;
export type WindowProofMessage = z.infer<typeof windowProofMsg>;
/** Everything a client may send (window_proof is validated outside the discriminated union). */
export type ClientFrame = ClientMessage | WindowProofMessage;
export type ServerMessage = z.infer<typeof serverMessage>;
export type ProofStatus = z.infer<typeof proofStatus>;
export type AuditStatus = z.infer<typeof auditStatus>;
export type WindowCommitMessage = z.infer<typeof windowCommitMsg>;
export type ProofFailedMessage = z.infer<typeof proofFailedMsg>;
export type CheatName = z.infer<typeof cheatName>;
export type EndReason = z.infer<typeof endReason>;
export type Groth16Proof = z.infer<typeof groth16Proof>;
export type PlonkProof = z.infer<typeof plonkProof>;
export type BenchUploadBody = z.infer<typeof benchUploadBody>;
