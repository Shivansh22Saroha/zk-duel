/**
 * Viva rehearsal: walks through docs/DEMO.md with the same clicks and keys a presenter uses, and
 * times each step. The "presenter" window plays with BotInput (`?bot=…&manual=1`: the bot moves and
 * shoots, the lobby is driven through the UI); the opponent windows are the URLs `npm run demo`
 * prints.
 *  1. Find Match vs `?bot=7` → match live → first spot-check ✓ → match end → audit → results.
 *  2. Private room (strict) created through the UI, the bot window joins with the code, F9 →
 *     Speedhack checkbox → forfeit banner → audit → results (AUDIT FAILED).
 *  3. /bench charts.
 *
 *   npm run demo                (other terminal; optionally npm run demo:reset first)
 *   npm run demo:rehearse
 * Writes server/data/test-reports/demo-rehearsal.txt; exits 1 if a step fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
const MATCH_TIMEOUT_MS = 10 * 60_000;
const AUDIT_TIMEOUT_MS = 20 * 60_000;

const lines: string[] = [];
const fail: string[] = [];
const log = (ok: boolean, what: string) => {
  const l = `${ok ? 'PASS' : 'FAIL'} ${what}`;
  lines.push(l);
  console.log(l);
  if (!ok) fail.push(what);
};
const until = (p: Page, src: string, timeout: number) =>
  p.waitForFunction(
    (s) => new Function('zk', `return ${s}`)((window as unknown as { __zkd?: unknown }).__zkd),
    src,
    { timeout, polling: 250 },
  );
const read = <T>(p: Page, src: string) =>
  p.evaluate(
    (s) => new Function('zk', `return ${s}`)((window as unknown as { __zkd?: unknown }).__zkd),
    src,
  ) as Promise<T>;
const clock = () => {
  const t0 = Date.now();
  return () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
};

async function open(browser: Browser, query: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${query}] ${e.message}`));
  await page.goto(`${BASE}${query}`);
  return page;
}

/** Waits for the audit, then the results screen; returns the results card's status line. */
async function auditAndResults(p: Page, t: () => string, label: string): Promise<string> {
  await until(p, 'zk.proof()?.auditDone === true', AUDIT_TIMEOUT_MS);
  log(true, `${label}: audit done (${t()})`);
  await p.waitForSelector('#results', { timeout: 60_000 });
  // The first status word on the card is the verdict (the rest are explanations further down).
  const verdict = ((await p.locator('#results').textContent()) ?? '').match(
    /AUDITED CLEAN|AUDIT FAILED|AUDIT INCOMPLETE/,
  )?.[0];
  log(!!verdict, `${label}: results page shows ${verdict} (${t()})`);
  return verdict ?? '';
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
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

  // ------------------------------------------------ step 1: honest match vs bot
  {
    const t = clock();
    const me = await open(browser, '?bot=21&manual=1');
    await me.fill('#name', 'presenter');
    await me.waitForSelector('#find-match:not([disabled])', { timeout: 120_000 });
    log(true, `1: lobby ready (${t()})`);
    await me.click('#find-match');
    const bot = await open(browser, '?bot=7');
    await until(me, "zk?.game()?.phase === 'live'", 120_000);
    log(true, `1: match live vs ?bot=7 (${t()})`);
    await until(me, 'zk.proof()?.spot?.some((s) => s.passed > 0)', 60_000);
    log(true, `1: first spot-check ✓ on the proof strip (${t()})`);
    await until(me, "zk.game()?.phase === 'ended'", MATCH_TIMEOUT_MS);
    const r = await read<{ reason: string }>(me, 'zk.game()?.result');
    log(true, `1: match ended (${r.reason}) (${t()})`);
    const v = await auditAndResults(me, t, '1');
    log(v.includes('AUDITED CLEAN'), `1: honest match → AUDITED CLEAN`);
    await bot.context().close();
    await me.context().close();
  }

  // ------------------------------------------------ step 2: private strict room + speedhack
  {
    const t = clock();
    const me = await open(browser, '?bot=31&manual=1');
    const bot = await open(browser, '?bot=8&manual=1&acc=1800&miss=300');
    await me.fill('#name', 'presenter');
    await me.click('#private-room summary');
    await me.selectOption('#room-enforcement', 'strict');
    await me.click('#create-room');
    const code = (
      (await me.locator('span.room-code').textContent({ timeout: 120_000 })) ?? ''
    ).trim();
    log(true, `2: private strict room ${code} created (${t()})`);
    await bot.fill('#name', 'bot');
    await bot.click('#private-room summary');
    await bot.fill('#room-code', code);
    await bot.click('#join-room');
    await until(me, "zk?.game()?.phase === 'live'", 120_000);
    log(true, `2: bot joined, match live (${t()})`);
    await until(me, 'zk.game().tick > 120', 30_000);
    await me.keyboard.press('F9');
    await me.locator('#cheat-speedhack').check();
    const tc = clock();
    log(true, `2: F9 → Speedhack on (${t()})`);
    await me.waitForSelector('.forfeit-banner:not([hidden])', { timeout: 120_000 });
    const banner = (await me.locator('.forfeit-banner').textContent()) ?? '';
    log(
      banner.includes('Spot-check failed'),
      `2: forfeit banner ${tc()} after speedhack: "${banner.trim()}"`,
    );
    const v = await auditAndResults(me, t, '2');
    log(v.includes('AUDIT FAILED'), `2: cheater → AUDIT FAILED`);
    await bot.context().close();
    await me.context().close();
  }

  // ------------------------------------------------ step 3: /bench
  {
    const t = clock();
    const p = await open(browser, 'bench');
    await p.waitForFunction(() => document.querySelectorAll('canvas').length >= 4, null, {
      timeout: 30_000,
    });
    log(true, `3: /bench shows its charts (${t()})`);
    await p.context().close();
  }
  await browser.close();

  const report = [`demo rehearsal ${new Date().toISOString()}  base ${BASE}`, ...lines].join('\n');
  writeFileSync(join(OUT, 'demo-rehearsal.txt'), report);
  console.log(`\n→ server/data/test-reports/demo-rehearsal.txt`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
