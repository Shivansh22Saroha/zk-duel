/**
 * Viva readiness: does the game work with no internet? One Chrome (headed) whose network is cut off
 * except for loopback: every request to a host other than localhost / 127.0.0.1 is aborted and
 * recorded (Playwright route), and Chrome is pointed at a dead proxy for everything that is not
 * loopback, so anything the route misses fails too. Plays one short bot match (two windows,
 * spot-checks + full audit), opens the results page and then /bench.
 *
 *   npm run perf:serve          (or npm run demo; other terminal)
 *   npm run offline:check
 * Writes server/data/test-reports/offline-check.{txt,png}; exits 1 if anything left the machine
 * or a page failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
/** Seconds of play before page B forfeits, so the check (match + audit) stays short. */
const STOP_AFTER_S = 30;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

const blocked: string[] = [];
const errors: string[] = [];
const lines: string[] = [];
const fail: string[] = [];
const check = (ok: boolean, what: string) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) fail.push(what);
};
const until = (p: Page, src: string, timeout: number) =>
  p.waitForFunction(
    (s) => new Function('zk', `return ${s}`)((window as unknown as { __zkd?: unknown }).__zkd),
    src,
    { timeout, polling: 250 },
  );

function watch(page: Page, tag: string): void {
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] console ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    if (!LOCAL.has(new URL(r.url()).hostname)) return;
    errors.push(`[${tag}] local request failed ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
}

async function cutOff(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    const host =
      url.startsWith('data:') || url.startsWith('blob:') ? 'localhost' : new URL(url).hostname;
    if (LOCAL.has(host)) return route.continue();
    blocked.push(url);
    return route.abort('internetdisconnected');
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1100,800',
      // Chrome never proxies loopback, so only non-local traffic hits the dead proxy.
      '--proxy-server=http://127.0.0.1:9',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  const t0 = Date.now();
  const s = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const pages: Page[] = [];
  for (const [seed, extra] of [
    [11, ''],
    [12, `&stopAfter=${STOP_AFTER_S}`],
  ] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    await cutOff(ctx);
    const page = await ctx.newPage();
    watch(page, `bot${seed}`);
    await page.goto(`${BASE}?bot=${seed}&acc=1800&miss=300${extra}`);
    pages.push(page);
  }
  const [a, b] = pages as [Page, Page];

  // A face is fetched only when text uses it; the landing page's body text uses Inter.
  const inter = await a.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(
      (f) => f.family.replace(/"/g, '') === 'Inter' && f.status === 'loaded',
    );
  });
  check(inter, `landing page loads with the bundled Inter font (loaded: ${inter})`);
  await Promise.all(pages.map((p) => until(p, "zk?.game()?.phase === 'live'", 120_000)));
  check(true, `bot match started (${s()})`);
  await Promise.all(pages.map((p) => until(p, "zk.game()?.phase === 'ended'", 300_000)));
  check(true, `match ended (${s()})`);
  await Promise.all(pages.map((p) => until(p, 'zk.proof()?.auditDone === true', 20 * 60_000)));
  const status = await a.evaluate(
    () =>
      (window as unknown as { __zkd: { proof(): { auditStatus: string } } }).__zkd.proof()
        .auditStatus,
  );
  check(status === 'audited_clean', `audit done: ${status} (${s()})`);
  await a.waitForURL(/\/results(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
  check(/\/results(\?|$)/.test(new URL(a.url()).pathname), `results page shown (${a.url()})`);
  await a.screenshot({ path: join(OUT, 'offline-check-results.png') });

  await b.goto(`${BASE}bench`);
  const charts = await b
    .waitForFunction(() => document.querySelectorAll('canvas').length >= 4, null, {
      timeout: 30_000,
    })
    .then(
      () => b.evaluate(() => document.querySelectorAll('canvas').length),
      () => 0,
    );
  check(charts >= 4, `/bench renders ${charts} chart canvases`);
  await b.screenshot({ path: join(OUT, 'offline-check-bench.png') });

  check(blocked.length === 0, `no request left the machine (${blocked.length} blocked)`);
  check(errors.length === 0, `no page errors / failed local requests (${errors.length})`);
  await browser.close();

  const report = [
    `offline check ${new Date().toISOString()}  base ${BASE}`,
    ...lines,
    '',
    'Blocked (would need the internet):',
    ...[...new Set(blocked)].map((u) => `  ${u}`),
    '',
    'Errors:',
    ...errors.map((e) => `  ${e}`),
  ].join('\n');
  writeFileSync(join(OUT, 'offline-check.txt'), report);
  console.log(`\n${report}\n→ server/data/test-reports/offline-check.txt`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
