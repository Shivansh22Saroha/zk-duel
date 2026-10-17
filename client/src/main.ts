/**
 * App controller + tiny router: `/`, `/match/:id`, `/match/:id/results`, `/bench`.
 * Flow 1 (USER_FLOWS): landing → guest auth → WS hello → queue (proving key preloads) → match →
 * results (+ post-match audit). Flow 5: auto-reconnect with resume.
 */
// Self-hosted fonts (bundled by Vite): the game must work without internet (viva room, LAN).
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/500.css';
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
import { landingScreen, queueScreen, resultsScreen, roomScreen } from './ui/screens';
import { ArtefactIntegrityError, loadArtefacts, type VariantMeta } from './zk/artefacts';
import { AuditResumer } from './zk/auditResumer';
import { IndexedDbAuditStore } from './zk/auditStore';
import { ProofClient, type ProveOutcome, type Prover } from './zk/proofClient';
import type { WindowJob } from './zk/recorder';
import { WorkerProver } from './zk/workerProver';
import type { CheatName } from '@zkduel/shared/protocol';
import type { Cheats } from './game/cheats';
import type * as CheatsModule from './game/cheats';
import type * as CheatPanelModule from './ui/cheatPanel';
import type { GameRenderer } from './game/view';

/**
 * Dev cheats (FEATURES F13) exist only in builds with VITE_DEV_CHEATS=true: this is a compile-time
 * constant, so the dynamic imports below (and the whole cheat module) are dropped otherwise.
 */
const CHEATS_BUILT = import.meta.env.VITE_DEV_CHEATS === 'true';
type CheatMods = {
  Cheats: typeof CheatsModule.Cheats;
  cheatPanel: typeof CheatPanelModule.cheatPanel;
};
let cheatMods: CheatMods | null = null;

/** 3D renderer (Phase 4.5) unless `?renderer=2d`; loaded lazily so the 2D path never pulls in three.js. */
type MakeRenderer = (canvas: HTMLCanvasElement) => GameRenderer;
let make3d: MakeRenderer | null = null;
async function loadRenderer(): Promise<void> {
  if (new URLSearchParams(location.search).get('renderer') === '2d') return;
  try {
    make3d = (await import('./game/renderer3d')).createThreeRenderer;
  } catch {
    make3d = null; // Canvas 2D fallback
  }
}
async function loadCheatMods(): Promise<void> {
  if (!CHEATS_BUILT || cheatMods) return;
  const [c, p] = await Promise.all([import('./game/cheats'), import('./ui/cheatPanel')]);
  cheatMods = { Cheats: c.Cheats, cheatPanel: p.cheatPanel };
}

const root = document.getElementById('app') as HTMLElement;
/** Dev server, or the `--mode perf` production build used by the Playwright perf runs. */
const automation = import.meta.env.DEV || import.meta.env.VITE_PERF_AUTOMATION === 'true';
const params = new URLSearchParams(location.search);
/** Dev-only automation (perf measurement / smoke tests): `?bot=<seed>[&acc=<jitter>]` plays with BotInput. */
const botSeed = automation && params.has('bot') ? Number(params.get('bot')) || 1 : null;
const botAccuracy = params.has('acc') ? Number(params.get('acc')) : undefined;
/** Dev-only experiment: cap snarkjs threads (`?threads=6`), e.g. two clients on one machine. */
const proverThreads =
  automation && params.has('threads') ? Number(params.get('threads')) || 'default' : 'default';

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
  store: null as IndexedDbAuditStore | null,
  /** An audit resumed after a page reload (IndexedDB). */
  resumer: null as AuditResumer | null,
  cheats: null as Cheats | null,
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

