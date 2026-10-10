/**
 * Phase 3 exit checks (integration, real sockets, real Groth16 proofs with the N=4 test circuit):
 *  - clean match: every window committed, every challenge valid, full audit → audited_clean;
 *  - scripted cheater (one window): caught live or by the audit → never audited_clean;
 *  - frame inspector: window_commit / window_proof carry only commitments, proofs, public signals.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAG_SIZE } from '@zkduel/shared/constants';
import { FAILURE_STATUSES } from '@zkduel/shared/protocol';
import type { PlayerState } from '@zkduel/shared/sim';
import { HIDDEN_KEYS } from '@zkduel/shared/ticklog';
import { verifyTiming } from '../../src/zk/verifierPool';
import type { BotClient } from '../support/botClient';
import { REPORT_DIR } from '../support/paths';
import {
  challengeResults,
  finalStatuses,
  playMatch,
  VARIANT,
  type PlayedMatch,
} from '../support/proofMatch';
import { startTestServer, type TestServer } from '../support/testServer';

const report: string[] = [];
const FAIL = new Set<string>(FAILURE_STATUSES);

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

const WIRE_KEYS = new Set([
  // Phase 1 frames
  't',
  'token',
  'clientVersion',
  'constantsHash',
  'artefactSha256',
  'tick',
  'x',
  'y',
  'angle',
  'fired',
  // Phase 3: window_commit / window_proof / proof_failed
  'roundNo',
  'windowIndex',
  'commitOut',
  'matchId',
  'scheme',
  'proof',
  'publicSignals',
  'proveMs',
  'pi_a',
  'pi_b',
  'pi_c',
  'protocol',
  'curve',
  'reason',
]);

function inspectFrames(bots: BotClient[]): {
  frames: number;
  commits: number;
  proofs: number;
  keys: string[];
} {
  const keys = new Set<string>();
  let commits = 0;
  let proofs = 0;
  for (const b of bots) {
    for (const raw of b.sentFrames) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      allKeys(m, keys);
      if (m.t === 'window_commit') {
        commits++;
        expect(Object.keys(m).sort()).toEqual(['commitOut', 'roundNo', 't', 'windowIndex']);
      }
      if (m.t === 'window_proof') {
        proofs++;
        expect(Object.keys(m).sort()).toEqual([
          'matchId',
          'proof',
          'proveMs',
          'publicSignals',
          'roundNo',
          'scheme',
          't',
          'windowIndex',
        ]);
      }
    }
  }
  for (const k of HIDDEN_KEYS) expect(keys.has(k), `hidden key "${k}" on the wire`).toBe(false);
  for (const k of keys) expect(WIRE_KEYS.has(k), `unexpected key "${k}" on the wire`).toBe(true);
  return {
    frames: bots.reduce((n, b) => n + b.sentFrames.length, 0),
    commits,
    proofs,
    keys: [...keys].sort(),
  };
}

function summarize(name: string, srv: TestServer, m: PlayedMatch): void {
  const db = srv.repo.getMatchSummary(m.matchId);
  for (const p of db?.players ?? []) {
    report.push(
      `${name} p${p.playerIndex}: windows ${p.windows}, committed ${p.windowsCommitted}, challenges ${p.challenges} (passed ${p.challengesPassed}), r = ${p.challengeRate?.toFixed(3)}, audit ${p.auditMs} ms, statuses ${JSON.stringify(p.proofs.byStatus)}, prove mean ${p.proofs.proveMsMean?.toFixed(0)} p95 ${p.proofs.proveMsP95} ms`,
    );
  }
  report.push(
    `${name}: match ${m.matchMs} ms (${m.matchEnd.reason} ${m.matchEnd.score.join('-')}), audit ${m.auditMs} ms → ${m.auditEnd.auditStatus}${m.auditEnd.overturned ? ' OVERTURNED' : ''}`,
  );
}

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer({ ACTIVE_VARIANT: VARIANT, LOG_SNAPSHOTS: 'false' });
  verifyTiming.reset();
}, 60_000);
afterAll(async () => {
  const v = verifyTiming.summary();
  report.push(
    `verify (VerifierPool worker_threads, ${VARIANT}): n=${v.n} mean=${v.mean.toFixed(2)} p50=${v.p50.toFixed(2)} p95=${v.p95.toFixed(2)} p99=${v.p99.toFixed(2)} max=${v.max.toFixed(2)} ms`,
  );
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    join(REPORT_DIR, 'phase3-proofs-int.txt'),
    `${new Date().toISOString()}\n${report.join('\n')}\n`,
  );
  console.log(report.join('\n'));
  await srv?.stop();
}, 60_000);

describe('Phase 3: commit / challenge / audit over real sockets', () => {
  it('clean match: all windows committed, every challenge valid, audit → audited_clean; no hidden state on the wire', async () => {
    const m = await playMatch(srv);
    expect(m.matchEnd.reason).toBe('rounds');
    expect(m.auditEnd.auditStatus).toBe('audited_clean');
    expect(m.auditEnd.overturned).toBe(false);
    for (const p of [0, 1] as const) {
      const results = challengeResults(m.bots[0], p);
      expect(results.length).toBeGreaterThan(0);
      expect(new Set(results)).toEqual(new Set(['valid']));
      const st = [...finalStatuses(m.bots[0], p).values()];
      expect(new Set(st)).toEqual(new Set(['valid']));
    }
    const db = srv.repo.getMatchSummary(m.matchId);
    expect(db?.auditStatus).toBe('audited_clean');
    for (const p of db?.players ?? []) {
      expect(p.windows).toBeGreaterThan(10);
      expect(p.windowsCommitted).toBe(p.windows);
      expect(p.proofs.byStatus).toEqual({ valid: p.windows });
      expect(p.challenges).toBeGreaterThan(0);
    }
    const f = inspectFrames(m.bots);
    report.push(
      `frame inspector: ${f.frames} frames (${f.commits} window_commit, ${f.proofs} window_proof); wire keys: ${f.keys.join(',')}`,
    );
    summarize('clean', srv, m);
    await Promise.all(m.bots.map((b) => b.close()));
  }, 600_000);

  for (const cheat of ['speed', 'ammo'] as const) {
    it(`scripted cheater (${cheat}, one window): caught by a challenge or the audit — never audited_clean`, async () => {
      let cheatAt: { roundNo: number; tick: number } | null = null;
      const tamper = (ctx: { roundNo: number; tick: number }, s: PlayerState): PlayerState => {
        if (cheatAt || ctx.roundNo !== 1 || ctx.tick < 30) return s;
        if (cheat === 'speed') {
          // one illegal step: +12 on top of the honest step (|Δx| ≥ 8 > MAX_SPEED), inside the arena
          const dx = s.pub.x < 500 ? 12 : -12;
          cheatAt = ctx;
          return { ...s, pub: { ...s.pub, x: s.pub.x + dx } };
        }
        if (s.hidden.ammo >= MAG_SIZE || s.hidden.reloadTimer !== 0) return s;
        cheatAt = ctx; // infinite-ammo style: magazine silently refilled
        return { ...s, hidden: { ...s.hidden, ammo: MAG_SIZE } };
      };
      const m = await playMatch(srv, { bots: [{ tamper }, {}] });
      expect(cheatAt).not.toBeNull();
      const at = cheatAt as unknown as { roundNo: number; tick: number };
      const cheater = m.bots[0].session.playerIndex;
      const k = Math.floor(at.tick / 4);
      const st = finalStatuses(m.bots[1], cheater);
      const status = st.get(`${at.roundNo}:${k}`);
      expect(FAIL.has(status ?? ''), `cheating window r${at.roundNo} w${k} status ${status}`).toBe(
        true,
      );
      // every other window of the cheater is fine
      const others = [...st.entries()]
        .filter(([w]) => w !== `${at.roundNo}:${k}`)
        .map(([, s]) => s);
      expect(new Set(others)).toEqual(new Set(['valid']));
      expect(m.auditEnd.auditStatus).toBe('audited_failed');
      expect(m.auditEnd.auditStatus).not.toBe('audited_clean');
      const live = m.bots[1].received.some(
        (x) =>
          x.t === 'challenge' &&
          x.playerIndex === cheater &&
          x.roundNo === at.roundNo &&
          x.windowIndex === k,
      );
      report.push(
        `cheater ${cheat}: cheat at round ${at.roundNo} tick ${at.tick} (window ${k}) → ${status}, caught ${live ? 'LIVE by a challenge' : 'by the AUDIT'}; overturned=${m.auditEnd.overturned} (winner ${m.matchEnd.winnerIndex}, cheater p${cheater})`,
      );
      summarize(`cheater-${cheat}`, srv, m);
      await Promise.all(m.bots.map((b) => b.close()));
    }, 600_000);
  }
});
