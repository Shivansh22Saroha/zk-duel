import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { BN254_P, BN254_Q, isBaseFieldElement, isFieldElement } from './field';
import * as P from './protocol';

const P_STR = BN254_P.toString();
const P_MINUS_1 = (BN254_P - 1n).toString();
const HEX64 = 'a'.repeat(64);
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
const F = '12345678901234567890';

const groth16 = {
  pi_a: [F, F, '1'],
  pi_b: [
    [F, F],
    [F, F],
    ['1', '0'],
  ],
  pi_c: [F, F, '1'],
  protocol: 'groth16',
  curve: 'bn128',
};
const g1 = [F, F, '1'];
const plonk = {
  A: g1,
  B: g1,
  C: g1,
  Z: g1,
  T1: g1,
  T2: g1,
  T3: g1,
  Wxi: g1,
  Wxiw: g1,
  eval_a: F,
  eval_b: F,
  eval_c: F,
  eval_s1: F,
  eval_s2: F,
  eval_zw: F,
  protocol: 'plonk',
  curve: 'bn128',
};
const windowProof = {
  t: 'window_proof',
  matchId: UUID,
  roundNo: 1,
  windowIndex: 3,
  scheme: 'groth16',
  proof: groth16,
  publicSignals: [F, F, F, F],
  proveMs: 412.5,
};

/** [schema, valid example, list of [description, invalid variant]] */
type Case = [string, ZodTypeAny, Record<string, unknown>, [string, unknown][]];

