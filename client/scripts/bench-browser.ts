/**
 * Phase 5 Chrome benchmark driver: runs the /bench browser runner in real, visible Chrome against
 * the production build (`npm run perf:serve`), one fresh tab per variant (tab in front, nothing
 * else open), then uploads the run and exports the charts.
 *
 *   npm run perf:serve                       (other terminal)
 *   npm run bench:browser                    all 6 variants, upload, export PNGs
 *   npm run bench:browser -- --variants groth16_30 --samples 3 --no-upload
 *   npm run bench:browser -- --export-only   PNGs from the latest uploaded runs
 *
 * Memory: Chrome's private bytes summed over this test browser's processes (the prover runs in
 * the tab's renderer process; snarkjs's sub-workers are threads in it), sampled every
 * MEM_SAMPLE_MS by one PowerShell loop, and attributed to each sample by its start/end time.
 * The page never sees BENCH_TOKEN: this script uploads.
 *
 * Writes bench/out/raw/browser-<timestamp>.json and bench/out/charts/*.png.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  BENCH_SAMPLES,
  BENCH_WARMUPS,
  BENCH_WINDOW_TICKS,
  SCHEMES,
} from '@zkduel/shared/constants';
import type { BrowserBenchResult, BrowserVariantRun } from '../src/bench/benchRunner';
import type { DetectionCell } from '../src/bench/benchCharts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const API = process.env.PERF_API ?? 'http://localhost:8080';
const MEM_SAMPLE_MS = 250;
const MIB = 2 ** 20;
/** One variant may take long (PLONK N=120); a hung or crashed tab is a recorded failure. */
const VARIANT_TIMEOUT_MS = 90 * 60_000;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const variants =
  arg('variants')?.split(',') ?? SCHEMES.flatMap((s) => BENCH_WINDOW_TICKS.map((n) => `${s}_${n}`));
const samples = Number(arg('samples') ?? BENCH_SAMPLES);
/** PLONK may run fewer samples (owner decision, Phase 5); recorded in the run notes. */
const plonkSamples = Number(arg('plonk-samples') ?? samples);
const plonkWarmups = Number(arg('plonk-warmups') ?? BENCH_WARMUPS);
const upload = !process.argv.includes('--no-upload');
const exportOnly = process.argv.includes('--export-only');

type BenchPageHooks = {
  run(variants: string[], samples?: number, warmups?: number): Promise<BrowserBenchResult>;
  ready(): Promise<void>;
  setDetection(cells: DetectionCell[]): void;
  exportPngs(): Record<string, string>;
};
const hooks = 'window.__benchPage';

/** PIDs of this test browser's processes (only Playwright's Chrome runs with this pipe flag). */
function chromePids(): number[] {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'remote-debugging-pipe' } | ForEach-Object { $_.ProcessId }",
    ],
    { encoding: 'utf8' },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** Background sampler: lines "<epoch ms> <sum private bytes>". */
function startMemSampler(pids: number[]): { stop: () => Promise<[number, number][]> } {
  const script = `$ids=@(${pids.join(',')}); while ($true) { $t=[DateTimeOffset]::Now.ToUnixTimeMilliseconds(); $s=(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum; [Console]::Out.WriteLine("$t $s"); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${MEM_SAMPLE_MS} }`;
  const ps = spawn('powershell', ['-NoProfile', '-Command', script]);
  const points: [number, number][] = [];
  let buf = '';
  ps.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) {
      const [t, b] = l.trim().split(' ').map(Number);
      if (t && b) points.push([t, b]);
    }
  });
  return {
    stop: () =>
      new Promise((res) => {
        ps.once('exit', () => res(points));
        ps.kill();
      }),
  };
}

async function openBench(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[console] ${m.text()}`);
  });
  await page.goto(`${BASE}bench`);
  await page.waitForFunction(`!!${hooks}`, undefined, { timeout: 60_000 });
  await page.bringToFront();
  return page;
}

function detectionCells(): DetectionCell[] {
  const text = readFileSync(join(ROOT, 'bench', 'out', 'detection.csv'), 'utf8').trim();
  const [head, ...rows] = text.split(/\r?\n/);
  const cols = (head ?? '').split(',');
  const at = (r: string[], c: string) => r[cols.indexOf(c)] ?? '';
  const groups = new Map<string, string[][]>();
  for (const line of rows) {
    const r = line.split(','); // the columns used here never contain commas
    if (at(r, 'environment') !== 'node' || at(r, 'cheat') === 'smooth_aim') continue;
    const k = `${at(r, 'cheat')}|${at(r, 'm_nominal')}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = ['speedhack', 'rapid_fire', 'infinite_ammo', 'snap_aim'];
  return [...groups.entries()]
    .map(([k, g]) => {
      const [cheat, m] = k.split('|') as [string, string];
      const mean = (c: string) => g.reduce((a, r) => a + Number(at(r, c)), 0) / g.length;
      return {
        cheat,
        m: Number(m),
        runs: g.length,
        observedLive: mean('caught_live'),
        predictedLive: mean('predicted_live'),
        audit: mean('caught_audit'),
      };
    })
    .sort((a, b) => order.indexOf(a.cheat) - order.indexOf(b.cheat) || a.m - b.m);
}

