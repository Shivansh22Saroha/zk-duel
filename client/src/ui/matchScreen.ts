/**
 * Match screen (UI_UX §3.3): top bar (names, HP, score, proof strips + spot-checks), arena,
 * own-player bottom HUD, countdown / round banners, settings overlay on Esc, optional debug overlay.
 * Owns the requestAnimationFrame loop that drives the GameSession.
 */
import { MAG_SIZE, MAX_HP, RELOAD_TICKS, type PlayerIndex } from '@zkduel/shared/constants';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { isFailedStatus } from '../zk/proofClient';
import type { FrameStats } from '../game/frameStats';
import type { KeyboardMouseInput } from '../game/input';
import { createRenderer } from '../game/renderer';
import type { GameSession } from '../game/session';
import { FrameBuilder, type GameRenderer } from '../game/view';
import type { ProofClient } from '../zk/proofClient';
import { h, mono, setText } from './dom';
import { proofStrip } from './proofStrip';

const ROUND_BANNER_MS = 1500;
/** The debug overlay sorts the sample buffers; refresh it at 4 Hz, not every frame. */
const DEBUG_REFRESH_MS = 250;

export interface MatchScreenOptions {
  game: GameSession;
  names: [string, string];
  input: KeyboardMouseInput | null;
  stats: FrameStats;
  showDebug: boolean;
  rtt: () => number;
  onForfeit: () => void;
  /** Commits / challenges / proofs (Phase 3); null only before the proving key loaded. */
  proof: ProofClient | null;
  /** Called every frame after the sim stepped (commits windows that became final). */
  afterUpdate?: () => void;
  /** Renderer factory (3D by default, Canvas 2D with ?renderer=2d); Canvas 2D when absent. */
  makeRenderer?: (canvas: HTMLCanvasElement) => GameRenderer;
  /** Dev cheat drawer (VITE_DEV_CHEATS builds only). */
  cheatDrawer?: HTMLElement | null;
}

