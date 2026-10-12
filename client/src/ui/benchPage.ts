/**
 * Benchmarks page `/bench` (UI_UX §3.5, FEATURES F15, Phase 5). Lazy-loaded (Chart.js stays out of
 * the game bundle).
 *
 * - Run selectors: the latest Chrome and Node runs by default (both shown in every chart).
 * - Charts: prove time vs N (median, p5–p95 band, dashed play-time line); proof size and verify
 *   time by scheme; r_max vs N. Table with every aggregate. CSV export per run; PNG export
 *   (white background, slide-sized) per chart.
 * - "Run benchmark in this browser": proves the deterministic bench log in a Web Worker; results
 *   show in the table immediately; upload needs the operator's BENCH_TOKEN (typed in, kept in
 *   memory only, sent as the X-Bench-Token header).
 */
import type { ChartConfiguration } from 'chart.js';
import { aggregate, type VariantAggregate } from '@zkduel/shared/benchStats';
import { BENCH_WINDOW_TICKS, SCHEMES } from '@zkduel/shared/constants';
import { api, type BenchRunMeta } from '../api';
import {
  DARK,
  detectionMatrix,
  LIGHT,
  proofSize,
  proveVsN,
  render,
  rMaxVsN,
  toPng,
  verifyTime,
  type DetectionCell,
  type EnvAggregates,
  type Theme,
} from '../bench/benchCharts';
import { runBrowserBench, type BrowserBenchResult } from '../bench/benchRunner';
import { h, setText, toast } from './dom';

/** PNG export size (16:9, slide-readable with LIGHT's type sizes). */
const PNG_W = 1600;
const PNG_H = 900;
const VARIANTS = SCHEMES.flatMap((s) => BENCH_WINDOW_TICKS.map((n) => `${s}_${n}`));
const ENV_NAME = { browser: 'Chrome', node: 'Node' } as const;

type Charts = Record<string, (envs: EnvAggregates[], t: Theme) => ChartConfiguration>;
const CHARTS: Charts = {
  'prove-time-vs-n': proveVsN as Charts[string],
  'proof-size': proofSize as Charts[string],
  'verify-time': verifyTime as Charts[string],
  'r-max-vs-n': rMaxVsN as Charts[string],
};

function fmt(v: number, digits = 0): string {
  return v.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function tableOf(envs: EnvAggregates[]): HTMLElement {
  const head = [
    'Env',
    'Scheme',
    'N',
    'Constraints',
    'Prove mean',
    'p50',
    'p95',
    'Witness',
    'Verify',
    'Proof B',
    'Peak MiB',
    'Prove/play',
    'r_max',
    'Valid',
  ];
  const rows = envs.flatMap((e) =>
    e.variants.map((a) =>
      h(
        'tr',
        {},
        h('td', {}, ENV_NAME[e.env]),
        h('td', {}, a.scheme === 'groth16' ? 'Groth16' : 'PLONK'),
        h('td', { class: 'num' }, String(a.windowTicks)),
        h('td', { class: 'num' }, fmt(a.constraints)),
        h('td', { class: 'num' }, `${fmt(a.proveMs.mean)} ms`),
        h('td', { class: 'num' }, fmt(a.proveMs.p50)),
        h('td', { class: 'num' }, fmt(a.proveMs.p95)),
        h('td', { class: 'num' }, `${fmt(a.witnessMs.mean)} ms`),
        h('td', { class: 'num' }, `${fmt(a.verifyMs.mean, 1)} ms`),
        h('td', { class: 'num' }, fmt(a.proofBytes)),
        h('td', { class: 'num' }, a.peakMemMb === null ? '—' : fmt(a.peakMemMb)),
        h('td', { class: 'num' }, `${fmt(a.proveToPlay, 2)}×`),
        h('td', { class: 'num' }, fmt(a.rMax, 3)),
        h('td', { class: 'num' }, `${a.valid}/${a.n}`),
      ),
    ),
  );
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'bench-table' },
      h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows),
    ),
  );
}

