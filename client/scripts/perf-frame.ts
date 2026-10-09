/**
 * Client frame-time measurement (NFR-2) in real Chrome: two pages play a full match in
 * dev bot mode (`?bot=<seed>`), and we read the page's FrameStats during live play.
 *
 *   npm run dev            (in another terminal)
 *   npm run perf:frame              (headless)
 *   npm run perf:frame -- --headed  (visible windows; closer to real play)
 *
 * Uses the installed Google Chrome (Playwright channel "chrome").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.PERF_URL ?? 'http://localhost:5173/';
const headed = process.argv.includes('--headed');
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');

interface Stats {
  frames: number;
  fps: number;
  intervalP50: number;
  intervalP95: number;
  intervalMax: number;
  workP50: number;
  workP95: number;
  workMax: number;
}

async function waitForPhase(page: Page, phase: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (p) =>
      (window as unknown as { __zkd?: { game(): { phase: string } | null } }).__zkd?.game()
        ?.phase === p,
    phase,
    { timeout: timeoutMs, polling: 100 },
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: ['--window-size=1400,900'],
  });
  const pages: Page[] = [];
  for (const seed of [11, 22]) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(`${URL}?bot=${seed}`);
    pages.push(page);
  }
  await Promise.all(pages.map((p) => waitForPhase(p, 'live', 60_000)));
  // measure only live play: reset at round start, sample right before each round ends
  await Promise.all(
    pages.map((p) =>
      p.evaluate(() => (window as unknown as { __zkd: { resetStats(): void } }).__zkd.resetStats()),
    ),
  );
  await Promise.all(pages.map((p) => waitForPhase(p, 'ended', 300_000)));
  const results = (await Promise.all(
    pages.map((p) =>
      p.evaluate(() => (window as unknown as { __zkd: { stats(): unknown } }).__zkd.stats()),
    ),
  )) as Stats[];
  const ua = await pages[0]?.evaluate(() => navigator.userAgent);
  await browser.close();

  const fmt = (s: Stats, i: number) =>
    `page ${i}: frames=${s.frames} fps=${s.fps.toFixed(1)} frameInterval p50=${s.intervalP50.toFixed(2)}ms p95=${s.intervalP95.toFixed(2)}ms max=${s.intervalMax.toFixed(1)}ms | work (sim+render) p50=${s.workP50.toFixed(3)}ms p95=${s.workP95.toFixed(3)}ms max=${s.workMax.toFixed(2)}ms`;
  const text = [
    `${new Date().toISOString()} ${headed ? 'headed' : 'headless'} Chrome — ${ua}`,
    ...results.map(fmt),
  ].join('\n');
  console.log(text);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `phase1-frame-${headed ? 'headed' : 'headless'}.txt`), text + '\n');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
