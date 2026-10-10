/**
 * Browser proving measurement (Phase 3 Step 1): drives client/bench.html in real, visible
 * Chrome (Playwright channel "chrome", headed, one visible tab at a time) and collects witness /
 * prove times and main-thread frame time while the Proof Worker proves real windows.
 *
 *   npm run dev -w client     (in another terminal)
 *   npm run perf:prove -- --variants groth16_60,groth16_30 --threads default,6,4,2,single --count 10
 *
 * Writes server/data/test-reports/phase3-browser-prove.{json,txt}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { BenchResult } from '../src/bench/proveBench';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const variants = arg('variants', 'groth16_60,groth16_30').split(',');
const threadSets = arg('threads', 'default').split(',');
const count = Number(arg('count', '10'));
const tag = arg('tag', 'phase3-browser-prove');

const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--window-size=1400,900'],
  });
  const results: BenchResult[] = [];
  const lines: string[] = [];
  for (const variant of variants) {
    for (const threads of threadSets) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[console] ${m.text()}`);
      });
      await page.bringToFront();
      await page.goto(
        `${BASE}bench.html?variant=${variant}&count=${count}&warmup=1&threads=${threads}`,
      );
      await page.waitForFunction(
        () => (window as unknown as { __bench?: { done: boolean } }).__bench?.done === true,
        undefined,
        { timeout: 30 * 60_000, polling: 500 },
      );
      const out = (await page.evaluate(
        () => (window as unknown as { __bench: { result?: BenchResult; error?: string } }).__bench,
      )) as { result?: BenchResult; error?: string };
      await ctx.close();
      if (!out.result) throw new Error(`${variant}/${threads}: ${out.error}`);
      const r = out.result;
      results.push(r);
      const pr = r.samples.map((s) => s.proveMs);
      const wi = r.samples.map((s) => s.witnessMs);
      const line =
        `${variant} threads=${threads} (snarkjs sub-workers ${r.samples[0]?.threads}, hc ${r.hardwareConcurrency}): ` +
        `witness p50 ${pct(wi, 0.5).toFixed(0)} p95 ${pct(wi, 0.95).toFixed(0)} ms | ` +
        `prove p50 ${pct(pr, 0.5).toFixed(0)} p95 ${pct(pr, 0.95).toFixed(0)} min ${Math.min(...pr).toFixed(0)} max ${Math.max(...pr).toFixed(0)} ms | ` +
        `warm-up prove ${r.warmup[0]?.proveMs.toFixed(0)} ms | ` +
        `frame interval idle p95 ${r.frameIdle.intervalP95.toFixed(1)} ms, proving p50 ${r.frameProving.intervalP50.toFixed(1)} p95 ${r.frameProving.intervalP95.toFixed(1)} max ${r.frameProving.intervalMax.toFixed(0)} ms (${r.frameProving.frames} frames), work p95 ${r.frameProving.workP95.toFixed(2)} ms | ` +
        `signals ${r.samples.every((s) => s.signalsMatch) ? 'all match JS' : 'MISMATCH'}${r.hiddenDuringRun ? ' | TAB WAS HIDDEN' : ''}`;
      console.log(line);
      lines.push(line);
    }
  }
  await browser.close();
  mkdirSync(OUT_DIR, { recursive: true });
  const header = `${new Date().toISOString()} Chrome (headed, tab visible) — ${results[0]?.userAgent}`;
  writeFileSync(join(OUT_DIR, `${tag}.json`), JSON.stringify(results, null, 1));
  writeFileSync(join(OUT_DIR, `${tag}.txt`), [header, ...lines].join('\n') + '\n');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
