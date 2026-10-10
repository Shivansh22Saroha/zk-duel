/**
 * Phase 3 protocol scenarios (TESTING §4) over real sockets with real proofs (N=4 circuit):
 * each mismatch type, invalid, malformed, timeout; missing_commit → chain_broken; strict-mode
 * forfeit; reconnect with resume.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage, WindowProofMessage } from '@zkduel/shared/protocol';
import type { PublicSignalName } from '@zkduel/shared/zkInput';
import type { BotClient } from '../support/botClient';
import { REPORT_DIR } from '../support/paths';
import { finalStatuses, playMatch, VARIANT } from '../support/proofMatch';
import { startTestServer, type TestServer } from '../support/testServer';

const report: string[] = [];
let order: PublicSignalName[] = [];

const challengesOf = (b: BotClient, p: number) =>
  b.received.filter(
    (m): m is Extract<ServerMessage, { t: 'challenge' }> =>
      m.t === 'challenge' && m.playerIndex === p,
  );
const waitUntil = async (cond: () => boolean, timeoutMs: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer({
    ACTIVE_VARIANT: VARIANT,
    LOG_SNAPSHOTS: 'false',
    PROOF_DEADLINE_MS: '4000',
    AUDIT_TIMEOUT_MIN: '1',
  });
  const info = (await (await fetch(`${srv.baseUrl}/api/circuit/info`)).json()) as {
    variants: { id: string; publicSignalOrder: PublicSignalName[] }[];
  };
  order = info.variants.find((v) => v.id === VARIANT)?.publicSignalOrder ?? [];
  expect(order).toHaveLength(4);
}, 60_000);
afterAll(async () => {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    join(REPORT_DIR, 'phase3-protocol-int.txt'),
    `${new Date().toISOString()}\n${report.join('\n')}\n`,
  );
  console.log(report.join('\n'));
  await srv?.stop();
}, 60_000);

const withSignal = (
  m: WindowProofMessage,
  name: PublicSignalName,
  v: string,
): WindowProofMessage => {
  const ps = [...m.publicSignals];
  ps[order.indexOf(name)] = v;
  return { ...m, publicSignals: ps };
};

describe('Phase 3 protocol scenarios', () => {
  it('mutated challenge answers → mismatch_bind / _digest / _commit (in, out) / invalid / malformed / timeout; audit → audited_failed, overturned', async () => {
    const plan: ((m: WindowProofMessage) => WindowProofMessage | null)[] = [
      (m) => withSignal(m, 'bind', '12345'),
      (m) => withSignal(m, 'digest', '12345'),
      (m) => withSignal(m, 'commitIn', '12345'),
      (m) => withSignal(m, 'commitOut', '12345'),
      (m) => ({
        ...m,
        proof: { ...m.proof, pi_a: ['1', '2', '1'] } as WindowProofMessage['proof'],
      }),
      (m) => ({ ...m, proof: { pi_a: 'garbage' } as unknown as WindowProofMessage['proof'] }),
      () => null, // never answered → timeout
    ];
    const want = [
      'mismatch_bind',
      'mismatch_digest',
      'mismatch_commit',
      'mismatch_commit',
      'invalid',
      'malformed',
      'timeout',
    ];
    const m = await playMatch(srv, {
      hooks: [{ mutateProof: (msg, n) => (plan[n] ? plan[n](msg) : msg) }],
      bots: [{ accuracy: 400 }, { accuracy: 400 }], // long rounds: ≥ 8 challenges before the end
      during: async ([a, b]) => {
        // once the 8th challenge of player 0 is decided, the opponent forfeits → audit
        await waitUntil(() => {
          const st = finalStatuses(b, 0);
          const ch = challengesOf(b, 0).slice(0, 8);
          return (
            ch.length === 8 &&
            ch.every(
              (c) => (st.get(`${c.roundNo}:${c.windowIndex}`) ?? 'committed') !== 'committed',
            )
          );
        }, 240_000);
        b.send({ t: 'forfeit' });
        void a;
      },
    });
    const st = finalStatuses(m.bots[1], 0);
    const got = challengesOf(m.bots[1], 0)
      .slice(0, 8)
      .map((c) => st.get(`${c.roundNo}:${c.windowIndex}`));
    expect(got).toEqual([...want, 'valid']);
    expect(m.matchEnd).toMatchObject({ reason: 'forfeit', winnerIndex: 0 });
    expect(m.auditEnd).toMatchObject({ auditStatus: 'audited_failed', overturned: true });
    // the malformed body cost one strike; the socket survived
    expect(m.bots[0].received.filter((x) => x.t === 'error').length).toBe(1);
    report.push(
      `mutations: challenge results ${JSON.stringify(got)}; audit ${m.auditEnd.auditStatus} overturned=${m.auditEnd.overturned}`,
    );
    await Promise.all(m.bots.map((b) => b.close()));
  }, 600_000);

  it('missing commit → missing_commit; rest of that round chain_broken; next round fresh', async () => {
    const m = await playMatch(srv, {
      hooks: [{ skipCommit: (r, k) => r === 1 && k === 5 }],
    });
    const st = finalStatuses(m.bots[1], 0);
    expect(st.get('1:5')).toBe('missing_commit');
    const r1later = [...st.entries()].filter(
      ([k]) => k.startsWith('1:') && Number(k.split(':')[1]) > 5,
    );
    expect(r1later.length).toBeGreaterThan(0);
    expect(new Set(r1later.map(([, s]) => s))).toEqual(new Set(['chain_broken']));
    const r2 = [...st.entries()].filter(([k]) => k.startsWith('2:')).map(([, s]) => s);
    expect(r2.length).toBeGreaterThan(0);
    expect(new Set(r2)).toEqual(new Set(['valid']));
    expect(m.auditEnd.auditStatus).toBe('audited_failed');
    report.push(
      `missing commit: r1w5 ${st.get('1:5')}, ${r1later.length} later r1 windows chain_broken, ${r2.length} r2 windows valid; audit ${m.auditEnd.auditStatus}`,
    );
    await Promise.all(m.bots.map((b) => b.close()));
  }, 600_000);

  it('reconnect within 10 s: resume (chain broken, held commits, challenge); windows from the gap on chain_broken; next round valid; never audited_clean', async () => {
    let resume: Extract<ServerMessage, { t: 'resume' }> | null = null;
    let dropTick = 0;
    let dropRound = 0;
    const m = await playMatch(srv, {
      bots: [{ accuracy: 200 }, { accuracy: 200 }],
      during: async ([a, b]) => {
        // drop in the first round that lasts past tick 20 — always reachable: a round cannot end
        // before tick 36 (four hits need three FIRE_COOLDOWN gaps)
        await waitUntil(() => a.session.phase === 'live' && a.session.tick > 20, 120_000);
        dropRound = a.session.roundNo;
        dropTick = a.session.tick;
        a.dropSocket();
        await new Promise((r) => setTimeout(r, 800));
        const n = a.received.length;
        await a.reconnect();
        resume = (await a.waitFor(
          (x) => x.t === 'resume' && a.received.indexOf(x) >= n,
          5000,
        )) as typeof resume;
        // let the next round run a little (fresh chain), then end the match → audit
        await waitUntil(
          () =>
            a.session.phase === 'ended' ||
            (a.session.roundNo === dropRound + 1 &&
              a.session.phase === 'live' &&
              a.session.tick > 30),
          240_000,
        );
        if (a.session.phase !== 'ended') b.send({ t: 'forfeit' });
      },
    });
    const r = resume as unknown as Extract<ServerMessage, { t: 'resume' }>;
    expect(r).toMatchObject({ roundNo: dropRound, chainStatus: 'broken' });
    const st = finalStatuses(m.bots[1], 0);
    const inRound = (rn: number) =>
      [...st.entries()]
        .filter(([k]) => k.startsWith(`${rn}:`))
        .map(([k, v]) => [Number(k.split(':')[1]), v] as const)
        .sort((x, y) => x[0] - y[0]);
    const rd = inRound(dropRound);
    const fb = rd.find(([, v]) => v === 'chain_broken')?.[0];
    expect(fb).toBeDefined();
    // the gap starts in window fb: every window from it on is chain_broken, every window well
    // before it (it ended before the drop) verified
    expect(rd.filter(([k]) => k >= (fb as number)).every(([, v]) => v === 'chain_broken')).toBe(
      true,
    );
    expect(rd.filter(([k]) => k < (fb as number) - 1).every(([, v]) => v === 'valid')).toBe(true);
    expect(Math.floor(dropTick / 4)).toBeGreaterThanOrEqual((fb as number) - 1);
    const next = inRound(dropRound + 1).map(([, v]) => v);
    if (next.length) expect(new Set(next)).toEqual(new Set(['valid']));
    expect(m.auditEnd.auditStatus).not.toBe('audited_clean');
    report.push(
      `reconnect: dropped in round ${dropRound} at client tick ${dropTick} (window ${Math.floor(dropTick / 4)}), resume ${JSON.stringify({ ...r, committed: `${r.committed.length} windows` })}; first chain_broken w${fb} (window before: ${rd.find(([k]) => k === (fb as number) - 1)?.[1]}); next round ${next.length} windows valid; audit ${m.auditEnd.auditStatus}`,
    );
    await Promise.all(m.bots.map((b) => b.close()));
  }, 600_000);
});

describe('strict mode', () => {
  let strict: TestServer;
  beforeAll(async () => {
    strict = await startTestServer({
      ACTIVE_VARIANT: VARIANT,
      LOG_SNAPSHOTS: 'false',
      DEFAULT_ENFORCEMENT: 'strict',
    });
  }, 60_000);
  afterAll(() => strict?.stop(), 60_000);

  it('a failed challenge ends the match (forfeit_proof) in the same tick as the result', async () => {
    const m = await playMatch(strict, {
      hooks: [{ mutateProof: (msg, n) => (n === 0 ? withSignal(msg, 'bind', '7') : msg) }],
    });
    expect(m.matchEnd).toMatchObject({ reason: 'forfeit_proof', winnerIndex: 1 });
    const rx = m.bots[1].received;
    const i = rx.findIndex((x) => x.t === 'proof_result' && x.status === 'mismatch_bind');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(rx[i + 1]?.t).toBe('match_end'); // nothing in between: same synchronous step
    expect(m.auditEnd.auditStatus).toBe('audited_failed');
    report.push(
      `strict: mismatch_bind → ${m.matchEnd.reason} winner p${m.matchEnd.winnerIndex}; audit ${m.auditEnd.auditStatus} overturned=${m.auditEnd.overturned}`,
    );
    await Promise.all(m.bots.map((b) => b.close()));
  }, 600_000);
});
