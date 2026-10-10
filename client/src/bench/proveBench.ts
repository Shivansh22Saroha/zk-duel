/**
 * Dev-only browser proving bench (bench.html): proves real windows from the committed Phase 1
 * fixture logs in the Proof Worker while the main thread keeps rendering the arena, and measures
 * witness / prove time and main-thread frame time while proving.
 *
 *   /bench.html?variant=groth16_60&count=10&warmup=1&threads=default|single|<n>
 *
 * Results land on window.__bench (read by client/scripts/perf-prove.ts) and in a table.
 * Not the Phase 5 /bench runner — no upload, no DB.
 */
import '../styles.css';
import { ARENA_H, ARENA_W, TICK_RATE } from '@zkduel/shared/constants';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import {
  buildWindowInput,
  namePublicSignals,
  sliceLogWindows,
  testSalt,
  type CircuitInput,
  type PublicValues,
} from '@zkduel/shared/zkInput';
import { FrameStats } from '../game/frameStats';
import { createRenderer } from '../game/renderer';
import type { RenderFrame } from '../game/view';
import { loadArtefacts, type VariantMeta } from '../zk/artefacts';
import type { ThreadSetting, WorkerRequest, WorkerResponse } from '../zk/proofWorker';

const q = new URLSearchParams(location.search);
const variant = q.get('variant') ?? 'groth16_60';
const count = Number(q.get('count') ?? 10);
const warmup = Number(q.get('warmup') ?? 1);
const threadsParam = q.get('threads') ?? 'default';
const threads: ThreadSetting =
  threadsParam === 'default' || threadsParam === 'single' ? threadsParam : Number(threadsParam);
const BASELINE_MS = 3000;

interface Sample {
  window: string;
  witnessMs: number;
  proveMs: number;
  threads: number;
  signalsMatch: boolean;
}
type FrameSummary = ReturnType<FrameStats['summary']>;
export interface BenchResult {
  variant: string;
  threadsSetting: ThreadSetting;
  hardwareConcurrency: number;
  workerHardwareConcurrency: number;
  constraints: number;
  artefactsCached: boolean;
  loadMs: number;
  warmup: Sample[];
  samples: Sample[];
  frameIdle: FrameSummary;
  frameProving: FrameSummary;
  provingWallMs: number;
  userAgent: string;
  visibility: DocumentVisibilityState;
  hiddenDuringRun: boolean;
}

const status = document.createElement('pre');
status.style.cssText =
  'padding:12px;margin:0;font:13px ui-monospace,monospace;white-space:pre-wrap';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:100%;height:60vh;display:block';
(document.getElementById('app') as HTMLElement).append(canvas, status);
const log = (s: string): void => {
  status.textContent += s + '\n';
};
let hiddenDuringRun = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenDuringRun = true;
});

// ---------------------------------------------------------------- synthetic arena (render load)
const renderer = createRenderer(canvas);
const stats = new FrameStats();
let frameNo = 0;
function scene(now: number): RenderFrame {
  const t = now / 1000;
  const p = (i: 0 | 1, phase: number) => ({
    index: i,
    x: ARENA_W / 2 + Math.cos(t * 0.7 + phase) * 350,
    y: ARENA_H / 2 + Math.sin(t * 1.1 + phase) * 200,
    angle: (((t * 600 + phase * 573) % 3600) + 3600) % 3600,
    hp: 75,
    isSelf: i === 0,
    flashing: frameNo % 90 < 4,
  });
  const players: RenderFrame['players'] = [p(0, 0), p(1, Math.PI)];
  const shooter = players[frameNo % 2 === 0 ? 0 : 1];
  return {
    arena: { width: ARENA_W, height: ARENA_H },
    players,
    tracers:
      frameNo % 12 === 0 && shooter
        ? [{ x: shooter.x, y: shooter.y, angle: shooter.angle, player: shooter.index }]
        : [],
    phase: 'live',
  };
}
function frame(now: number): void {
  requestAnimationFrame(frame);
  stats.frame(now);
  const t0 = performance.now();
  frameNo++;
  renderer.resize();
  renderer.draw(scene(now));
  stats.addWork(performance.now() - t0);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- inputs from real logs
async function fixtureWindows(
  n: number,
  want: number,
): Promise<{ name: string; input: CircuitInput; expected: PublicValues }[]> {
  const names = (await (await fetch('/__dev/fixtures/')).json()) as string[];
  const perLog = await Promise.all(
    names.map(async (name) => {
      const text = await (await fetch(`/__dev/fixtures/${name}`)).text();
      const lines = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TickLogLine);
      return sliceLogWindows(lines, n, testSalt(7)).map((w) => ({ name, w }));
    }),
  );
  // round-robin over logs so samples come from different matches/players
  const picked: { name: string; w: (typeof perLog)[number][number]['w'] }[] = [];
  for (let i = 0; picked.length < want; i++) {
    let any = false;
    for (const l of perLog) {
      const e = l[i];
      if (e && picked.length < want) {
        picked.push(e);
        any = true;
      }
    }
    if (!any) break;
  }
  return Promise.all(
    picked.map(async ({ name, w }) => ({
      name: `${name}#r${w.ctx.roundNo}w${w.ctx.windowIndex}`,
      ...(await buildWindowInput(w.ctx, w.records)),
    })),
  );
}