export function matchScreen(o: MatchScreenOptions): {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  dispose: () => void;
} {
  const { game } = o;
  const me = game.playerIndex;

  const hpFill: [HTMLDivElement, HTMLDivElement] = [
    h('div', { style: 'background:var(--p0);width:100%' }),
    h('div', { style: 'background:var(--p1);width:100%' }),
  ];
  const hpText: [HTMLSpanElement, HTMLSpanElement] = [mono(String(MAX_HP)), mono(String(MAX_HP))];
  const scoreEl = mono('0 – 0', 'score');
  const strips = o.proof
    ? ([0, 1] as const).map((p) => proofStrip(o.proof as ProofClient, p, p === me))
    : [];
  // CHEAT tag under each player while a dev cheat is on (both players see it — F13)
  const cheatTags: [HTMLSpanElement, HTMLSpanElement] = [
    h('span', { class: 'cheat-tag', hidden: true }),
    h('span', { class: 'cheat-tag', hidden: true }),
  ];
  const renderCheatTags = (): void => {
    for (const p of [0, 1] as const) {
      const on = [...game.cheatFlags[p]];
      cheatTags[p].hidden = on.length === 0;
      setText(cheatTags[p], on.length ? `CHEAT: ${on.join(', ')}` : '');
    }
  };
  renderCheatTags();
  const side = (p: PlayerIndex, right: boolean) =>
    h(
      'div',
      { class: `side-col${right ? ' right' : ''}` },
      h(
        'div',
        { class: `side${right ? ' right' : ''}` },
        h('span', { class: `name p${p}` }, `${o.names[p]}${p === me ? ' (you)' : ''}`),
        h(
          'div',
          { class: 'hpbar', role: 'progressbar', 'aria-label': `${o.names[p]} health` },
          hpFill[p],
        ),
        hpText[p],
      ),
      strips[p]?.el ?? null,
      cheatTags[p],
    );

  const canvas = h('canvas', { id: 'arena', 'aria-label': 'Arena' });
  const overlay = h('div', { class: 'overlay' });
  const hint = h(
    'div',
    { class: 'hint' },
    `Click the arena to capture the mouse · WASD move · mouse aim · click fire · R reload · Esc settings${o.makeRenderer ? ' · V camera' : ''}`,
  );
  const debug = o.showDebug ? h('div', { class: 'debug', id: 'debug' }) : null;
  const statusNote = h('span', { class: 'status-note' });
  const proveNote = mono('prove –', 'muted');
  const forfeitBanner = h('div', { class: 'forfeit-banner', role: 'alert', hidden: true });

  const pips = h(
    'div',
    { class: 'pips', 'aria-label': 'ammo' },
    ...Array.from({ length: MAG_SIZE }, () => h('span', {})),
  );
  const ammoText = mono(`${MAG_SIZE}/${MAG_SIZE}`);
  const reloadFill = h('div', { style: 'width:0%' });

  const sens = h('input', {
    type: 'range',
    min: 1,
    max: 12,
    step: 1,
    value: o.input?.sensitivity ?? 3,
    'aria-label': 'Mouse sensitivity',
  });
  sens.addEventListener('input', () => o.input?.setSensitivity(Number(sens.value)));
  const settings = h(
    'div',
    { class: 'settings', hidden: true },
    h(
      'div',
      { class: 'card stack' },
      h('h2', {}, 'Settings'),
      h('p', { class: 'muted' }, 'The match keeps running.'),
      h('label', {}, 'Mouse sensitivity ', sens),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { onclick: () => ((settings.hidden = true), void canvas.requestPointerLock()) },
          'Resume',
        ),
        h(
          'button',
          { class: 'danger', onclick: () => confirm('Forfeit this match?') && o.onForfeit() },
          'Forfeit',
        ),
      ),
    ),
  );

  const el = h(
    'div',
    {},
    h(
      'div',
      { class: 'match' },
      h('header', { class: 'topbar' }, side(0, false), scoreEl, side(1, true)),
      h(
        'div',
        { class: 'arena-wrap' },
        canvas,
        overlay,
        hint,
        settings,
        forfeitBanner,
        debug,
        o.cheatDrawer ?? null,
      ),
      h(
        'footer',
        { class: 'bottombar' },
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted' }, 'AMMO'),
          ammoText,
          pips,
          h('span', { class: 'muted' }, 'RELOAD'),
          h('div', { class: 'reload' }, reloadFill),
        ),
        statusNote,
        proveNote,
      ),
    ),
    h(
      'main',
      { class: 'center too-small' },
      h('p', {}, 'ZK-Duel needs a keyboard and mouse on a larger screen.'),
    ),
  );

  let renderer: GameRenderer;
  try {
    renderer = (o.makeRenderer ?? createRenderer)(canvas);
  } catch {
    renderer = createRenderer(canvas); // e.g. no WebGL: fall back to Canvas 2D
  }
  const frames = new FrameBuilder(game);
  let bannerUntil = 0;
  let bannerText = '';
  let failedLive: string | null = null;

  const off = game.onMessage((m: ServerMessage) => {
    if (m.t === 'cheat_flag') renderCheatTags();
    if (m.t === 'round_end') {
      bannerText = `Round to ${o.names[m.winnerIndex]}`;
      bannerUntil = performance.now() + ROUND_BANNER_MS;
    }
    if (
      m.t === 'proof_result' &&
      failedLive === null &&
      m.phase === 'live' &&
      isFailedStatus(m.status)
    ) {
      failedLive = `${m.status} — round ${m.roundNo}, window ${m.windowIndex} (${o.names[m.playerIndex]})`;
    }
    if (m.t === 'match_end' && m.reason === 'forfeit_proof') {
      forfeitBanner.textContent = `Spot-check failed${failedLive ? `: ${failedLive}` : ''}. Match forfeited.`;
      forfeitBanner.hidden = false;
    }
  });

  const onLockChange = (): void => {
    if (document.pointerLockElement === canvas) {
      settings.hidden = true;
      hint.hidden = true;
    } else if (game.phase !== 'ended') {
      settings.hidden = false;
    }
  };
  document.addEventListener('pointerlockchange', onLockChange);

  let raf = 0;
  let lastDebugAt = 0;
  const shownHp: [number, number] = [-1, -1];
  let shownAmmo = -1;
  let shownReload = -1;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    o.stats.frame(now);
    const t0 = performance.now();

    game.update(now);
    o.afterUpdate?.();
    renderer.resize();
    renderer.draw(frames.build(now));

    // HUD — DOM is only touched when a value changed
    for (const p of [0, 1] as const) {
      if (game.hp[p] !== shownHp[p]) {
        shownHp[p] = game.hp[p];
        hpFill[p].style.width = `${(100 * game.hp[p]) / MAX_HP}%`;
        setText(hpText[p], String(game.hp[p]));
      }
    }
    setText(scoreEl, `${game.score[0]} – ${game.score[1]}`);
    const hd = game.self.hidden;
    if (hd.ammo !== shownAmmo) {
      shownAmmo = hd.ammo;
      setText(ammoText, `${hd.ammo}/${MAG_SIZE}`);
      Array.from(pips.children).forEach((c, i) => c.classList.toggle('empty', i >= hd.ammo));
    }
    if (hd.reloadTimer !== shownReload) {
      shownReload = hd.reloadTimer;
      reloadFill.style.width = hd.reloadTimer
        ? `${(100 * (RELOAD_TICKS - hd.reloadTimer)) / RELOAD_TICKS}%`
        : '0%';
    }
    setText(
      statusNote,
      game.opponentStatus === 'connected' ? '' : `Opponent ${game.opponentStatus}…`,
    );
    const pm = o.proof?.lastProveMs;
    setText(proveNote, pm === null || pm === undefined ? 'prove –' : `prove ${Math.round(pm)} ms`);

    let overlayText = '';
    if (game.phase === 'countdown' || game.phase === 'matched')
      overlayText = game.phase === 'matched' ? 'Get ready' : String(game.countdown);
    else if (now < bannerUntil) overlayText = bannerText;
    if (overlay.textContent !== overlayText) {
      overlay.replaceChildren(
        overlayText
          ? h(
              'div',
              { class: /^\d$/.test(overlayText) ? 'countdown' : 'round-banner' },
              overlayText,
            )
          : '',
      );
    }
    if (debug && now - lastDebugAt >= DEBUG_REFRESH_MS) {
      lastDebugAt = now;
      const s = o.stats.summary();
      setText(
        debug,
        `fps ${s.fps.toFixed(0)}  frame p95 ${s.intervalP95.toFixed(1)} ms  work p95 ${s.workP95.toFixed(2)} ms\n` +
          `round ${game.roundNo}  tick ${game.tick}  rtt ${o.rtt().toFixed(0)} ms  sent ${game.ticksSent}  filled ${game.ticksFilled}  desync ${game.desyncTicks}`,
      );
    }
    o.stats.addWork(performance.now() - t0);
  };
  raf = requestAnimationFrame(frame);

  return {
    el,
    canvas,
    dispose: () => {
      cancelAnimationFrame(raf);
      off();
      strips.forEach((st) => st.dispose());
      frames.dispose();
      renderer.dispose();
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };
}
