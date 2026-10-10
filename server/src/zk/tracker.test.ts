/** ProofTracker with a fake clock, verifier and store (API_SPEC §5). */
import { beforeAll, describe, expect, it } from 'vitest';
import { TICK_RATE, type PlayerIndex } from '@zkduel/shared/constants';
import { poseidonReady } from '@zkduel/shared/poseidon';
import type { ProofStatus, ServerMessage, WindowProofMessage } from '@zkduel/shared/protocol';
import { bindOf, type PublicSignalName } from '@zkduel/shared/zkInput';
import { ProofTracker, type AuditSummary, type WindowRow } from './tracker';

beforeAll(() => poseidonReady());

const N = 4;
const WINDOW_MS = (N * 1000) / TICK_RATE;
const ORDER: PublicSignalName[] = ['commitOut', 'bind', 'digest', 'commitIn'];
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
const MF = '4242';
const INIT = '77';
const DEADLINE = 1000;

function setup(
  o: {
    enforcement?: 'observe' | 'strict';
    verifyOk?: boolean;
    random?: (n: number) => number;
  } = {},
) {
  let now = 0;
  const rows = new Map<string, WindowRow>();
  const inbox: ServerMessage[] = [];
  const failures: [PlayerIndex, ProofStatus][] = [];
  let audit: AuditSummary | null = null;
  let finished: AuditSummary | null = null;
  const verifies: string[][] = [];
  const tr = new ProofTracker(
    {
      matchId: UUID,
      matchField: MF,
      initialCommit: INIT,
      scheme: 'groth16',
      windowTicks: N,
      enforcement: o.enforcement ?? 'observe',
      publicSignalOrder: ORDER,
      proofDeadlineMs: DEADLINE,
      auditTimeoutMs: 60_000,
      storeProofs: false,
    },
    {
      verifier: {
        verify: async (ps) => {
          verifies.push(ps);
          return { ok: o.verifyOk ?? true, ms: 3, timedOut: false, error: null };
        },
      },
      store: {
        upsertWindow: (r) => rows.set(`${r.playerIndex}:${r.roundNo}:${r.windowIndex}`, { ...r }),
        setAuditing: () => undefined,
        finishAudit: (s) => (finished = s),
      },
      now: () => now,
      epoch: () => 1_700_000_000_000 + now,
      send: (p, m) => p === 0 && inbox.push(m),
      onLiveFailure: (p, _r, _k, st) => failures.push([p, st]),
      onAuditClosed: (s) => (audit = s),
      random: o.random,
    },
  );
  const status = (p: PlayerIndex, r: number, k: number) => rows.get(`${p}:${r}:${k}`)?.status;
  /** End window k of round r for both players with final digests and commits c<p>_<r>_<k>. */
  const endWindow = (r: number, k: number, commit: [boolean, boolean] = [true, true]) => {
    tr.windowEnded(r, k);
    for (const p of [0, 1] as const) {
      tr.digestFinal(p, r, k, `d${p}_${r}_${k}`);
      if (commit[p]) tr.commit(p, r, k, `c${p}_${r}_${k}`);
    }
  };
  /** A proof message whose public signals are right for (p, r, k) unless overridden. */
  const proofFor = async (
    p: PlayerIndex,
    r: number,
    k: number,
    over: Partial<Record<PublicSignalName, string>> = {},
  ): Promise<WindowProofMessage> => {
    const v: Record<PublicSignalName, string> = {
      bind: await bindOf(MF, p, r, k),
      digest: `d${p}_${r}_${k}`,
      commitIn: k === 0 ? INIT : `c${p}_${r}_${k - 1}`,
      commitOut: `c${p}_${r}_${k}`,
      ...over,
    };
    return {
      t: 'window_proof',
      matchId: UUID,
      roundNo: r,
      windowIndex: k,
      scheme: 'groth16',
      proof: {
        pi_a: ['1', '2', '1'],
        pi_b: [
          ['1', '2'],
          ['3', '4'],
          ['1', '0'],
        ],
        pi_c: ['1', '2', '1'],
        protocol: 'groth16',
        curve: 'bn128',
      },
      publicSignals: ORDER.map((n) => v[n]),
      proveMs: 1234,
    };
  };
  const challenges = () =>
    inbox.filter((m): m is Extract<ServerMessage, { t: 'challenge' }> => m.t === 'challenge');
  return {
    tr,
    rows,
    inbox,
    failures,
    verifies,
    status,
    endWindow,
    proofFor,
    challenges,
    audit: () => audit,
    finished: () => finished,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ProofTracker', () => {
  it('commit → committed (broadcast); a second commit or a commit for a window that has not ended is dropped', () => {
    const t = setup();
    expect(t.tr.commit(0, 1, 0, 'x')).toBe(false); // not ended
    t.endWindow(1, 0);
    expect(t.status(0, 1, 0)).toBe('committed');
    expect(t.tr.commit(0, 1, 0, 'y')).toBe(false);
    expect(t.inbox.find((m) => m.t === 'proof_result')).toMatchObject({
      status: 'committed',
      phase: 'live',
      matchId: UUID,
    });
  });

  it('missing commit by the end of the next window → missing_commit, rest of the round chain_broken, next round fresh', () => {
    const t = setup();
    t.endWindow(1, 0);
    t.endWindow(1, 1, [false, true]);
    t.endWindow(1, 2);
    t.tr.tick(1);
    expect(t.status(0, 1, 1)).toBeUndefined(); // still within the deadline
    t.advance(WINDOW_MS);
    t.tr.tick(1);
    expect(t.status(0, 1, 1)).toBe('missing_commit');
    expect(t.status(0, 1, 2)).toBe('chain_broken');
    expect(t.status(1, 1, 2)).toBe('committed');
    t.endWindow(1, 3); // windows ending later in the round are broken on arrival
    expect(t.status(0, 1, 3)).toBe('chain_broken');
    t.endWindow(2, 0);
    expect(t.status(0, 2, 0)).toBe('committed');
  });

  it('challenges: one outstanding per player, only ended + digest-final + committed windows of the current round', async () => {
    const t = setup({ random: () => 0 });
    t.tr.windowEnded(1, 0);
    t.tr.commit(0, 1, 0, 'c0_1_0'); // committed but digest not final yet
    t.tr.tick(1);
    expect(t.challenges()).toHaveLength(0);
    t.tr.digestFinal(0, 1, 0, 'd0_1_0');
    t.tr.tick(1);
    expect(t.challenges()).toEqual([
      { t: 'challenge', playerIndex: 0, roundNo: 1, windowIndex: 0, deadlineMs: DEADLINE },
    ]);
    t.endWindow(1, 1);
    t.tr.tick(1);
    expect(t.challenges().filter((c) => c.playerIndex === 0)).toHaveLength(1); // still outstanding
    await t.tr.proof(0, await t.proofFor(0, 1, 0));
    expect(t.status(0, 1, 0)).toBe('valid');
    t.tr.tick(1);
    const next = t.challenges().filter((c) => c.playerIndex === 0);
    expect(next.map((c) => c.windowIndex)).toEqual([0, 1]);
    // an earlier round's committed windows are left to the audit
    t.endWindow(2, 0);
    await t.tr.proof(0, await t.proofFor(0, 1, 1));
    t.tr.tick(2);
    expect(
      t
        .challenges()
        .filter((c) => c.playerIndex === 0)
        .at(-1),
    ).toMatchObject({ roundNo: 2, windowIndex: 0 });
  });

  it('the challenge draw is uniform over the pool (crypto.randomInt, chi-square)', () => {
    const K = 8;
    const TRIALS = 4000;
    const hist = new Array<number>(K).fill(0);
    for (let i = 0; i < TRIALS; i++) {
      const t = setup();
      for (let k = 0; k < K; k++) t.endWindow(1, k);
      t.tr.tick(1);
      const c = t.challenges().find((m) => m.playerIndex === 0);
      const i = c?.windowIndex ?? 0;
      hist[i] = (hist[i] ?? 0) + 1;
    }
    const e = TRIALS / K;
    const chi2 = hist.reduce((s, o) => s + (o - e) ** 2 / e, 0);
    expect(chi2).toBeLessThan(24.3); // df = 7, p = 0.001
  });

  it('challenge deadline → timeout; a proof arriving later is dropped', async () => {
    const t = setup();
    t.endWindow(1, 0);
    t.tr.tick(1);
    t.advance(DEADLINE);
    t.tr.tick(1);
    expect(t.status(0, 1, 0)).toBe('timeout');
    await t.tr.proof(0, await t.proofFor(0, 1, 0));
    expect(t.status(0, 1, 0)).toBe('timeout');
    expect(t.verifies).toHaveLength(0);
  });

  it('during play a proof for a window that is not challenged is dropped', async () => {
    const t = setup({ random: () => 0 });
    t.endWindow(1, 0);
    t.endWindow(1, 1);
    t.tr.tick(1); // challenges window 0
    await t.tr.proof(0, await t.proofFor(0, 1, 1));
    expect(t.status(0, 1, 1)).toBe('committed');
  });

  it('pipeline: bind → digest → commitIn → commitOut → verify, against the CLAIMED commitments', async () => {
    const cases: [Partial<Record<PublicSignalName, string>>, ProofStatus, number][] = [
      [{ bind: '5' }, 'mismatch_bind', 0],
      [{ digest: 'other' }, 'mismatch_digest', 0],
      [{ commitIn: 'c0_1_0' }, 'mismatch_commit', 0], // window 0 must open initialCommit
      [{ commitIn: INIT }, 'mismatch_commit', 1], // window 1 must open claimed commitOut_0
      [{ commitOut: 'refilled' }, 'mismatch_commit', 1], // must end at the claimed commitOut_1
      [{}, 'valid', 1],
    ];
    for (const [over, want, k] of cases) {
      const t = setup({ random: (n) => n - 1 });
      t.endWindow(1, 0);
      if (k === 1) t.endWindow(1, 1);
      t.tr.tick(1);
      await t.tr.proof(0, await t.proofFor(0, 1, k, over));
      expect(t.status(0, 1, k), JSON.stringify(over)).toBe(want);
      expect(t.verifies).toHaveLength(want === 'valid' ? 1 : 0);
    }
    const bad = setup({ verifyOk: false });
    bad.endWindow(1, 0);
    bad.tr.tick(1);
    await bad.tr.proof(0, await bad.proofFor(0, 1, 0));
    expect(bad.status(0, 1, 0)).toBe('invalid');
    const wrongScheme = setup();
    wrongScheme.endWindow(1, 0);
    wrongScheme.tr.tick(1);
    await wrongScheme.tr.proof(0, { ...(await wrongScheme.proofFor(0, 1, 0)), scheme: 'plonk' });
    expect(wrongScheme.status(0, 1, 0)).toBe('malformed');
  });

  it('proof_failed → unprovable; strict mode reports the live failure; observe does not', () => {
    for (const enforcement of ['observe', 'strict'] as const) {
      const t = setup({ enforcement });
      t.endWindow(1, 0);
      t.tr.tick(1);
      t.tr.proofFailed(0, {
        t: 'proof_failed',
        matchId: UUID,
        roundNo: 1,
        windowIndex: 0,
        reason: 'Assert Failed',
      });
      expect(t.status(0, 1, 0)).toBe('unprovable');
      expect(t.rows.get('0:1:0')?.failReason).toBe('Assert Failed');
      expect(t.failures).toEqual(enforcement === 'strict' ? [[0, 'unprovable']] : []);
    }
  });

  it('a failed window does not break the claimed chain; later windows still verify', async () => {
    const t = setup({ random: () => 0 });
    t.endWindow(1, 0);
    t.endWindow(1, 1);
    t.tr.tick(1); // window 0
    t.tr.proofFailed(0, {
      t: 'proof_failed',
      matchId: UUID,
      roundNo: 1,
      windowIndex: 0,
      reason: '',
    });
    t.tr.tick(1); // window 1
    await t.tr.proof(0, await t.proofFor(0, 1, 1));
    expect([t.status(0, 1, 0), t.status(0, 1, 1)]).toEqual(['unprovable', 'valid']);
  });

  it('disconnect: windows from the first missing tick on are chain_broken; resume info lists commits + challenge', () => {
    const t = setup({ random: () => 0 });
    t.endWindow(1, 0);
    t.tr.tick(1); // challenge window 0
    t.tr.disconnect(0, 1, 6); // first missing tick 6 → window 1 on
    t.endWindow(1, 1);
    expect(t.status(0, 1, 1)).toBe('chain_broken');
    expect(t.status(1, 1, 1)).toBe('committed');
    t.advance(300);
    const info = t.tr.resumeInfo(0, 1);
    expect(info).toEqual({
      committed: [0],
      broken: true,
      challenge: { roundNo: 1, windowIndex: 0, deadlineMs: DEADLINE - 300 },
    });
  });

  it('audit: proofs for any committed window; closes when nothing is left → audited_clean', async () => {
    const t = setup({ random: () => 0 });
    for (let k = 0; k < 3; k++) t.endWindow(1, k);
    t.tr.tick(1); // both players: window 0 challenged
    await t.tr.proof(0, await t.proofFor(0, 1, 0));
    t.tr.startAudit(0);
    t.advance(500);
    for (const p of [0, 1] as const) {
      for (let k = p === 0 ? 1 : 0; k < 3; k++) await t.tr.proof(p, await t.proofFor(p, 1, k));
    }
    t.tr.tick(null);
    expect(t.audit()).toMatchObject({ auditStatus: 'audited_clean', overturned: false });
    const a = t.audit() as AuditSummary;
    expect(a.players[0]).toMatchObject({
      windows: 3,
      windowsCommitted: 3,
      challenges: 1,
      challengesPassed: 1,
      challengeRate: 1 / 3,
      auditMs: 500,
    });
    expect(t.rows.get('0:1:2')?.decidedPhase).toBe('audit');
    expect(t.rows.get('0:1:0')).toMatchObject({ decidedPhase: 'live', challenged: true });
    expect(t.finished()).toBe(a);
    expect(t.inbox.at(-1)).toMatchObject({ t: 'audit_end', auditStatus: 'audited_clean' });
  });

  it('audit timeout → remaining windows unaudited → audit_incomplete; a winner failure → audited_failed + overturned', async () => {
    const t = setup();
    t.endWindow(1, 0);
    t.tr.startAudit(1);
    await t.tr.proof(1, await t.proofFor(1, 1, 0));
    t.advance(60_000);
    t.tr.tick(null);
    expect(t.status(0, 1, 0)).toBe('unaudited');
    expect(t.audit()).toMatchObject({ auditStatus: 'audit_incomplete', overturned: false });

    for (const [winner, overturned] of [
      [0, true],
      [1, false],
    ] as const) {
      const f = setup();
      f.endWindow(1, 0);
      f.tr.startAudit(winner);
      f.tr.proofFailed(0, {
        t: 'proof_failed',
        matchId: UUID,
        roundNo: 1,
        windowIndex: 0,
        reason: '',
      });
      await f.tr.proof(1, await f.proofFor(1, 1, 0));
      f.tr.tick(null);
      expect(f.audit()).toMatchObject({ auditStatus: 'audited_failed', overturned });
      // per player: p0's failure is recorded even when p0 lost (winner 1); p1 is clean
      expect(f.audit()?.players.map((x) => x.auditStatus)).toEqual([
        'audited_failed',
        'audited_clean',
      ]);
      expect(f.failures).toEqual([]); // audit failures never trigger strict-mode forfeits
    }
  });

  it('an outstanding challenge at match_end keeps its deadline into the audit', async () => {
    const t = setup();
    t.endWindow(1, 0);
    t.tr.tick(1);
    t.tr.startAudit(0);
    t.advance(DEADLINE);
    t.tr.tick(null);
    expect(t.status(0, 1, 0)).toBe('timeout');
  });
});