if (ENV.SHOW_DEBUG || automation) {
  Object.assign(window, {
    __zkd: {
      stats: () => state.stats.summary(),
      resetStats: () => state.stats.reset(),
      /** Dev cheat builds only: switch a cheat exactly like the F9 drawer does. */
      cheat: (c: CheatName, on: boolean) => toggleCheat(c, on),
      /** VITE_LOG_TICKS builds: this player's own tick log (stays in the browser). */
      tickLog: () => state.tickLog?.lines ?? null,
      game: () => state.game,
      proof: () => {
        const r = state.resumer;
        if (r) {
          return {
            resumed: true,
            auditing: r.auditing,
            auditDone: r.auditDone,
            auditStatus: r.auditStatus,
            overturned: r.overturned,
            auditTotal: r.auditTotal,
            auditProven: r.auditProven,
            lastProveMs: r.lastProveMs,
          };
        }
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
  state.resumer?.dispose();
  state.resumer = null;
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
  if (path === '/bench') return void showBench();
  if (match) {
    if (state.game?.match?.matchId === match[1]) return showMatch();
    return go('/'); // a reload loses the in-memory windows: no rejoin after a page reload
  }
  showLanding();
}

/** Benchmarks page (lazy: Chart.js and the bench runner stay out of the game bundle). */
async function showBench(): Promise<void> {
  teardownMatch();
  const { benchPage } = await import('./ui/benchPage');
  const p = benchPage(() => go('/'));
  mount(p.el, p.dispose);
}

function showLanding(): void {
  teardownMatch();
  mount(
    landingScreen({
      initialName: session.name ?? '',
      versionError: state.versionError,
      onFindMatch: (name) => void findMatch(name),
      onCreateRoom: (name, enforcement) => void findMatch(name, { create: enforcement }),
      onBench: () => go('/bench'),
      onJoinRoom: (name, code) => void findMatch(name, { join: code }),
    }),
  );
  // `&manual=1`: the bot plays, but the lobby (queue / private room) is driven through the UI
  if (botSeed !== null && !params.has('manual')) {
    void findMatch(`bot_${botSeed}_${Math.floor(Math.random() * 1000)}`);
  }
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

/** Queue (default), or a private room: create one with an enforcement, or join one by code. */
type MatchWay = { create: 'observe' | 'strict' } | { join: string } | null;

async function findMatch(name: string, way: MatchWay = null): Promise<void> {
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
      tamper: CHEATS_BUILT
        ? (ctx, s, prev, input) => (state.cheats ? state.cheats.apply(ctx, s, prev, input) : s)
        : undefined,
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
    if (way) {
      // private room (F3): the creator gets a code from REST, then BOTH players send room_join
      let code: string;
      if ('create' in way) {
        try {
          code = (await api.createRoom(token, way.create)).roomCode;
        } catch (e) {
          toast(e instanceof ApiError ? e.message : 'Could not create the room.');
          return showLanding();
        }
      } else code = way.join;
      const q = roomScreen(
        code,
        'create' in way,
        () => showLanding(),
        () => state.loadProgress,
      );
      mount(q.el, q.dispose);
      net.send({ t: 'room_join', roomCode: code });
      return;
    }
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
  console.warn(`[net] socket closed (${code}), phase ${state.game?.phase ?? 'none'}`);
  const game = state.game;
  const inMatch = game !== null && game.phase !== 'idle' && game.phase !== 'ended';
  const auditing = state.proof?.auditing === true || state.resumer?.auditing === true;
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
      state.resumer?.onReconnected();
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
      state.cheats = cheatMods ? new cheatMods.Cheats(m.playerIndex) : null;
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
        store: state.store,
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
      // a failed room_join (unknown / expired / full room): back to the landing page
      if (m.code === 'ROOM_NOT_FOUND' || m.code === 'ROOM_FULL') showLanding();
      break;
    default:
      break;
  }
}

/** F9 drawer / dev hook: switch a cheat locally and tell the server (cheat_events, cheat_flag). */
function toggleCheat(c: CheatName, on: boolean): void {
  const game = state.game;
  if (!state.cheats || !game) return;
  state.cheats.set(c, on);
  state.net?.send({ t: 'cheat_toggle', cheat: c, enabled: on, tick: Math.max(0, game.tick + 1) });
}

function showMatch(): void {
  const game = state.game as GameSession;
  const drawer =
    cheatMods && state.cheats
      ? cheatMods.cheatPanel(state.cheats, (c, on) => toggleCheat(c, on))
      : null;
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
    cheatDrawer: drawer?.el ?? null,
    makeRenderer: make3d ?? undefined,
  });
  mount(ms.el, () => {
    ms.dispose();
    drawer?.dispose();
  });
  if (botSeed !== null) {
    state.input.inner = new BotInput(
      botSeed,
      botAccuracy,
      Number(params.get('miss')) || 0,
      // dev-only: `&fpmove=1` — the bot moves with first-person (facing-relative) WASD
      params.has('fpmove'),
    );
    // dev-only: `&stopAfter=<s>` forfeits after that much play — a match of a fixed length
    const stopAfter = Number(params.get('stopAfter'));
    if (stopAfter > 0) {
      setTimeout(() => {
        if (state.game === game && game.phase !== 'ended') state.net?.send({ t: 'forfeit' });
      }, stopAfter * 1000);
    }
  } else {
    state.kbm = new KeyboardMouseInput(ms.canvas);
    state.kbm.viewRelative = ms.isFirstPerson;
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
    const proof =
      state.game?.match?.matchId === id
        ? state.proof
        : state.resumer?.matchId === id
          ? state.resumer
          : null;
    // keep committing the final window and proving the audit while this page is open
    const pump = window.setInterval(
      () => (proof === state.proof ? state.proof?.poll() : undefined),
      50,
    );
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

/**
 * After a page reload: if IndexedDB holds unproven windows of a match whose audit is still open,
 * reconnect and finish proving them (Phase 3 follow-up). Returns true when an audit was resumed.
 */
async function resumeAudit(): Promise<boolean> {
  const store = state.store;
  const token = session.token;
  if (!store || !token) return false;
  const u = await store.unfinishedAudit(Date.now());
  if (!u) return false;
  const id = u.match.matchId;
  try {
    const summary = await api.match(id, token);
    if (summary.auditStatus !== 'auditing') {
      store.deleteMatch(id); // the audit already closed
      return false;
    }
    const { windows } = await api.windows(id, token);
    const v = variantMeta(u.match.variant);
    if (!v) return false;
    const prover = new LazyProver(
      loadArtefacts(v).then((a) => new WorkerProver(a.wasm, a.zkey, proverThreads)),
    );
    const net = new Net();
    const resumer = new AuditResumer(id, u.match.playerIndex, u.match.scheme, u.jobs, windows, {
      prover,
      send: (m) => state.net?.send(m),
      now: () => performance.now(),
      store,
    });
    state.net = net;
    state.token = token;
    state.resumer = resumer;
    net.onMessage = (m) => {
      resumer.handle(m);
      if (m.t === 'audit_end' && location.pathname.endsWith('/results')) {
        setTimeout(() => route(), 300);
      }
    };
    net.onClose = (code) => onNetClose(net, code);
    await net.connect(token, state.hash);
    resumer.start();
    toast(`Resuming the audit: ${resumer.auditTotal} windows left to prove.`);
    history.replaceState(null, '', `/match/${id}/results${location.search}`);
    return true;
  } catch {
    return false;
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
  await Promise.all([loadCheatMods(), loadRenderer()]);
  state.store = await IndexedDbAuditStore.open();
  if (!state.versionError) await resumeAudit();
  route();
}

void boot();
