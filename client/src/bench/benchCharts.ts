/**
 * /bench charts (UI_UX §3.5, Phase 5) with Chart.js. One builder per chart, parametrised by a
 * theme: the dark dashboard and the light, slide-readable PNG exports (white background).
 *
 * Encoding: colour = proving scheme (categorical slots 1–2, validated for CVD in both themes);
 * environment = line style + marker (Chrome solid ●, Node dotted ▲); grey dashed = reference
 * (play time per window, or r = 1). One y-axis per chart.
 */
import Chart from 'chart.js/auto';
import type { ChartConfiguration, ChartDataset, Plugin } from 'chart.js';
import type { VariantAggregate } from '@zkduel/shared/benchStats';
import { BENCH_WINDOW_TICKS, TICK_RATE, type Scheme } from '@zkduel/shared/constants';

export interface Theme {
  name: 'dark' | 'light';
  bg: string;
  text: string;
  muted: string;
  grid: string;
  scheme: Record<Scheme, string>;
  ref: string;
  /** Base font size (px). */
  font: number;
  line: number;
  point: number;
}

export const DARK: Theme = {
  name: 'dark',
  bg: '#161b22',
  text: '#e6edf3',
  muted: '#8b98a9',
  grid: '#2d3643',
  scheme: { groth16: '#3987e5', plonk: '#d95926' },
  ref: '#8b98a9',
  font: 12,
  line: 2,
  point: 4,
};

/** PNG exports: white background, larger type and marks for slides. */
export const LIGHT: Theme = {
  name: 'light',
  bg: '#ffffff',
  text: '#0b0b0b',
  muted: '#52514e',
  grid: '#e4e3df',
  scheme: { groth16: '#2a78d6', plonk: '#eb6834' },
  ref: '#52514e',
  font: 22,
  line: 3,
  point: 7,
};

export type Env = 'browser' | 'node';
export interface EnvAggregates {
  env: Env;
  label: string;
  variants: VariantAggregate[];
}

const SCHEME_LABEL: Record<Scheme, string> = { groth16: 'Groth16', plonk: 'PLONK' };
const ENV_LABEL: Record<Env, string> = { browser: 'Chrome', node: 'Node' };
const NS = [...BENCH_WINDOW_TICKS];
const nLabel = (n: number) => `N = ${n} (${n / TICK_RATE} s)`;

