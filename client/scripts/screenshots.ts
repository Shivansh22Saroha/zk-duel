/**
 * Phase 5 report screenshots (1280×720, real Chrome, production `--mode perf` build with dev
 * cheats, server DEV_CHEATS=true):
 *  1. 3d-topdown-proof-strip.png  — live bot match, angled top-down, proof strip with ✓ cells
 *  2. 3d-first-person.png         — same match after V (first-person)
 *  3. results-audited-clean.png   — results screen once the full audit ends AUDITED CLEAN
 *  4. strict-forfeit-banner.png   — strict private room, speedhack on → failed spot-check forfeit
 *
 *   npm run perf:serve        (other terminal)
 *   npm run screenshots
 * Writes bench/out/screenshots/*.png; exits 1 if a state is not reached.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../bench/out/screenshots');
const VIEW = { width: 1280, height: 720 };
/** Seconds of play before the top-down shot (several spot-checks decided by then). */
const SHOT_AFTER_S = 25;
const MATCH_S = 60;

const until = (p: Page, src: string, timeout: number) =>
  p.waitForFunction(
    (s) => new Function('zk', `return ${s}`)((window as unknown as { __zkd?: unknown }).__zkd),
    src,
    { timeout, polling: 250 },
  );

async function open(browser: Browser, url: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  await page.goto(url);
  return page;
}

async function shot(p: Page, name: string): Promise<void> {
  await p.bringToFront();
  await p.screenshot({ path: join(OUT, name) });
  console.log(`screenshot ${name}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1300,820',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  try {
    // ---- 1–3: honest bot match (queue), top-down → first-person → results after the audit
    const a = await open(browser, `${BASE}?bot=31&acc=1800&miss=300`);
    const b = await open(browser, `${BASE}?bot=32&acc=1800&miss=300&stopAfter=${MATCH_S + 4}`);
    await Promise.all([a, b].map((p) => until(p, "zk?.game()?.phase === 'live'", 120_000)));
    await until(a, `zk.game().tick > ${SHOT_AFTER_S * 60}`, (SHOT_AFTER_S + 30) * 1000);
    await a.waitForFunction(
      () => document.querySelectorAll('.strip .cell.valid').length >= 3,
      undefined,
      { timeout: 60_000 },
    );
    await shot(a, '3d-topdown-proof-strip.png');
    await a.keyboard.press('v');
    await a.waitForTimeout(1500);
    await shot(a, '3d-first-person.png');
    await a.keyboard.press('v'); // back to top-down (the mode is remembered per browser context)
    await Promise.all([a, b].map((p) => until(p, "zk.game()?.phase === 'ended'", 5 * 60_000)));
    await until(a, 'zk.proof()?.auditDone === true', 30 * 60_000);
    await a.waitForFunction(() => document.body.innerText.includes('AUDITED CLEAN'), undefined, {
      timeout: 60_000,
    });
    await shot(a, 'results-audited-clean.png');
    await a.context().close();
    await b.context().close();

    // ---- 4: strict private room, speedhack → forfeit on the first failed spot-check
    const c = await open(browser, `${BASE}?bot=41&acc=1800&miss=300&manual=1`);
    const d = await open(browser, `${BASE}?bot=42&acc=1800&miss=300&manual=1`);
    await c.fill('#name', `shot_a${Date.now() % 1000}`);
    await c.click('#private-room summary');
    await c.selectOption('#room-enforcement', 'strict');
    await c.click('#create-room');
    const code = (
      (await c.locator('span.room-code').textContent({ timeout: 10_000 })) ?? ''
    ).trim();
    await d.fill('#name', `shot_b${Date.now() % 1000}`);
    await d.click('#private-room summary');
    await d.fill('#room-code', code);
    await d.click('#join-room');
    await Promise.all([c, d].map((p) => until(p, "zk?.game()?.phase === 'live'", 120_000)));
    await until(c, 'zk.game().tick > 120', 30_000);
    await c.evaluate(() =>
      (window as unknown as { __zkd: { cheat(n: string, on: boolean): void } }).__zkd.cheat(
        'speedhack',
        true,
      ),
    );
    await until(c, "zk.game()?.phase === 'ended'", 180_000);
    await c.locator('.forfeit-banner:not([hidden])').waitFor({ timeout: 10_000 });
    await c.waitForTimeout(500);
    await shot(c, 'strict-forfeit-banner.png');
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
