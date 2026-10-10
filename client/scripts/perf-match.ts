/**
 * Phase 3 browser exit check: two real Chrome windows (headed, visible) play one bot-driven match
 * (`?bot=<seed>&acc=<aim jitter>`) against the running dev server with the real proving key,
 * through the spot-checks and the full post-match audit. Reports frame time while proving
 * (live play — a challenge is being proven almost all the time), challenge rate, prove times,
 * audit duration and the final audit status.
 *
 *   npm run dev               (server: ACTIVE_VARIANT=groth16_60; client: vite)
 *   npm run perf:match -- --acc 400
 *
 * Writes server/data/test-reports/phase3-browser-match.{txt,json}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const API = process.env.PERF_API ?? 'http://localhost:8080';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const acc = Number(arg('acc', '400'));
/** Seconds of play after which page 1 forfeits (fixed-length match); 0 = play to the end. */
const stopAfter = Number(arg('stop-after', '0'));
const tag = arg('tag', 'phase3-browser-match');

type Zkd = {
  game(): { phase: string; match: { matchId: string } | null; playerIndex: number } | null;
  stats(): Record<string, number>;
  resetStats(): void;
  proof(): Record<string, unknown> | null;
};
const zkd = (p: Page) => p.evaluate.bind(p);

async function waitPhase(page: Page, phase: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (ph) => (window as unknown as { __zkd?: Zkd }).__zkd?.game()?.phase === ph,
    phase,
    { timeout: timeoutMs, polling: 200 },
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1100,800',
      // two windows on one desktop: never treat the covered one as hidden
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  const pages: Page[] = [];
  for (const [i, seed] of [11, 22].entries()) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[page ${seed}] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[console ${seed}] ${m.text()}`);
    });
    await page.goto(
      `${BASE}?bot=${seed}&acc=${acc}${i === 1 && stopAfter > 0 ? `&stopAfter=${stopAfter + 4}` : ''}`,
    );
    pages.push(page);
  }
  await Promise.all(pages.map((p) => waitPhase(p, 'live', 120_000)));
  const t0 = Date.now();
  await Promise.all(
    pages.map((p) => zkd(p)(() => (window as unknown as { __zkd: Zkd }).__zkd.resetStats())),
  );
  // sample frame stats every 20 s during live play (the buffer keeps the last 3600 frames)
  const samples: Record<string, number>[][] = [[], []];
  const sampler = setInterval(() => {
    pages.forEach(
      (p, i) =>
        void zkd(p)(() => (window as unknown as { __zkd: Zkd }).__zkd.stats())
          .then((s) => {
            samples[i]?.push(s as Record<string, number>);
            return zkd(p)(() => (window as unknown as { __zkd: Zkd }).__zkd.resetStats());
          })
          .catch(() => undefined),
    );
  }, 20_000);
  await Promise.all(pages.map((p) => waitPhase(p, 'ended', 15 * 60_000)));
  clearInterval(sampler);
  const matchMs = Date.now() - t0;
  const last = await Promise.all(
    pages.map((p) => zkd(p)(() => (window as unknown as { __zkd: Zkd }).__zkd.stats())),
  );
  last.forEach((s, i) => samples[i]?.push(s as Record<string, number>));
  const matchId = await pages[0]?.evaluate(
    () => (window as unknown as { __zkd: Zkd }).__zkd.game()?.match?.matchId,
  );
  const t1 = Date.now();
  await Promise.all(
    pages.map((p) =>
      p.waitForFunction(
        () => (window as unknown as { __zkd: Zkd }).__zkd.proof()?.auditDone === true,
        undefined,
        { timeout: 40 * 60_000, polling: 1000 },
      ),
    ),
  );
  const auditMs = Date.now() - t1;
  const proofState = await Promise.all(
    pages.map((p) => zkd(p)(() => (window as unknown as { __zkd: Zkd }).__zkd.proof())),
  );
  const summary = await pages[0]?.evaluate(
    async ([api, id]) => {
      const token = sessionStorage.getItem('zkd.token');
      const r = await fetch(`${api}/api/matches/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return r.json();
    },
    [API, matchId] as const,
  );
  const ua = await pages[0]?.evaluate(() => navigator.userAgent);
  await browser.close();

  // frame interval: worst p95 across the 20 s samples (each sample = that window's frames)
  const lines: string[] = [
    `${new Date().toISOString()} Chrome headed, 2 visible windows — ${ua}`,
    `match ${matchId}: live play ${(matchMs / 1000).toFixed(0)} s, audit ${(auditMs / 1000).toFixed(0)} s, acc=${acc}`,
  ];
  samples.forEach((ss, i) => {
    const p95s = ss.map((s) => s.intervalP95 ?? 0);
    const frames = ss.reduce((n, s) => n + (s.frames ?? 0), 0);
    lines.push(
      `page ${i}: frame interval p95 per 20 s sample [${p95s.map((v) => v.toFixed(1)).join(', ')}] ms → worst ${Math.max(...p95s).toFixed(1)} ms; p50 ${ss.map((s) => (s.intervalP50 ?? 0).toFixed(1)).join('/')}; max ${Math.max(...ss.map((s) => s.intervalMax ?? 0)).toFixed(0)} ms; work p95 ${Math.max(...ss.map((s) => s.workP95 ?? 0)).toFixed(2)} ms; ${frames} frames`,
    );
  });
  proofState.forEach((s, i) => lines.push(`page ${i} proof state: ${JSON.stringify(s)}`));
  const sm = summary as {
    auditStatus: string;
    overturned: boolean;
    endReason: string;
    totalTicks: number;
    players: {
      playerIndex: number;
      windows: number;
      windowsCommitted: number;
      challenges: number;
      challengesPassed: number;
      challengeRate: number;
      auditMs: number;
      proofs: {
        byStatus: Record<string, number>;
        proveMsMean: number;
        proveMsP95: number;
        verifyMsMean: number;
      };
    }[];
  };
  lines.push(
    `audit status ${sm.auditStatus}${sm.overturned ? ' OVERTURNED' : ''}; end ${sm.endReason}; ${sm.totalTicks} ticks (${(sm.totalTicks / 60).toFixed(0)} s of rounds)`,
  );
  for (const p of sm.players) {
    lines.push(
      `p${p.playerIndex}: windows ${p.windows} (committed ${p.windowsCommitted}), challenges ${p.challenges} passed ${p.challengesPassed}, r = ${p.challengeRate?.toFixed(3)}, audit ${(p.auditMs / 1000).toFixed(1)} s, statuses ${JSON.stringify(p.proofs.byStatus)}, prove mean ${p.proofs.proveMsMean?.toFixed(0)} / p95 ${p.proofs.proveMsP95} ms (client-reported), verify mean ${p.proofs.verifyMsMean?.toFixed(1)} ms`,
    );
  }
  console.log(lines.join('\n'));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${tag}.txt`), lines.join('\n') + '\n');
  writeFileSync(
    join(OUT_DIR, `${tag}.json`),
    JSON.stringify({ samples, proofState, summary, matchMs, auditMs }, null, 1),
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