// ---------------------------------------------------------------- run
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<BenchResult> {
  log(`variant ${variant}, ${count} samples + ${warmup} warm-up, threads=${threadsParam}`);
  const info = (await (await fetch(`/zk/${variant}/info.json`)).json()) as {
    constraints: number;
    windowTicks: number;
    zkeySha256: string;
    wasmSha256: string;
    zkeyBytes: number;
    publicSignalOrder: VariantMeta['publicSignalOrder'];
  };
  const meta: VariantMeta = {
    id: variant,
    scheme: 'groth16',
    windowTicks: info.windowTicks,
    constraints: info.constraints,
    zkeyUrl: `/zk/${variant}/window_final.zkey`,
    wasmUrl: `/zk/${variant}/window.wasm`,
    zkeySha256: info.zkeySha256,
    wasmSha256: info.wasmSha256,
    zkeyBytes: info.zkeyBytes,
    publicSignalOrder: info.publicSignalOrder,
  };
  const tl = performance.now();
  const art = await loadArtefacts(meta);
  const loadMs = performance.now() - tl;
  log(
    `artefacts ${art.cached ? 'from cache' : 'downloaded'} + sha256 ok in ${loadMs.toFixed(0)} ms`,
  );
  const windows = await fixtureWindows(info.windowTicks, count + warmup);
  log(`${windows.length} real windows built (N=${info.windowTicks})`);

  const worker = new Worker(new URL('../zk/proofWorker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, (r: WorkerResponse) => void>();
  let ready: (hc: number) => void = () => undefined;
  const readyP = new Promise<number>((r) => (ready = r));
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (m.t === 'ready') ready(m.hardwareConcurrency);
    else pending.get(m.id)?.(m);
  };
  worker.onerror = (e) => {
    log(`worker error: ${e.message}`);
    out.__bench = { done: true, error: `worker error: ${e.message}` };
  };
  const req = (m: WorkerRequest, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  req({ t: 'init', wasm: art.wasm, zkey: art.zkey, threads }, [art.wasm, art.zkey]);
  const workerHc = await readyP;

  let nextId = 1;
  const prove = (w: (typeof windows)[number]): Promise<Sample> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (r) => {
        pending.delete(id);
        if (r.t !== 'proved') return reject(new Error(r.t === 'failed' ? r.reason : r.t));
        const named = namePublicSignals(meta.publicSignalOrder, r.publicSignals);
        resolve({
          window: w.name,
          witnessMs: r.witnessMs,
          proveMs: r.proveMs,
          threads: r.threads,
          signalsMatch: (['bind', 'digest', 'commitIn', 'commitOut'] as const).every(
            (k) => named[k] === w.expected[k],
          ),
        });
      });
      req({ t: 'prove', id, input: w.input });
    });

  // idle baseline (same render loop, no proving)
  stats.reset();
  await sleep(BASELINE_MS);
  const frameIdle = stats.summary();

  const warm: Sample[] = [];
  for (const w of windows.slice(0, warmup)) {
    warm.push(await prove(w));
    log(
      `warm-up ${w.name}: witness ${warm.at(-1)?.witnessMs.toFixed(0)} ms, prove ${warm.at(-1)?.proveMs.toFixed(0)} ms`,
    );
  }
  stats.reset();
  const t0 = performance.now();
  const samples: Sample[] = [];
  for (const w of windows.slice(warmup)) {
    const s = await prove(w);
    samples.push(s);
    log(
      `${samples.length}/${count} ${s.window}: witness ${s.witnessMs.toFixed(0)} ms, prove ${s.proveMs.toFixed(0)} ms, threads ${s.threads}, signals ${s.signalsMatch ? 'ok' : 'MISMATCH'}`,
    );
  }
  const provingWallMs = performance.now() - t0;
  const frameProving = stats.summary();
  worker.terminate();
  const window60 = info.windowTicks / TICK_RATE;
  const pct = (a: number[], p: number) => FrameStats.pct(a, p);
  const pr = samples.map((s) => s.proveMs);
  const wi = samples.map((s) => s.witnessMs);
  log(
    `\nwitness p50 ${pct(wi, 0.5).toFixed(0)} / p95 ${pct(wi, 0.95).toFixed(0)} ms; prove p50 ${pct(pr, 0.5).toFixed(0)} / p95 ${pct(pr, 0.95).toFixed(0)} ms; window = ${(window60 * 1000).toFixed(0)} ms of play`,
  );
  log(
    `frame interval idle p50 ${frameIdle.intervalP50.toFixed(1)} p95 ${frameIdle.intervalP95.toFixed(1)} ms; proving p50 ${frameProving.intervalP50.toFixed(1)} p95 ${frameProving.intervalP95.toFixed(1)} max ${frameProving.intervalMax.toFixed(0)} ms`,
  );
  return {
    variant,
    threadsSetting: threads,
    hardwareConcurrency: navigator.hardwareConcurrency,
    workerHardwareConcurrency: workerHc,
    constraints: info.constraints,
    artefactsCached: art.cached,
    loadMs,
    warmup: warm,
    samples,
    frameIdle,
    frameProving,
    provingWallMs,
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
    hiddenDuringRun,
  };
}

const out = window as unknown as {
  __bench?: { done: boolean; result?: BenchResult; error?: string };
};
out.__bench = { done: false };
run()
  .then((result) => (out.__bench = { done: true, result }))
  .catch((e: unknown) => {
    log(`ERROR ${String(e)}`);
    out.__bench = { done: true, error: String(e) };
  });
