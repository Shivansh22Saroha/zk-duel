/**
 * Integration-test harness for Phase 3: two proving bots play one match through the real
 * server (groth16_4 test variant), then audit. Collects what the tests and the report need.
 */
import { join } from 'node:path';
import type { ServerMessage } from '@zkduel/shared/protocol';
import type { ProofClientHooks } from '../../../client/src/zk/proofClient';
import { CIRCUITS_BUILD } from './paths';
import { BotClient, type BotOptions } from './botClient';
import { TEST_ORIGIN, type TestServer } from './testServer';

export const VARIANT = 'groth16_4';
export const VARIANT_DIR = join(CIRCUITS_BUILD, VARIANT);

type AuditEnd = Extract<ServerMessage, { t: 'audit_end' }>;
type MatchEnd = Extract<ServerMessage, { t: 'match_end' }>;

let nameSeq = 0;

export interface PlayOptions {
  /** Per-bot overrides (index = queue order; the first bot usually becomes player 0). */
  bots?: [Partial<BotOptions>, Partial<BotOptions>];
  /** ProofClient test hooks per bot. */
  hooks?: [ProofClientHooks?, ProofClientHooks?];
  /** Called with both bots once the match started (e.g. to drop a socket mid-round). */
  during?: (bots: [BotClient, BotClient]) => Promise<void> | void;
  timeoutMs?: number;
}

export interface PlayedMatch {
  bots: [BotClient, BotClient];
  matchId: string;
  matchEnd: MatchEnd;
  auditEnd: AuditEnd;
  matchMs: number;
  auditMs: number;
}

export async function playMatch(srv: TestServer, o: PlayOptions = {}): Promise<PlayedMatch> {
  const bots: BotClient[] = [];
  for (let i = 0; i < 2; i++) {
    const name = `pf_${process.pid % 1000}_${nameSeq++}`.slice(0, 16);
    bots.push(
      await BotClient.connect({
        baseUrl: srv.baseUrl,
        wsUrl: srv.wsUrl,
        origin: TEST_ORIGIN,
        name,
        token: srv.auth.issueGuest(name).token,
        seed: 500 + nameSeq,
        accuracy: 60,
        ...o.bots?.[i],
        prove: { variantDir: VARIANT_DIR, threads: 4, hooks: o.hooks?.[i] },
      }),
    );
  }
  const pair = bots as [BotClient, BotClient];
  for (const b of pair) b.startLoop();
  pair[0].send({ t: 'queue_join' });
  await pair[0].waitFor((m) => m.t === 'queued', 5000);
  pair[1].send({ t: 'queue_join' });
  const timeout = o.timeoutMs ?? 300_000;
  await Promise.all(pair.map((b) => b.waitFor((m) => m.t === 'start', 30_000)));
  const t0 = Date.now();
  await Promise.resolve(o.during?.(pair)).catch((e: unknown) => {
    console.error(
      'during() failed:',
      JSON.stringify(
        pair.map((b) => ({
          phase: b.session.phase,
          round: b.session.roundNo,
          tick: b.session.tick,
          closed: b.closeCode,
        })),
      ),
    );
    void Promise.all(pair.map((b) => b.close()));
    throw e;
  });
  const dump = (e: unknown): never => {
    const id = pair[0].session.match?.matchId ?? '';
    console.error(
      'playMatch stuck:',
      JSON.stringify({
        phase: pair.map((b) => b.session.phase),
        client: pair.map((b) => b.proof?.debugState()),
        server: srv.manager.rooms.get(id)?.tracker.debugState() ?? 'room gone',
      }),
    );
    // never leave bots (and their provers) running after a failure: they would load the CPU
    // for every later test
    void Promise.all(pair.map((b) => b.close()));
    throw e;
  };
  const matchEnd = (await pair[0]
    .waitFor((m) => m.t === 'match_end', timeout)
    .catch(dump)) as MatchEnd;
  const t1 = Date.now();
  const auditEnd = (await pair[0]
    .waitFor((m) => m.t === 'audit_end', timeout)
    .catch(dump)) as AuditEnd;
  await pair[1].waitFor((m) => m.t === 'audit_end', 10_000);
  const t2 = Date.now();
  for (const b of pair) b.stopLoop();
  return {
    bots: pair,
    matchId: pair[0].session.match?.matchId as string,
    matchEnd,
    auditEnd,
    matchMs: t1 - t0,
    auditMs: t2 - t1,
  };
}

/** Every proof_result a bot saw, latest status per window. */
export function finalStatuses(b: BotClient, p: 0 | 1): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of b.received) {
    if (m.t === 'proof_result' && m.playerIndex === p)
      out.set(`${m.roundNo}:${m.windowIndex}`, m.status);
  }
  return out;
}

/** Statuses of the windows that were challenged during play, for player p. */
export function challengeResults(b: BotClient, p: 0 | 1): string[] {
  const challenged = new Set(
    b.received
      .filter(
        (m): m is Extract<ServerMessage, { t: 'challenge' }> =>
          m.t === 'challenge' && m.playerIndex === p,
      )
      .map((m) => `${m.roundNo}:${m.windowIndex}`),
  );
  const st = finalStatuses(b, p);
  return [...challenged].map((k) => st.get(k) ?? 'missing');
}