export function benchPage(onBack: () => void): { el: HTMLElement; dispose: () => void } {
  const charts: { destroy(): void }[] = [];
  let envs: EnvAggregates[] = [];
  let detection: DetectionCell[] = [];

  const status = h('p', { class: 'muted' }, 'Loading runs…');
  const selBrowser = h('select', { 'aria-label': 'Chrome run' });
  const selNode = h('select', { 'aria-label': 'Node run' });
  const csvBrowser = h('a', { class: 'button secondary', download: '' }, 'CSV (Chrome)');
  const csvNode = h('a', { class: 'button secondary', download: '' }, 'CSV (Node)');
  const pngBtn = h('button', { class: 'secondary' }, 'Export PNGs');
  const grid = h('div', { class: 'bench-grid' });
  const table = h('div', {});

  function draw(): void {
    charts.splice(0).forEach((c) => c.destroy());
    grid.replaceChildren();
    if (!envs.some((e) => e.variants.length)) {
      setText(
        status,
        'No benchmark runs yet — run `npm run bench:node -- --upload` or the browser runner below.',
      );
      table.replaceChildren();
      return;
    }
    setText(status, envs.map((e) => `${ENV_NAME[e.env]}: ${e.label}`).join(' · '));
    for (const [name, build] of Object.entries(CHARTS)) {
      const canvas = h('canvas', { role: 'img', 'aria-label': name });
      grid.append(h('div', { class: 'card chart-card' }, h('div', { class: 'chart-box' }, canvas)));
      charts.push(render(canvas, build(envs, DARK)));
    }
    table.replaceChildren(tableOf(envs));
  }

  async function loadRun(env: 'browser' | 'node', id: string): Promise<void> {
    const others = envs.filter((e) => e.env !== env);
    if (!id) {
      envs = others;
      return;
    }
    const r = await api.benchRun(id);
    const label = `${new Date(r.run.createdAt).toLocaleString()} · ${r.run.deviceLabel}`;
    envs = [...others, { env, label, variants: r.variants }].sort((a, b) =>
      a.env.localeCompare(b.env),
    );
    const link = env === 'browser' ? csvBrowser : csvNode;
    link.setAttribute('href', api.benchCsvUrl(id));
  }

  function fill(sel: HTMLSelectElement, runs: BenchRunMeta[]): void {
    sel.replaceChildren(
      h('option', { value: '' }, '— none —'),
      ...runs.map((r) =>
        h(
          'option',
          { value: r.id },
          `${new Date(r.createdAt).toLocaleString()} · ${r.deviceLabel} · ${r.samples ?? 0} samples`,
        ),
      ),
    );
    if (runs[0]) sel.value = runs[0].id;
  }

  async function init(): Promise<void> {
    try {
      const runs = await api.benchRuns();
      fill(
        selBrowser,
        runs.filter((r) => r.environment === 'browser'),
      );
      fill(
        selNode,
        runs.filter((r) => r.environment === 'node'),
      );
      await loadRun('browser', selBrowser.value);
      await loadRun('node', selNode.value);
      draw();
    } catch (e) {
      setText(status, `Could not load benchmark runs: ${String(e)}`);
    }
  }
  selBrowser.addEventListener('change', () => void loadRun('browser', selBrowser.value).then(draw));
  selNode.addEventListener('change', () => void loadRun('node', selNode.value).then(draw));

  function exportPngs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, build] of Object.entries(CHARTS))
      out[name] = toPng(build(envs, LIGHT), PNG_W, PNG_H);
    if (detection.length)
      out['detection-matrix'] = toPng(detectionMatrix(detection, LIGHT), PNG_W, PNG_H);
    return out;
  }
  pngBtn.addEventListener('click', () => {
    for (const [name, url] of Object.entries(exportPngs())) {
      const a = h('a', { href: url, download: `${name}.png` });
      a.click();
    }
  });

  // ---- runner
  const logBox = h('pre', { class: 'bench-log' });
  const checks = VARIANTS.map((v) => {
    const c = h('input', { type: 'checkbox', value: v, checked: v.startsWith('groth16') });
    return { v, c, label: h('label', { class: 'check' }, c, ` ${v}`) };
  });
  const runBtn = h('button', {}, 'Run benchmark in this browser');
  const tokenIn = h('input', {
    type: 'password',
    placeholder: 'BENCH_TOKEN (for upload)',
    autocomplete: 'off',
    'aria-label': 'Bench token',
  });
  const uploadBtn = h('button', { class: 'secondary', disabled: true }, 'Upload results');
  let last: BrowserBenchResult | null = null;
  const appendLog = (s: string): void => {
    logBox.textContent += `${s}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };
  async function runHere(
    variants: string[],
    samples?: number,
    warmups?: number,
  ): Promise<BrowserBenchResult> {
    runBtn.disabled = true;
    logBox.textContent = '';
    try {
      last = await runBrowserBench(variants, appendLog, samples, warmups);
      const variantsAgg: VariantAggregate[] = aggregate(last.runs.flatMap((r) => r.samples));
      envs = [
        ...envs.filter((e) => e.env !== 'browser'),
        { env: 'browser' as const, label: 'this browser (not uploaded)', variants: variantsAgg },
      ].sort((a, b) => a.env.localeCompare(b.env));
      draw();
      uploadBtn.disabled = false;
      return last;
    } finally {
      runBtn.disabled = false;
    }
  }
  runBtn.addEventListener('click', () => {
    void runHere(checks.filter((x) => x.c.checked).map((x) => x.v));
  });
  uploadBtn.addEventListener('click', () => {
    if (!last || !tokenIn.value) return toast('Enter the BENCH_TOKEN first.');
    const failures = last.runs.filter((r) => !r.ok).map((r) => `FAILED ${r.id}: ${r.error}`);
    void api
      .benchUpload(tokenIn.value, {
        environment: 'browser',
        deviceLabel: `${navigator.hardwareConcurrency} threads`,
        userAgent: last.userAgent,
        cpuThreads: last.cpuThreads,
        inputLog: last.inputLog,
        inputLogSha256: last.inputLogSha256,
        seed: last.seed,
        notes: failures.join('; ') || undefined,
        results: last.runs.flatMap((r) =>
          r.samples.map(({ startedAt: _s, endedAt: _e, ...s }) => s),
        ),
      })
      .then(() => {
        toast('Uploaded.');
        void init();
      })
      .catch((e: unknown) => toast(`Upload failed: ${String(e)}`));
  });

  // automation hooks (Playwright driver: run, then export PNGs incl. the detection matrix)
  (window as unknown as { __benchPage?: unknown }).__benchPage = {
    run: (variants: string[], samples?: number, warmups?: number) =>
      runHere(variants, samples, warmups),
    ready: () => init(),
    setDetection: (cells: DetectionCell[]) => (detection = cells),
    exportPngs,
  };

  const el = h(
    'main',
    { class: 'bench-page' },
    h(
      'div',
      { class: 'row bench-head' },
      h('h1', {}, 'Benchmarks'),
      h('button', { class: 'secondary', onclick: onBack }, 'Back to lobby'),
    ),
    status,
    h(
      'div',
      { class: 'row wrap' },
      h('label', { class: 'muted' }, 'Chrome run ', selBrowser),
      h('label', { class: 'muted' }, 'Node run ', selNode),
      csvBrowser,
      csvNode,
      pngBtn,
    ),
    grid,
    table,
    h(
      'div',
      { class: 'card stack' },
      h('h2', {}, 'Run in this browser'),
      h(
        'p',
        { class: 'muted' },
        'Same seeded input log as the Node runner; 2 warm-ups + 20 samples per variant. Keep this tab visible. PLONK zkeys are 1–4 GB.',
      ),
      h('div', { class: 'row wrap' }, ...checks.map((x) => x.label)),
      h('div', { class: 'row wrap' }, runBtn, tokenIn, uploadBtn),
      logBox,
    ),
  );
  void init();
  return {
    el,
    dispose: () => {
      charts.forEach((c) => c.destroy());
      delete (window as unknown as { __benchPage?: unknown }).__benchPage;
    },
  };
}
