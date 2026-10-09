/**
 * App controller + tiny router: `/`, `/match/:id`, `/match/:id/results`.
 * Flow 1 (USER_FLOWS): landing → guest auth → WS hello → queue → match → results.
 */
import './styles.css';
import { constantsHash } from '@zkduel/shared/canonical';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { api, ApiError, session } from './api';
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

const root = document.getElementById('app') as HTMLElement;
const params = new URLSearchParams(location.search);
/** Dev-only automation (perf measurement / smoke tests): `?bot=<seed>` plays with BotInput. */
const botSeed = import.meta.env.DEV && params.has('bot') ? Number(params.get('bot')) || 1 : null;

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

const state = {
  hash: '',
  versionError: null as string | null,
  net: null as Net | null,
  game: null as GameSession | null,
  input: new InputProxy(),
  kbm: null as KeyboardMouseInput | null,
  tickLog: ENV.LOG_TICKS ? new MemoryTickLog() : null,
  stats: new FrameStats(),
  names: ['', ''] as [string, string],
  dispose: null as (() => void) | null,
};

if (ENV.SHOW_DEBUG || import.meta.env.DEV) {
  Object.assign(window, {
    __zkd: {
      stats: () => state.stats.summary(),
      resetStats: () => state.stats.reset(),
      game: () => state.game,
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
  state.net?.close();
  state.net = null;
  state.game = null;
}

function route(): void {
  const path = location.pathname;
  const results = /^\/match\/([^/]+)\/results$/.exec(path);
  const match = /^\/match\/([^/]+)$/.exec(path);
  if (results) return void showResults(decodeURIComponent(results[1] as string));
  if (match) {
    if (state.game?.match?.matchId === match[1]) return showMatch();
    return go('/'); // Phase 1: no reconnect into a running match after a reload
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

async function findMatch(name: string): Promise<void> {
  try {
    let token = session.name === name ? session.token : null;
    if (!token) {
      const g = await api.guest(name);
      token = g.token;
      session.save(token, name);
    }
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
    net.onClose = (code) => {
      if (state.net === net && game.phase !== 'ended') {
        toast(code === 4409 ? 'Connected in another tab.' : `Disconnected (${code}).`);
        go('/');
      }
    };
    try {
      await net.connect(token, state.hash);
    } catch (e) {
      if (e instanceof Error && e.message === 'UNAUTHORIZED') {
        session.clear();
        toast('Session expired — please enter your name again.');
      } else toast(e instanceof Error ? e.message : 'Connection failed.');
      return showLanding();
    }
    const q = queueScreen(() => {
      net.send({ t: 'queue_leave' });
      showLanding();
    });
    mount(q.el, q.dispose);
    net.send({ t: 'queue_join' });
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not reach the server.');
  }
}

function onServer(m: ServerMessage, myName: string): void {
  const game = state.game;
  if (!game) return;
  game.handle(m);
  switch (m.t) {
    case 'match_found': {
      state.names = m.playerIndex === 0 ? [myName, m.opponentName] : [m.opponentName, myName];
      go(`/match/${m.matchId}`);
      break;
    }
    case 'match_end':
      state.kbm?.dispose();
      setTimeout(() => go(m.resultsUrl), 1200);
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
  });
  mount(ms.el, ms.dispose);
  if (botSeed !== null) {
    state.input.inner = new BotInput(botSeed);
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
    mount(
      resultsScreen({
        summary,
        onLobby: () => go('/'),
        onDownloadTickLog: hasLog ? () => log.download() : null,
      }),
    );
    state.net?.close();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not load results.');
    go('/');
  }
}

async function boot(): Promise<void> {
  state.hash = await constantsHash();
  try {
    const info = await api.circuitInfo();
    if (info.constantsHash !== state.hash)
      state.versionError = 'Client and server versions differ. Refresh.';
  } catch {
    state.versionError = `Cannot reach the server at ${ENV.API_URL}.`;
  }
  route();
}

void boot();
