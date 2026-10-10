/**
 * App controller + tiny router: `/`, `/match/:id`, `/match/:id/results`.
 * Flow 1 (USER_FLOWS): landing → guest auth → WS hello → queue (proving key preloads) → match →
 * results (+ post-match audit). Flow 5: auto-reconnect with resume.
 */
import './styles.css';
import { RECONNECT_BACKOFF_MS, RECONNECT_TIMEOUT_MS } from '@zkduel/shared/constants';
import { constantsHash } from '@zkduel/shared/canonical';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { api, ApiError, session, type CircuitInfo } from './api';
import { ENV } from './env';
import { BotInput } from './game/bot';
import { FrameStats } from './game/frameStats';
import { KeyboardMouseInput } from './game/input';
import { GameSession, type InputContext, type InputSource } from './game/session';
import { MemoryTickLog } from './game/tickLog';
import { Net } from './net/socket';
import { toast } from './ui/dom';
import { matchScreen } from './ui/matchScreen';
import { landingScreen, queueScreen, resultsScreen } from './ui/screens';
import { ArtefactIntegrityError, loadArtefacts, type VariantMeta } from './zk/artefacts';
import { ProofClient, type ProveOutcome, type Prover } from './zk/proofClient';
import type { WindowJob } from './zk/recorder';
import { WorkerProver } from './zk/workerProver';

const root = document.getElementById('app') as HTMLElement;
const params = new URLSearchParams(location.search);
/** Dev-only automation (perf measurement / smoke tests): `?bot=<seed>[&acc=<jitter>]` plays with BotInput. */
const botSeed = import.meta.env.DEV && params.has('bot') ? Number(params.get('bot')) || 1 : null;
const botAccuracy = params.has('acc') ? Number(params.get('acc')) : undefined;
/** Dev-only experiment: cap snarkjs threads (`?threads=6`), e.g. two clients on one machine. */
const proverThreads =
  import.meta.env.DEV && params.has('threads')
    ? Number(params.get('threads')) || 'default'
    : 'default';

/** Lets the session be created before the canvas (and its input) exists. */
class InputProxy implements InputSource {
  inner: InputSource | null = null;
  sample(ctx: InputContext) {
    return (
      this.inner?.sample(ctx) ?? {
        moveX: 0,
        moveY: 0,
        aimTarget: ctx.self.pub.angle,
        fire: false,
        reload: false,
      }
    );
  }
}

/** Prover whose Web Worker starts once the (cached, hash-checked) artefacts are available. */
class LazyProver implements Prover {
  inner: WorkerProver | null = null;
  constructor(private readonly ready: Promise<WorkerProver>) {
    void ready.then((p) => (this.inner = p)).catch(() => undefined);
  }
  async prove(job: WindowJob): Promise<ProveOutcome> {
    try {
      return await (await this.ready).prove(job);
    } catch (e) {
      return { ok: false, reason: `proving key unavailable: ${String(e).slice(0, 120)}` };
    }
  }
  dispose(): void {
    this.inner?.dispose();
    void this.ready.then((p) => p.dispose()).catch(() => undefined);
  }
}

const state = {
  hash: '',
  info: null as CircuitInfo | null,
  versionError: null as string | null,
  net: null as Net | null,
  token: null as string | null,
  game: null as GameSession | null,
  proof: null as ProofClient | null,
  prover: null as LazyProver | null,
  input: new InputProxy(),
  kbm: null as KeyboardMouseInput | null,
  tickLog: ENV.LOG_TICKS ? new MemoryTickLog() : null,
  stats: new FrameStats(),
  names: ['', ''] as [string, string],
  dispose: null as (() => void) | null,
  /** Artefact download started at queue time (Flow 1 step 3). */
  preload: null as {
    id: string;
    promise: Promise<{ wasm: ArrayBuffer; zkey: ArrayBuffer }>;
  } | null,
  loadProgress: 0,
  reconnecting: false,
};

if (ENV.SHOW_DEBUG || import.meta.env.DEV) {
  Object.assign(window, {
    __zkd: {
      stats: () => state.stats.summary(),
      resetStats: () => state.stats.reset(),
      game: () => state.game,
      proof: () => {
        const p = state.proof;
        if (!p) return null;
        const me = state.game?.playerIndex ?? 0;
        return {
          auditing: p.auditing,
          auditDone: p.auditDone,
          auditStatus: p.auditStatus,
          overturned: p.overturned,
          auditTotal: p.auditTotal,
          auditProven: p.auditProven,
          spot: [p.spotChecks(0), p.spotChecks(1)],
          me,
          lastProveMs: p.lastProveMs,
          lastWitnessMs: p.lastWitnessMs,
          warmupMs: state.prover?.inner?.warmupMs ?? null,
        };
      },
    },
  });
}