async function exportCharts(browser: Browser): Promise<void> {
  const page = await openBench(browser);
  await page.evaluate(`${hooks}.ready()`);
  await page.evaluate((cells) => {
    (window as unknown as { __benchPage: BenchPageHooks }).__benchPage.setDetection(cells);
  }, detectionCells());
  const pngs = (await page.evaluate(`${hooks}.exportPngs()`)) as Record<string, string>;
  const dir = join(ROOT, 'bench', 'out', 'charts');
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(pngs)) {
    writeFileSync(join(dir, `${name}.png`), Buffer.from(url.split(',')[1] ?? '', 'base64'));
    console.log(`chart ${name}.png`);
  }
  await page.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1300,950',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  try {
    if (exportOnly) return await exportCharts(browser);
    const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
    const deviceLabel = `${cpu}, ${Math.round(totalmem() / 2 ** 30)} GB, ${cpus().length} threads`;
    let meta: BrowserBenchResult | null = null;
    const runs: (BrowserVariantRun & { baseMemMb?: number })[] = [];
    for (const v of variants) {
      const page = await openBench(browser);
      const sampler = startMemSampler(chromePids());
      const t0 = Date.now();
      let res: BrowserBenchResult | null = null;
      let error: string | null = null;
      try {
        res = (await Promise.race([
          page.evaluate(
            ([vv, n, w]) =>
              (window as unknown as { __benchPage: BenchPageHooks }).__benchPage.run([vv], n, w),
            v.startsWith('plonk')
              ? ([v, plonkSamples, plonkWarmups] as const)
              : ([v, samples, BENCH_WARMUPS] as const),
          ),
          new Promise<never>((_, rej) => {
            page.once('crash', () => rej(new Error('tab crashed (out of memory?)')));
            setTimeout(() => rej(new Error('variant timed out')), VARIANT_TIMEOUT_MS);
          }),
        ])) as BrowserBenchResult;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const mem = await sampler.stop();
      const run: BrowserVariantRun & { baseMemMb?: number } = res?.runs[0] ?? {
        id: v,
        ok: false,
        error: error ?? 'no result',
        warmupMs: [],
        samples: [],
      };
      const before = mem.filter(([t]) => t <= t0 + 1000).map(([, b]) => b);
      if (before.length) run.baseMemMb = Math.round(Math.min(...before) / MIB);
      for (const s of run.samples) {
        const inSample = mem.filter(([t]) => t >= s.startedAt && t <= s.endedAt + MEM_SAMPLE_MS);
        if (inSample.length)
          s.peakMemMb = Math.round(Math.max(...inSample.map(([, b]) => b)) / MIB);
      }
      console.log(
        `${v}: ${run.ok ? 'ok' : `FAILED (${run.error})`}, ${run.samples.length} samples, load ${run.loadMs?.toFixed(0)} ms, Chrome private memory base ${run.baseMemMb} MiB, peak ${Math.max(0, ...run.samples.map((s) => s.peakMemMb ?? 0))} MiB, ${(Date.now() - t0) / 1000} s`,
      );
      for (const s of run.samples)
        console.log(
          `  ${s.sampleNo}: witness ${s.witnessMs.toFixed(0)} prove ${s.proveMs.toFixed(0)} verify ${s.verifyMs.toFixed(1)} ms ${s.proofBytes} B ${s.valid ? 'valid' : 'INVALID'} ${s.peakMemMb} MiB`,
        );
      runs.push(run);
      if (res) meta = res;
      await page.context().close();
    }
    const record = {
      environment: 'browser' as const,
      deviceLabel,
      userAgent: meta?.userAgent,
      cpuThreads: meta?.cpuThreads,
      workerThreads: meta?.workerThreads,
      inputLog: meta?.inputLog ?? '',
      inputLogSha256: meta?.inputLogSha256,
      seed: meta?.seed ?? 0,
      hiddenDuringRun: meta?.hiddenDuringRun,
      runs,
    };
    const outDir = join(ROOT, 'bench', 'out', 'raw');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(record, null, 1));
    console.log(`wrote ${file}`);

    const results = runs.flatMap((r) => r.samples.map(({ startedAt: _s, endedAt: _e, ...s }) => s));
    if (upload && results.length && meta) {
      const token = /^BENCH_TOKEN=(.+)$/m
        .exec(readFileSync(join(ROOT, 'server', '.env'), 'utf8'))?.[1]
        ?.trim();
      if (!token) throw new Error('BENCH_TOKEN missing in server/.env');
      let gitCommit: string | undefined;
      try {
        gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
      } catch {
        gitCommit = undefined;
      }
      const failures = runs.filter((r) => !r.ok).map((r) => `FAILED ${r.id}: ${r.error}`);
      const notes = [
        `Chrome ${/Chrome\/([\d.]+)/.exec(meta.userAgent)?.[1] ?? '?'}, production build, Web Worker (${meta.workerThreads} snarkjs threads), tab visible${meta.hiddenDuringRun ? ' (WAS HIDDEN during the run)' : ''}`,
        'peak = Chrome private bytes, all processes of the test browser',
        `Groth16: ${BENCH_WARMUPS} warm-ups + ${samples} samples; PLONK: ${plonkWarmups} + ${plonkSamples}`,
        ...failures,
      ].join('; ');
      const r = await fetch(`${API}/api/bench/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-token': token },
        body: JSON.stringify({
          environment: 'browser',
          deviceLabel,
          userAgent: meta.userAgent,
          cpuThreads: meta.cpuThreads,
          inputLog: meta.inputLog,
          inputLogSha256: meta.inputLogSha256,
          seed: meta.seed,
          gitCommit,
          notes,
          results,
        }),
      });
      console.log(`upload: HTTP ${r.status} ${await r.text()}`);
    }
    if (upload) await exportCharts(browser);
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