function alpha(hex: string, a: number): string {
  const v = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${v}`;
}

const background = (t: Theme): Plugin => ({
  id: 'bg',
  beforeDraw: (c) => {
    const { ctx } = c;
    ctx.save();
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  },
});

function base(t: Theme, title: string, subtitle: string, yTitle: string, log: boolean) {
  return {
    responsive: t.name === 'dark',
    maintainAspectRatio: false,
    animation: false as const,
    color: t.text,
    font: { size: t.font },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      title: {
        display: true,
        text: title,
        color: t.text,
        font: { size: t.font * 1.35, weight: 600 as const },
      },
      subtitle: {
        display: true,
        text: subtitle,
        color: t.muted,
        font: { size: t.font * 0.95 },
        padding: { bottom: t.font * 0.6 },
      },
      legend: {
        labels: {
          color: t.text,
          font: { size: t.font },
          usePointStyle: true,
          // band datasets (p5/p95) carry no identity of their own
          filter: (item: { text: string }) => !item.text.startsWith('_'),
        },
      },
      tooltip: { titleFont: { size: t.font }, bodyFont: { size: t.font } },
    },
    scales: {
      x: {
        ticks: { color: t.muted, font: { size: t.font } },
        grid: { color: t.grid },
        border: { color: t.grid },
      },
      y: {
        type: log ? ('logarithmic' as const) : ('linear' as const),
        title: { display: true, text: yTitle, color: t.muted, font: { size: t.font } },
        ticks: { color: t.muted, font: { size: t.font } },
        grid: { color: t.grid },
        border: { color: t.grid },
        ...(log ? {} : { beginAtZero: true }),
      },
    },
  };
}

function byN(v: VariantAggregate[], scheme: Scheme, pick: (a: VariantAggregate) => number) {
  return NS.map((n) => {
    const a = v.find((x) => x.scheme === scheme && x.windowTicks === n);
    return a ? pick(a) : null;
  });
}

function envStyle(env: Env, t: Theme) {
  return env === 'browser'
    ? { borderDash: [] as number[], pointStyle: 'circle' as const }
    : { borderDash: [t.line, t.line * 2], pointStyle: 'triangle' as const };
}

/** Chart 1: prove time vs N — median line, p5–p95 band, dashed play-time line. */
export function proveVsN(envs: EnvAggregates[], t: Theme): ChartConfiguration<'line'> {
  const datasets: ChartDataset<'line', (number | null)[]>[] = [];
  for (const e of envs) {
    for (const s of ['groth16', 'plonk'] as const) {
      if (!e.variants.some((v) => v.scheme === s)) continue;
      const c = t.scheme[s];
      const name = `${SCHEME_LABEL[s]} · ${ENV_LABEL[e.env]}`;
      datasets.push(
        {
          label: `_${name} p95`,
          data: byN(e.variants, s, (a) => a.proveMs.p95),
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: alpha(c, e.env === 'browser' ? 0.22 : 0.12),
          fill: '+1',
        },
        {
          label: `_${name} p5`,
          data: byN(e.variants, s, (a) => a.proveMs.p5),
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
        },
        {
          label: name,
          data: byN(e.variants, s, (a) => a.proveMs.p50),
          borderColor: c,
          backgroundColor: c,
          borderWidth: t.line,
          pointRadius: t.point,
          pointHoverRadius: t.point + 2,
          spanGaps: true,
          ...envStyle(e.env, t),
        },
      );
    }
  }
  datasets.push({
    label: 'Play time per window (N / 60 s)',
    data: NS.map((n) => (n / TICK_RATE) * 1000),
    borderColor: t.ref,
    backgroundColor: t.ref,
    borderDash: [t.line * 3, t.line * 2],
    borderWidth: t.line,
    pointRadius: 0,
  });
  return {
    type: 'line',
    data: { labels: NS.map(nLabel), datasets },
    options: base(
      t,
      'Prove time vs window size',
      'Median of 20 samples, band = p5–p95. Below the dashed line = proving keeps up with play.',
      'Prove time (ms, log scale)',
      true,
    ),
    plugins: [background(t)],
  };
}

/** Grouped bars by N, one bar per scheme × environment. */
function barsByN(
  envs: EnvAggregates[],
  t: Theme,
  pick: (a: VariantAggregate) => number,
  title: string,
  subtitle: string,
  yTitle: string,
  log: boolean,
  envsShown: Env[] = ['browser', 'node'],
): ChartConfiguration<'bar'> {
  const datasets: ChartDataset<'bar', (number | null)[]>[] = [];
  for (const s of ['groth16', 'plonk'] as const) {
    for (const e of envs.filter((x) => envsShown.includes(x.env))) {
      if (!e.variants.some((v) => v.scheme === s)) continue;
      const c = t.scheme[s];
      datasets.push({
        label: `${SCHEME_LABEL[s]} · ${ENV_LABEL[e.env]}`,
        data: byN(e.variants, s, pick),
        backgroundColor: e.env === 'browser' ? c : alpha(c, 0.35),
        borderColor: c,
        borderWidth: e.env === 'browser' ? 0 : t.line,
        borderRadius: 4,
        borderSkipped: 'start',
      });
    }
  }
  return {
    type: 'bar',
    data: { labels: NS.map(nLabel), datasets },
    options: base(t, title, subtitle, yTitle, log),
    plugins: [background(t)],
  };
}

export const proofSize = (envs: EnvAggregates[], t: Theme) =>
  barsByN(
    envs,
    t,
    (a) => a.proofBytes,
    'Proof size by scheme',
    'JSON bytes as sent on the wire (mean of 20); same in every environment.',
    'Proof size (bytes)',
    false,
    [envs.some((e) => e.env === 'browser') ? 'browser' : 'node'],
  );

export const verifyTime = (envs: EnvAggregates[], t: Theme) =>
  barsByN(
    envs,
    t,
    (a) => a.verifyMs.mean,
    'Verify time by scheme',
    'Mean of 20 (snarkjs; the server verifies Groth16 in Node worker threads).',
    'Verify time (ms)',
    false,
  );

/** Chart 4: r_max = window duration / mean prove time, with the r = 1 line. */
export function rMaxVsN(envs: EnvAggregates[], t: Theme): ChartConfiguration<'line'> {
  const datasets: ChartDataset<'line', (number | null)[]>[] = [];
  for (const e of envs) {
    for (const s of ['groth16', 'plonk'] as const) {
      if (!e.variants.some((v) => v.scheme === s)) continue;
      const c = t.scheme[s];
      datasets.push({
        label: `${SCHEME_LABEL[s]} · ${ENV_LABEL[e.env]}`,
        data: byN(e.variants, s, (a) => a.rMax),
        borderColor: c,
        backgroundColor: c,
        borderWidth: t.line,
        pointRadius: t.point,
        spanGaps: true,
        ...envStyle(e.env, t),
      });
    }
  }
  datasets.push({
    label: 'r = 1 (every window proven live)',
    data: NS.map(() => 1),
    borderColor: t.ref,
    backgroundColor: t.ref,
    borderDash: [t.line * 3, t.line * 2],
    borderWidth: t.line,
    pointRadius: 0,
  });
  return {
    type: 'line',
    data: { labels: NS.map(nLabel), datasets },
    options: base(
      t,
      'Max sustainable challenge rate r_max vs N',
      'r_max ≈ window duration / mean prove time: share of windows one prover can prove as fast as they are played.',
      'r_max (log scale)',
      true,
    ),
    plugins: [background(t)],
  };
}

export interface DetectionCell {
  cheat: string;
  m: number;
  runs: number;
  observedLive: number;
  predictedLive: number;
  audit: number;
}

/** Phase 4 detection matrix: observed live catch rate vs the 1 − (1 − r)^m bound, per cheat × m. */
export function detectionMatrix(cells: DetectionCell[], t: Theme): ChartConfiguration<'bar'> {
  const labels = cells.map((c) => [c.cheat.replace('_', ' '), `m = ${c.m}`]);
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Caught live (observed)',
          data: cells.map((c) => c.observedLive * 100),
          backgroundColor: t.scheme.groth16,
          borderRadius: 4,
          borderSkipped: 'start',
        },
        {
          label: '1 − (1 − r)^m (independent spot-check bound)',
          data: cells.map((c) => c.predictedLive * 100),
          backgroundColor: t.scheme.plonk,
          borderRadius: 4,
          borderSkipped: 'start',
        },
      ],
    },
    options: {
      ...base(
        t,
        'Detection: caught live vs predicted (Node bots, 10 matches per cell)',
        'm = windows the cheat was on. The post-match audit caught 100 % in every cell; smooth-aim (legal) was never flagged.',
        'Matches caught live (%)',
        false,
      ),
      scales: {
        ...base(t, '', '', 'Matches caught live (%)', false).scales,
        y: {
          ...base(t, '', '', 'Matches caught live (%)', false).scales.y,
          max: 100,
        },
      },
    },
    plugins: [background(t)],
  };
}

export function render(canvas: HTMLCanvasElement, cfg: ChartConfiguration): Chart {
  return new Chart(canvas, cfg);
}

/** Render a config off-screen at a fixed size and return a PNG data URL. */
export function toPng(cfg: ChartConfiguration, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:fixed;left:-99999px;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const chart = new Chart(canvas, {
    ...cfg,
    options: { ...cfg.options, responsive: false, devicePixelRatio: 1 },
  } as ChartConfiguration);
  const url = chart.toBase64Image('image/png');
  chart.destroy();
  canvas.remove();
  return url;
}