function mount(el: HTMLElement, dispose: (() => void) | null = null): void {
  state.dispose?.();
  state.dispose = dispose;
  root.replaceChildren(el);
}

function go(path: string): void {
  history.pushState(null, '', path + location.search);
  route();
}
window.addEventListener('popstate', () => route());

function teardownMatch(): void {
  state.kbm?.dispose();
  state.kbm = null;
  state.input.inner = null;
  state.proof?.dispose();
  state.proof = null;
  const net = state.net;
  state.net = null;
  net?.close();
  state.game = null;
}

function route(): void {
  const path = location.pathname;
  const results = /^\/match\/([^/]+)\/results$/.exec(path);
  const match = /^\/match\/([^/]+)$/.exec(path);
  if (results) return void showResults(decodeURIComponent(results[1] as string));
  if (match) {
    if (state.game?.match?.matchId === match[1]) return showMatch();
    return go('/'); // a reload loses the in-memory windows: no rejoin after a page reload
  }
  showLanding();
}

function showLanding(): void {
  teardownMatch();
  mount(
    landingScreen({
      initialName: session.name ?? '',
      versionError: state.versionError,
      onFindMatch: (name) => void findMatch(name),
    }),
  );
  if (botSeed !== null) void findMatch(`bot_${botSeed}_${Math.floor(Math.random() * 1000)}`);
}

function variantMeta(id: string): VariantMeta | null {
  return state.info?.variants.find((v) => v.id === id) ?? null;
}

/** Start (or reuse) the download + SHA-256 check of a variant's wasm + zkey. */
function preload(id: string): Promise<{ wasm: ArrayBuffer; zkey: ArrayBuffer }> {
  if (state.preload?.id === id) return state.preload.promise;
  const v = variantMeta(id);
  const promise = v
    ? loadArtefacts(v, (f) => (state.loadProgress = f))
    : Promise.reject(new Error(`variant ${id} is not published by the server`));
  promise.catch(() => undefined);
  state.preload = { id, promise };
  return promise;
}

async function findMatch(name: string): Promise<void> {
  try {
    let token = session.name === name ? session.token : null;
    if (!token) {
      const g = await api.guest(name);
      token = g.token;
      session.save(token, name);
    }
    state.token = token;
    const net = new Net();
    const game = new GameSession(net, state.input, {
      now: () => performance.now(),
      constantsHash: state.hash,
      log: state.tickLog ?? undefined,
    });
    state.net = net;
    state.game = game;
    state.names = ['', ''];
    net.onMessage = (m) => onServer(m, name);
    net.onClose = (code) => onNetClose(net, code);
    try {
      await net.connect(token, state.hash);
    } catch (e) {
      if (e instanceof Error && e.message === 'UNAUTHORIZED') {
        session.clear();
        toast('Session expired — please enter your name again.');
      } else toast(e instanceof Error ? e.message : 'Connection failed.');
      return showLanding();
    }
    if (state.info) state.preload = null; // re-check the cache for every match (cheap when cached)
    if (state.info) void preload(state.info.active);
    const q = queueScreen(
      () => {
        net.send({ t: 'queue_leave' });
        showLanding();
      },
      () => state.loadProgress,
    );
    mount(q.el, q.dispose);
    net.send({ t: 'queue_join' });
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not reach the server.');
  }
}

/** Unexpected socket close during a match or its audit → reconnect (Flow 5). */
function onNetClose(net: Net, code: number): void {
  if (state.net !== net || state.reconnecting) return;
  const game = state.game;
  const inMatch = game !== null && game.phase !== 'idle' && game.phase !== 'ended';
  const auditing = state.proof?.auditing === true;
  if ((inMatch || auditing) && ![4400, 4401, 4409, 4429].includes(code)) {
    void reconnect(net);
    return;
  }
  if (game?.phase !== 'ended' && !auditing) {
    toast(code === 4409 ? 'Connected in another tab.' : `Disconnected (${code}).`);
    go('/');
  }
}

