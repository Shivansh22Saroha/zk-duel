/**
 * Phase 4 detection experiment — live browser demo runs (two real Chrome windows, production
 * `--mode perf` build, groth16_60, both players on one laptop). One run per cheat: the cheat goes on
 * at window 3 for m windows (5; smooth-aim 20), play continues 10 windows, the opponent forfeits,
 * both audit. Rows go to detection_runs with environment = 'browser' (same analysis as the Node
 * runner: ground truth from the cheater's own tick log).
 *
 *   npm run perf:serve        (other terminal)
 *   npm run exp:browser
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { chromium, type Page } from '@playwright/test';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { openDb } from '../../server/src/db/index';
import { analyzeRun, exportCsv, insertRun, matrix } from '../../server/scripts/detection';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PATH = join(ROOT, 'server', 'data', 'zkduel.db');
const LOG = join(ROOT, 'server', 'data', 'test-reports', 'phase4-detection.txt');
const N = 60;
const RUNS: [string, number][] = [
  ['speedhack', 5],
  ['rapid_fire', 5],
  ['infinite_ammo', 5],
  ['snap_aim', 5],
  ['smooth_aim', 20],
];

type Zkd = {
  game(): {
    phase: string;
    tick: number;
    roundNo: number;
    playerIndex: number;
    match: { matchId: string } | null;
  } | null;
  proof(): { auditDone: boolean } | null;
  cheat(c: string, on: boolean): void;
  tickLog(): TickLogLine[] | null;
};
const zk = (p: Page) =>
  p.evaluate(() => {
    const g = (window as unknown as { __zkd: Zkd }).__zkd.game();
    return g ? { phase: g.phase, tick: g.tick, roundNo: g.roundNo } : null;
  });

async function main(): Promise<void> {
  mkdirSync(dirname(LOG), { recursive: true });
  const db = openDb(DB_PATH);
  const label = `${cpus()[0]?.model.trim()} (${cpus().length} threads), Chrome (2 windows, one laptop), AC`;
  appendFileSync(LOG, `\n=== ${new Date().toISOString()} browser demo runs: ${label}\n`);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1100,800',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  for (const [i, [cheat, m]] of RUNS.entries()) {
    const playS = 3 + Math.ceil(((3 + m + 10) * N) / 60);
    const pages: Page[] = [];
    for (const [j, seed] of [500 + i * 2, 501 + i * 2].entries()) {
      const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => console.error(`[page ${j}] ${e.message}`));
      await p.goto(`${BASE}?bot=${seed}&acc=1800&miss=300${j === 1 ? `&stopAfter=${playS}` : ''}`);
      pages.push(p);
    }
    const a = pages[0] as Page;
    await Promise.all(
      pages.map((p) =>
        p.waitForFunction(
          () => (window as unknown as { __zkd?: Zkd }).__zkd?.game()?.phase === 'live',
          undefined,
          { timeout: 120_000 },
        ),
      ),
    );
    // on at window 3, off after m windows (or at the round's end)
    let on = false;
    for (;;) {
      const g = await zk(a);
      if (!g || g.phase === 'ended') break;
      if (!on && g.roundNo === 1 && g.tick >= 3 * N) {
        await a.evaluate((c) => (window as unknown as { __zkd: Zkd }).__zkd.cheat(c, true), cheat);
        on = true;
      }
      if (on && (g.roundNo > 1 || g.tick >= (3 + m) * N)) {
        await a.evaluate((c) => (window as unknown as { __zkd: Zkd }).__zkd.cheat(c, false), cheat);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await Promise.all(
      pages.map((p) =>
        p.waitForFunction(
          () => (window as unknown as { __zkd?: Zkd }).__zkd?.game()?.phase === 'ended',
          undefined,
          { timeout: 300_000 },
        ),
      ),
    );
    const info = await a.evaluate(() => {
      const z = (window as unknown as { __zkd: Zkd }).__zkd;
      return {
        matchId: z.game()?.match?.matchId as string,
        me: z.game()?.playerIndex as number,
        log: z.tickLog(),
      };
    });
    await Promise.all(
      pages.map((p) =>
        p.waitForFunction(
          () => (window as unknown as { __zkd?: Zkd }).__zkd?.proof()?.auditDone === true,
          undefined,
          { timeout: 30 * 60_000, polling: 1000 },
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 500)); // let the server persist the audit close
    for (const p of pages) await p.context().close();
    if (!info.log) throw new Error('no tick log — build with VITE_LOG_TICKS=true');
    const row = analyzeRun({
      db,
      matchId: info.matchId,
      cheaterIndex: info.me,
      cheat,
      mNominal: m,
      windowTicks: N,
      cheaterLog: info.log,
      environment: 'browser',
      deviceLabel: label,
    });
    insertRun(db, row);
    const line = `${new Date().toISOString()} [browser] ${cheat} m=${m} → m_eff ${row.mEffective}, r ${row.challengeRate?.toFixed(3)}, live ${row.caughtLive ? 'YES' : 'no'} (pred ${((row.predictedLive ?? 0) * 100).toFixed(0)} %), latency ${row.latencyWindows ?? '–'} w / ${row.latencyMs ?? '–'} ms, audit ${row.caughtAudit ? 'YES' : 'no'}, final ${row.finalStatus} (cheater ${row.cheaterStatus})${row.notes ? ` ANOMALIES: ${row.notes}` : ''}`;
    console.log(line);
    appendFileSync(LOG, line + '\n');
  }
  await browser.close();
  exportCsv(db, join(ROOT, 'bench', 'out', 'detection.csv'));
  const t = matrix(db);
  console.log(t);
  appendFileSync(LOG, `\n${t}\n`);
  db.close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
