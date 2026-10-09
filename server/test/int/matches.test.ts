/**
 * Phase 1 exit check (automated part): ≥ 10 full best-of-5 matches between scripted bots over
 * real sockets, run concurrently. Verifies no desync, consistent results, circuit-legal client
 * logs, server logs = what clients sent, and that no hidden state is ever on the wire.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_ROOT } from '../../src/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_TO_WIN, type PlayerIndex } from '@zkduel/shared/constants';
import { checkSequence, spawnState, type TickRecord } from '@zkduel/shared/sim';
import { HIDDEN_KEYS, type TickLogLine } from '@zkduel/shared/ticklog';
import { tickTiming } from '../../src/match/stats';
import { BotClient } from '../support/botClient';
import { startTestServer, TEST_ORIGIN, type TestServer } from '../support/testServer';

const MATCHES = 10;
/** Reports land in server/data/test-reports (gitignored). */
const REPORT_DIR = join(SERVER_ROOT, 'data', 'test-reports');

/** Every object key anywhere in a JSON value. */
function allKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

let srv: TestServer;
const bots: BotClient[] = [];

beforeAll(async () => {
  srv = await startTestServer();
  tickTiming.reset();
});

afterAll(async () => {
  await Promise.all(bots.map((b) => b.close()));
  await srv.stop();
});

describe(`${MATCHES} concurrent bot matches (best of 5)`, () => {
  it('all finish by rounds with consistent results, no desync, legal logs, no hidden state on the wire', async () => {
    for (let i = 0; i < MATCHES * 2; i++) {
      bots.push(
        await BotClient.connect({
          baseUrl: srv.baseUrl,
          wsUrl: srv.wsUrl,
          origin: TEST_ORIGIN,
          name: `bot_${i}`,
          token: srv.auth.issueGuest(`bot_${i}`).token,
          seed: 1000 + i,
          logDir: join(srv.logDir, 'clients'),
        }),
      );
    }
    for (const b of bots) {
      b.startLoop();
      b.send({ t: 'queue_join' });
    }
    await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'match_end', 240_000)));
    await Promise.all(bots.map((b) => b.log.close()));

    // ---- group bots by match
    const byMatch = new Map<string, BotClient[]>();
    for (const b of bots) {
      const id = b.session.match?.matchId as string;
      byMatch.set(id, [...(byMatch.get(id) ?? []), b]);
    }
    expect(byMatch.size).toBe(MATCHES);

    const timing = tickTiming.summary();
    const report: string[] = [];
    let totalHeld = 0;
    let totalFilled = 0;

    for (const [matchId, pair] of byMatch) {
      expect(pair).toHaveLength(2);
      const [a, b] = pair as [BotClient, BotClient];
      const ra = a.session.result;
      const rb = b.session.result;
      // results agree between clients and the DB
      expect(ra?.reason).toBe('rounds');
      expect(rb).toEqual(ra);
      expect(Math.max(...(ra?.score ?? [0]))).toBe(ROUNDS_TO_WIN);
      const db = srv.repo.getMatchSummary(matchId);
      expect(db?.status).toBe('finished');
      expect(db?.endReason).toBe('rounds');
      expect(db?.winnerIndex).toBe(ra?.winnerIndex);
      expect(db?.players.map((p) => p.roundsWon)).toEqual(ra?.score);
      expect(db?.rounds.every((r) => r.endTick !== null)).toBe(true);

      // no desync: server echoed exactly what each client sent
      for (const bot of pair) {
        expect(bot.session.desyncTicks).toBe(0);
        expect(bot.session.checkedTicks).toBeGreaterThan(100);
      }

      // client logs: every round's records up to endTick satisfy the rules (circuit-legal)
      const serverLines = readFileSync(join(srv.logDir, 'server', `${matchId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TickLogLine);
      for (const bot of pair) {
        const p = bot.session.playerIndex as PlayerIndex;
        const lines = bot.log.lines;
        const ends = lines.filter(
          (l): l is Extract<TickLogLine, { type: 'round_end' }> => l.type === 'round_end',
        );
        expect(ends.length).toBe((ra?.score[0] ?? 0) + (ra?.score[1] ?? 0));
        for (const e of ends) {
          const recs = lines.filter(
            (l): l is Extract<TickLogLine, { type: 'tick' }> & TickRecord =>
              l.type === 'tick' && l.roundNo === e.roundNo && l.tick <= e.endTick,
          );
          expect(recs.map((r) => r.tick)).toEqual(
            Array.from({ length: e.endTick + 1 }, (_, i) => i),
          );
          expect(checkSequence(spawnState(p), recs)).toBeNull();
          // server log has exactly the client's public values for this player: received
          // snapshots for sent ticks, held fills for ticks the client gap-filled locally
          const received = new Map<number, Extract<TickLogLine, { type: 'tick' }>>();
          const held = new Map<number, Extract<TickLogLine, { type: 'tick' }>>();
          for (const l of serverLines) {
            if (
              l.type === 'tick' &&
              l.roundNo === e.roundNo &&
              'playerIndex' in l &&
              l.playerIndex === p
            ) {
              ('held' in l ? held : received).set(l.tick, l);
            }
          }
          totalHeld += held.size;
          for (const r of recs) {
            const filled = 'filled' in r && r.filled === true;
            if (filled) totalFilled++;
            const s = filled ? held.get(r.tick) : received.get(r.tick);
            expect(
              s,
              `p${p} round ${e.roundNo} tick ${r.tick} (${filled ? 'filled' : 'sent'}) missing on server`,
            ).toBeDefined();
            expect([s?.x, s?.y, s?.angle, s?.fired]).toEqual([r.x, r.y, r.angle, r.fired]);
          }
        }
      }
      // server logs never contain hidden state
      for (const k of HIDDEN_KEYS) expect(allKeys(serverLines).has(k)).toBe(false);
      report.push(
        `${matchId.slice(0, 8)} score ${ra?.score.join('-')} rounds ${db?.rounds.length} ticks ${db?.totalTicks} shots ${db?.players.map((p) => p.shots).join('/')} hits ${db?.players.map((p) => p.hits).join('/')}`,
      );
    }

    // ---- frame inspector: every client→server frame (as received by the server)
    expect(srv.frames.length).toBeGreaterThan(MATCHES * 2 * 3 * 60); // ≥ 3 rounds × ≥ 1 s each
    const keys = new Set<string>();
    for (const f of srv.frames) allKeys(JSON.parse(f.raw), keys);
    for (const k of HIDDEN_KEYS) expect(keys.has(k), `hidden key "${k}" on the wire`).toBe(false);
    // and the client side agrees (bots recorded every frame they sent)
    const sent = bots.reduce((n, b) => n + b.sentFrames.length, 0);
    expect(sent).toBe(srv.frames.length);

    const text = [
      `matches: ${MATCHES}, frames inspected: ${srv.frames.length}, wire keys: ${[...keys].sort().join(',')}`,
      `server held ticks: ${totalHeld} (client locally gap-filled: ${totalFilled}; all held values matched the client)`,
      `server tick processing (ms, ${MATCHES} concurrent matches): n=${timing.n} mean=${timing.mean.toFixed(4)} p50=${timing.p50.toFixed(4)} p95=${timing.p95.toFixed(4)} p99=${timing.p99.toFixed(4)} max=${timing.max.toFixed(3)}`,
      ...report,
    ].join('\n');
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, 'phase1-bot-matches.txt'),
      `${new Date().toISOString()}\n${text}\n`,
    );
    console.log(text);
    expect(timing.p99).toBeLessThan(2);
  }, 300_000);
});