async function reconnect(net: Net): Promise<void> {
  state.reconnecting = true;
  toast('Connection lost — reconnecting…');
  const t0 = performance.now();
  for (let i = 0; performance.now() - t0 < RECONNECT_TIMEOUT_MS; i++) {
    const delay = RECONNECT_BACKOFF_MS[Math.min(i, RECONNECT_BACKOFF_MS.length - 1)] as number;
    await new Promise((r) => setTimeout(r, delay));
    if (state.net !== net) break;
    try {
      await net.connect(state.token as string, state.hash);
      state.reconnecting = false;
      state.proof?.onReconnected();
      toast('Reconnected.');
      return;
    } catch {
      // next attempt
    }
  }
  state.reconnecting = false;
  if (state.net === net) {
    toast('Could not reconnect.');
    if (state.game?.phase !== 'ended') go('/');
  }
}

function onServer(m: ServerMessage, myName: string): void {
  const game = state.game;
  if (!game) return;
  game.handle(m);
  switch (m.t) {
    case 'match_found': {
      state.names = m.playerIndex === 0 ? [myName, m.opponentName] : [m.opponentName, myName];
      const v = variantMeta(m.variant);
      const art = preload(m.variant);
      const prover = new LazyProver(
        art.then((a) => new WorkerProver(a.wasm, a.zkey, proverThreads, m.windowTicks)),
      );
      state.proof?.dispose();
      state.prover = prover;
      state.proof = new ProofClient(game, {
        send: (x) => state.net?.send(x),
        prover,
        scheme: m.scheme,
        now: () => performance.now(),
        log: state.tickLog ?? undefined,
      });
      art.then(
        () => {
          // the buffers were transferred to the worker; the next match reloads from the cache
          state.preload = null;
          if (v) game.sendReady(v.zkeySha256);
        },
        (e: unknown) => {
          toast(
            e instanceof ArtefactIntegrityError
              ? 'Proving key corrupted — retry download.'
              : `Could not load the proving key: ${String(e)}`,
            8000,
          );
        },
      );
      go(`/match/${m.matchId}`);
      break;
    }
    case 'match_end':
      state.kbm?.dispose();
      state.kbm = null;
      setTimeout(() => go(m.resultsUrl), 1200);
      break;
    case 'audit_end':
      // results page re-reads the stored summary (final numbers)
      if (location.pathname.endsWith('/results')) setTimeout(() => route(), 300);
      break;
    case 'error':
      if (m.code === 'VERSION_MISMATCH')
        state.versionError = 'Client and server versions differ. Refresh.';
      toast(m.message);
      break;
    default:
      break;
  }
}

function showMatch(): void {
  const game = state.game as GameSession;
  const ms = matchScreen({
    game,
    names: state.names,
    input: null,
    stats: state.stats,
    showDebug: ENV.SHOW_DEBUG,
    rtt: () => state.net?.rttMs ?? 0,
    onForfeit: () => state.net?.send({ t: 'forfeit' }),
    proof: state.proof,
    afterUpdate: () => state.proof?.poll(),
  });
  mount(ms.el, ms.dispose);
  if (botSeed !== null) {
    state.input.inner = new BotInput(botSeed, botAccuracy);
    // dev-only: `&stopAfter=<s>` forfeits after that much play — a match of a fixed length
    const stopAfter = Number(params.get('stopAfter'));
    if (stopAfter > 0) {
      setTimeout(() => {
        if (state.game === game && game.phase !== 'ended') state.net?.send({ t: 'forfeit' });
      }, stopAfter * 1000);
    }
  } else {
    state.kbm = new KeyboardMouseInput(ms.canvas);
    state.input.inner = state.kbm;
  }
  state.stats.reset();
}

async function showResults(id: string): Promise<void> {
  const token = session.token;
  if (!token) return go('/');
  try {
    const summary = await api.match(id, token);
    const log = state.tickLog;
    const hasLog = log !== null && log.lines.some((l) => l.type === 'header' && l.matchId === id);
    const proof = state.game?.match?.matchId === id ? state.proof : null;
    // keep committing the final window and proving the audit while this page is open
    const pump = window.setInterval(() => proof?.poll(), 50);
    const r = resultsScreen({
      summary,
      proof,
      onLobby: () => {
        if (proof?.auditing && !confirm('Stop the audit? Remaining windows will be unaudited.'))
          return;
        go('/');
      },
      onDownloadTickLog: hasLog ? () => log.download() : null,
    });
    mount(r.el, () => {
      clearInterval(pump);
      r.dispose();
    });
    if (!proof) state.net?.close();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not load results.');
    go('/');
  }
}

async function boot(): Promise<void> {
  state.hash = await constantsHash();
  try {
    const info = await api.circuitInfo();
    state.info = info;
    if (info.constantsHash !== state.hash)
      state.versionError = 'Client and server versions differ. Refresh.';
  } catch {
    state.versionError = `Cannot reach the server at ${ENV.API_URL}.`;
  }
  route();
}

void boot();