const cases: Case[] = [
  [
    'hello',
    P.helloMsg,
    { t: 'hello', token: 'jwt', clientVersion: '0.1.0', constantsHash: HEX64 },
    [
      ['missing token', { t: 'hello', clientVersion: '0.1.0', constantsHash: HEX64 }],
      ['bad hash', { t: 'hello', token: 'jwt', clientVersion: '0.1.0', constantsHash: 'XYZ' }],
      [
        'oversized token',
        { t: 'hello', token: 'x'.repeat(5000), clientVersion: '0.1.0', constantsHash: HEX64 },
      ],
    ],
  ],
  [
    'room_join',
    P.roomJoinMsg,
    { t: 'room_join', roomCode: 'K7QX2M' },
    [
      ['ambiguous chars', { t: 'room_join', roomCode: 'K7QX0O' }],
      ['too short', { t: 'room_join', roomCode: 'K7QX' }],
      ['oversized', { t: 'room_join', roomCode: 'K'.repeat(100) }],
    ],
  ],
  ['ready', P.readyMsg, { t: 'ready', artefactSha256: HEX64 }, [['missing', { t: 'ready' }]]],
  [
    'input_snapshot',
    P.inputSnapshotMsg,
    { t: 'input_snapshot', tick: 0, x: 150, y: 300, angle: 0, fired: 0 },
    [
      ['missing angle', { t: 'input_snapshot', tick: 0, x: 150, y: 300, fired: 0 }],
      ['float x', { t: 'input_snapshot', tick: 0, x: 150.5, y: 300, angle: 0, fired: 0 }],
      ['string y', { t: 'input_snapshot', tick: 0, x: 150, y: '300', angle: 0, fired: 0 }],
      ['negative tick', { t: 'input_snapshot', tick: -1, x: 150, y: 300, angle: 0, fired: 0 }],
      ['|x| ≥ 2^31', { t: 'input_snapshot', tick: 0, x: 2 ** 31, y: 300, angle: 0, fired: 0 }],
      ['boolean fired', { t: 'input_snapshot', tick: 0, x: 150, y: 300, angle: 0, fired: true }],
    ],
  ],
  [
    'window_proof',
    P.windowProofMsg,
    windowProof,
    [
      ['missing proof', { ...windowProof, proof: undefined }],
      ['3 public signals', { ...windowProof, publicSignals: [F, F, F] }],
      ['public signal = p', { ...windowProof, publicSignals: [P_STR, F, F, F] }],
      ['public signal negative', { ...windowProof, publicSignals: ['-1', F, F, F] }],
      ['public signal as number', { ...windowProof, publicSignals: [1, F, F, F] }],
      ['scheme/protocol mismatch', { ...windowProof, scheme: 'plonk' }],
      ['float roundNo', { ...windowProof, roundNo: 1.5 }],
      ['roundNo 0', { ...windowProof, roundNo: 0 }],
      ['roundNo > 5', { ...windowProof, roundNo: 6 }],
      ['missing matchId', { ...windowProof, matchId: undefined }],
      ['matchId not a uuid', { ...windowProof, matchId: 'abc' }],
      [
        'pi_a coord = q',
        { ...windowProof, proof: { ...groth16, pi_a: [BN254_Q.toString(), F, '1'] } },
      ],
      ['extra proof field', { ...windowProof, proof: { ...groth16, extra: 1 } }],
      ['wrong curve', { ...windowProof, proof: { ...groth16, curve: 'bls12381' } }],
    ],
  ],
  [
    'window_proof (plonk)',
    P.windowProofMsg,
    { ...windowProof, scheme: 'plonk', proof: plonk },
    [
      [
        'missing eval_zw',
        { ...windowProof, scheme: 'plonk', proof: { ...plonk, eval_zw: undefined } },
      ],
      ['eval ≥ p', { ...windowProof, scheme: 'plonk', proof: { ...plonk, eval_a: P_STR } }],
    ],
  ],
  [
    'proof_failed',
    P.proofFailedMsg,
    { t: 'proof_failed', matchId: UUID, roundNo: 2, windowIndex: 7, reason: 'Assert Failed' },
    [
      [
        'oversized reason',
        { t: 'proof_failed', matchId: UUID, roundNo: 2, windowIndex: 7, reason: 'x'.repeat(201) },
      ],
      ['missing windowIndex', { t: 'proof_failed', matchId: UUID, roundNo: 2, reason: '' }],
      ['missing matchId', { t: 'proof_failed', roundNo: 2, windowIndex: 7, reason: '' }],
    ],
  ],
  [
    'window_commit',
    P.windowCommitMsg,
    { t: 'window_commit', roundNo: 1, windowIndex: 0, commitOut: P_MINUS_1 },
    [
      ['commitOut = p', { t: 'window_commit', roundNo: 1, windowIndex: 0, commitOut: P_STR }],
      ['commitOut as number', { t: 'window_commit', roundNo: 1, windowIndex: 0, commitOut: 5 }],
      ['negative window', { t: 'window_commit', roundNo: 1, windowIndex: -1, commitOut: F }],
      ['missing commitOut', { t: 'window_commit', roundNo: 1, windowIndex: 0 }],
    ],
  ],
  [
    'cheat_toggle',
    P.cheatToggleMsg,
    { t: 'cheat_toggle', cheat: 'speedhack', enabled: true, tick: 10 },
    [
      ['unknown cheat', { t: 'cheat_toggle', cheat: 'wallhack', enabled: true, tick: 10 }],
      ['enabled as 1', { t: 'cheat_toggle', cheat: 'speedhack', enabled: 1, tick: 10 }],
    ],
  ],
  ['ping', P.pingMsg, { t: 'ping', ts: 1.5 }, [['string ts', { t: 'ping', ts: '1' }]]],
  [
    'match_found',
    P.matchFoundMsg,
    {
      t: 'match_found',
      matchId: UUID,
      matchField: P_MINUS_1,
      playerIndex: 0,
      opponentName: 'rahul_7',
      scheme: 'groth16',
      windowTicks: 60,
      enforcement: 'observe',
      spawns: [
        { x: 150, y: 300, angle: 0 },
        { x: 850, y: 300, angle: 1800 },
      ],
      initialCommit: F,
      prevSnapshot: [150, 300, 0, 0],
      variant: 'groth16_60',
    },
    [['playerIndex 2', { t: 'match_found', matchId: UUID, matchField: F, playerIndex: 2 }]],
  ],
  [
    'round_end',
    P.roundEndMsg,
    {
      t: 'round_end',
      roundNo: 1,
      endTick: 333,
      winnerIndex: 1,
      score: [0, 1],
      pauseTicks: 90,
      initialCommit: F,
      prevSnapshot: [150, 300, 0, 0],
    },
    [
      [
        'missing endTick',
        {
          t: 'round_end',
          roundNo: 1,
          winnerIndex: 1,
          score: [0, 1],
          pauseTicks: 90,
          initialCommit: F,
          prevSnapshot: [150, 300, 0, 0],
        },
      ],
      [
        'commit ≥ p',
        {
          t: 'round_end',
          roundNo: 1,
          endTick: 3,
          winnerIndex: 1,
          score: [0, 1],
          pauseTicks: 90,
          initialCommit: P_STR,
          prevSnapshot: [150, 300, 0, 0],
        },
      ],
    ],
  ],
  [
    'proof_result',
    P.proofResultMsg,
    {
      t: 'proof_result',
      matchId: UUID,
      playerIndex: 0,
      roundNo: 1,
      windowIndex: 0,
      status: 'committed',
      verifyMs: null,
      phase: 'live',
    },
    [
      [
        'unknown status',
        {
          t: 'proof_result',
          playerIndex: 0,
          roundNo: 1,
          windowIndex: 0,
          status: 'mismatch',
          verifyMs: null,
        },
      ],
    ],
  ],
  [
    'challenge',
    P.challengeMsg,
    { t: 'challenge', playerIndex: 1, roundNo: 2, windowIndex: 9, deadlineMs: 10000 },
    [
      [
        'negative deadline',
        { t: 'challenge', playerIndex: 1, roundNo: 2, windowIndex: 9, deadlineMs: -1 },
      ],
      ['missing playerIndex', { t: 'challenge', roundNo: 2, windowIndex: 9, deadlineMs: 1 }],
    ],
  ],
  [
    'audit_end',
    P.auditEndMsg,
    {
      t: 'audit_end',
      matchId: UUID,
      auditStatus: 'audited_clean',
      overturned: false,
      players: [
        { valid: 10, failed: 0, unaudited: 0, chainBroken: 0 },
        { valid: 9, failed: 0, unaudited: 0, chainBroken: 0 },
      ],
    },
    [
      [
        'unknown audit status',
        { t: 'audit_end', matchId: UUID, auditStatus: 'clean', overturned: false, players: [] },
      ],
    ],
  ],
  [
    'resume',
    P.resumeMsg,
    {
      t: 'resume',
      roundNo: 2,
      nextWindowIndex: 4,
      chainStatus: 'broken',
      committed: [0, 1, 2],
      challenge: { roundNo: 2, windowIndex: 1, deadlineMs: 4200 },
    },
    [
      [
        'bad chainStatus',
        {
          t: 'resume',
          roundNo: 2,
          nextWindowIndex: 4,
          chainStatus: 'ok',
          committed: [],
          challenge: null,
        },
      ],
      [
        'missing committed',
        { t: 'resume', roundNo: 2, nextWindowIndex: 4, chainStatus: 'intact', challenge: null },
      ],
    ],
  ],
  [
    'error',
    P.errorMsg,
    { t: 'error', code: 'VERSION_MISMATCH', message: 'refresh' },
    [['unknown code', { t: 'error', code: 'NOPE', message: '' }]],
  ],
  [
    'guest auth body',
    P.guestAuthBody,
    { displayName: 'shiva_01' },
    [
      ['too short', { displayName: 'ab' }],
      ['too long', { displayName: 'a'.repeat(17) }],
      ['bad chars', { displayName: '<script>' }],
    ],
  ],
  [
    'bench upload',
    P.benchUploadBody,
    {
      environment: 'browser',
      deviceLabel: 'Laptop i5 16GB',
      inputLog: 'rec.jsonl',
      seed: 42,
      results: [
        {
          scheme: 'groth16',
          windowTicks: 60,
          constraints: 51234,
          sampleNo: 1,
          witnessMs: 38.2,
          proveMs: 612.4,
          verifyMs: 6.1,
          proofBytes: 805,
          valid: true,
        },
      ],
    },
    [
      [
        'window size 45',
        {
          environment: 'node',
          deviceLabel: 'x',
          inputLog: 'x',
          seed: 1,
          results: [
            {
              scheme: 'groth16',
              windowTicks: 45,
              constraints: 1,
              sampleNo: 1,
              witnessMs: 1,
              proveMs: 1,
              verifyMs: 1,
              proofBytes: 1,
              valid: true,
            },
          ],
        },
      ],
      [
        'no results',
        { environment: 'node', deviceLabel: 'x', inputLog: 'x', seed: 1, results: [] },
      ],
    ],
  ],
];

