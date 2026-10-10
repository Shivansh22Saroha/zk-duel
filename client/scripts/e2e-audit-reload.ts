/**
 * Phase 3 follow-up test: the post-match audit survives a page reload.
 * Two real Chrome windows play a short bot match (production `--mode perf` build), player 0's page
 * is reloaded once a few of its audit windows are proven, and the audit must resume from IndexedDB
 * and end `audited_clean`. Exits 1 on any failure.
 *
 *   npm run perf:serve            (other terminal: perf build + server + vite preview)
 *   npm run e2e:audit-reload
 *
 * Writes server/data/test-reports/phase3-audit-reload.txt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const API = process.env.PERF_API ?? 'http://localhost:8080';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
const PLAY_S = 25;

type Proof = {
  resumed?: boolean;
  auditing: boolean;
  auditDone: boolean;
  auditStatus: string | null;
  auditTotal: number;
  auditProven: number;
};
type Zkd = {
  game(): { phase: string; match: { matchId: string } | null } | null;
  proof(): Proof | null;
};
const zkd = (p: Page) =>
  p.evaluate(() => (window as unknown as { __zkd?: Zkd }).__zkd?.proof() ?? null);

async function main(): Promise<void> {
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
  const pages: Page[] = [];
  for (const [i, seed] of [31, 42].entries()) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[page ${i}] ${e.message}`));
    await page.goto(`${BASE}?bot=${seed}&acc=1800${i === 1 ? `&stopAfter=${PLAY_S}` : ''}`);
    pages.push(page);
  }
  const [p0, p1] = pages as [Page, Page];
  const ended = (p: Page) =>
    p.waitForFunction(
      () => (window as unknown as { __zkd?: Zkd }).__zkd?.game()?.phase === 'ended',
      undefined,
      { timeout: 180_000, polling: 200 },
    );
  await Promise.all([ended(p0), ended(p1)]);
  const matchId = await p0.evaluate(
    () => (window as unknown as { __zkd: Zkd }).__zkd.game()?.match?.matchId,
  );
  // reload player 0 once its audit is under way (≥ 3 windows proven, not finished)
  await p0.waitForFunction(
    () => {
      const s = (window as unknown as { __zkd?: Zkd }).__zkd?.proof();
      return !!s && s.auditing && s.auditProven >= 3;
    },
    undefined,
    { timeout: 300_000, polling: 250 },
  );
  const before = await zkd(p0);
  await p0.reload();
  await p0.waitForFunction(
    () => (window as unknown as { __zkd?: Zkd }).__zkd?.proof()?.resumed === true,
    undefined,
    { timeout: 60_000, polling: 250 },
  );
  const resumedAt = await zkd(p0);
  const done = (p: Page) =>
    p.waitForFunction(
      () => (window as unknown as { __zkd?: Zkd }).__zkd?.proof()?.auditDone === true,
      undefined,
      { timeout: 30 * 60_000, polling: 1000 },
    );
  await Promise.all([done(p0), done(p1)]);
  const after = await zkd(p0);
  const summary = (await p1.evaluate(
    async ([api, id]) => {
      const r = await fetch(`${api}/api/matches/${id}`, {
        headers: { authorization: `Bearer ${sessionStorage.getItem('zkd.token')}` },
      });
      return r.json();
    },
    [API, matchId] as const,
  )) as {
    auditStatus: string;
    players: {
      playerIndex: number;
      windows: number;
      auditStatus: string;
      proofs: { byStatus: Record<string, number> };
    }[];
  };
  const idb = await p0.evaluate(
    () =>
      new Promise<number>((res) => {
        const r = indexedDB.open('zkduel-audit');
        r.onsuccess = () => {
          const t = r.result.transaction('jobs', 'readonly').objectStore('jobs').count();
          t.onsuccess = () => res(t.result);
          t.onerror = () => res(-1);
        };
        r.onerror = () => res(-1);
      }),
  );
  await browser.close();

  const ok =
    summary.auditStatus === 'audited_clean' &&
    after?.auditStatus === 'audited_clean' &&
    (resumedAt?.auditTotal ?? 0) > 0 &&
    idb === 0;
  const lines = [
    `${new Date().toISOString()} match ${matchId} (${PLAY_S} s of play, production perf build)`,
    `before reload (p0): proven ${before?.auditProven}/${before?.auditTotal}`,
    `after reload: resumed with ${resumedAt?.auditTotal} windows left to prove`,
    `end: p0 ${after?.auditStatus}, match ${summary.auditStatus}; ${summary.players.map((p) => `p${p.playerIndex} ${p.windows} windows ${JSON.stringify(p.proofs.byStatus)} own ${p.auditStatus}`).join('; ')}`,
    `IndexedDB jobs left on p0 after the audit: ${idb}`,
    ok ? 'PASS' : 'FAIL',
  ];
  console.log(lines.join('\n'));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'phase3-audit-reload.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