describe('shared/protocol schemas', () => {
  for (const [name, schema, valid, invalids] of cases) {
    describe(name, () => {
      it('accepts a valid example', () => {
        const r = schema.safeParse(valid);
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      });
      for (const [desc, bad] of invalids) {
        it(`rejects: ${desc}`, () => {
          expect(schema.safeParse(bad).success).toBe(false);
        });
      }
    });
  }

  it('client message union dispatches on t and rejects unknown types', () => {
    expect(P.clientMessage.safeParse({ t: 'queue_join' }).success).toBe(true);
    expect(P.clientMessage.safeParse({ t: 'teleport' }).success).toBe(false);
    expect(P.clientMessage.safeParse(null).success).toBe(false);
  });

  it('queue_join carries no enforcement (server default only)', () => {
    const r = P.queueJoinMsg.parse({ t: 'queue_join', enforcement: 'strict' });
    expect(r).toEqual({ t: 'queue_join' });
  });

  it('strips hidden-state fields smuggled into a snapshot', () => {
    const r = P.inputSnapshotMsg.parse({
      t: 'input_snapshot',
      tick: 1,
      x: 150,
      y: 300,
      angle: 0,
      fired: 1,
      ammo: 9,
      cooldown: 11,
      reloadTimer: 0,
      salt: F,
    });
    expect(Object.keys(r).sort()).toEqual(['angle', 'fired', 't', 'tick', 'x', 'y']);
  });

  it('accepts integer but out-of-range snapshot values (they must reach the digest)', () => {
    const r = P.inputSnapshotMsg.safeParse({
      t: 'input_snapshot',
      tick: 5,
      x: -40,
      y: 9000,
      angle: 3600,
      fired: 2,
    });
    expect(r.success).toBe(true);
  });

  it('room codes are case-insensitive on entry', () => {
    expect(P.roomJoinMsg.parse({ t: 'room_join', roomCode: 'k7qx2m' }).roomCode).toBe('K7QX2M');
  });

  it('window_proof header can be parsed from an otherwise malformed body', () => {
    const r = P.windowProofHeader.safeParse({
      t: 'window_proof',
      matchId: UUID,
      roundNo: 1,
      windowIndex: 2,
      proof: 'garbage',
    });
    expect(r.success).toBe(true);
    expect(
      P.windowProofMsg.safeParse({
        t: 'window_proof',
        matchId: UUID,
        roundNo: 1,
        windowIndex: 2,
        proof: 'garbage',
      }).success,
    ).toBe(false);
  });
});

describe('shared/field', () => {
  it('scalar field bounds', () => {
    expect(isFieldElement('0')).toBe(true);
    expect(isFieldElement(P_MINUS_1)).toBe(true);
    expect(isFieldElement(P_STR)).toBe(false);
    expect(isFieldElement('1'.repeat(79))).toBe(false);
    expect(isFieldElement('')).toBe(false);
    expect(isFieldElement('0x10')).toBe(false);
    expect(isFieldElement(' 1')).toBe(false);
  });
  it('base field accepts [p, q) coordinates that the scalar field rejects', () => {
    expect(isBaseFieldElement(P_STR)).toBe(true);
    expect(isBaseFieldElement((BN254_Q - 1n).toString())).toBe(true);
    expect(isBaseFieldElement(BN254_Q.toString())).toBe(false);
  });
});
