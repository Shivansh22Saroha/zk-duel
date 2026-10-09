/** Landing, queue and results screens (UI_UX §3.1, §3.2, §3.4). */
import { DISPLAY_NAME_PATTERN } from '@zkduel/shared/constants';
import type { MatchSummary } from '../api';
import { h, mono, setText } from './dom';

const NAME_RE = new RegExp(DISPLAY_NAME_PATTERN);

export function landingScreen(opts: {
  initialName: string;
  versionError: string | null;
  onFindMatch: (name: string) => void;
}): HTMLElement {
  const input = h('input', {
    type: 'text',
    id: 'name',
    maxlength: 16,
    autocomplete: 'off',
    'aria-describedby': 'name-err',
    placeholder: 'Display name',
  });
  input.value = opts.initialName;
  const err = h('div', { class: 'error', id: 'name-err' });
  const find = h('button', { id: 'find-match' }, 'Find Match');
  const validate = (): boolean => {
    const ok = NAME_RE.test(input.value);
    find.disabled = !ok || opts.versionError !== null;
    setText(err, input.value && !ok ? 'Display name must be 3–16 characters [A-Za-z0-9_].' : '');
    return ok;
  };
  input.addEventListener('input', validate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && validate() && !find.disabled) opts.onFindMatch(input.value);
  });
  find.addEventListener('click', () => validate() && opts.onFindMatch(input.value));
  validate();

  const dialog = h(
    'dialog',
    {},
    h('h2', {}, 'How it works'),
    h(
      'ol',
      {},
      h(
        'li',
        {},
        'Play: your browser simulates your own movement, aim and weapon with integer rules.',
      ),
      h(
        'li',
        {},
        'Prove: every window of ticks, it proves (zk-SNARK) that you followed the rules — without revealing ammo, cooldown or reload timing.',
      ),
      h(
        'li',
        {},
        'Verify: the server checks each proof in milliseconds and shows ✓ / ✕ for both players.',
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      'Limitation: a proof shows the inputs obeyed the rules, not that a human produced them — a smooth aimbot within the turn limit passes.',
    ),
    h('p', { class: 'muted' }, 'Phase 1 build: proofs are not generated yet.'),
    h('button', { class: 'secondary', onclick: () => dialog.close() }, 'Close'),
  );

  return h(
    'main',
    { class: 'center' },
    h(
      'div',
      { class: 'card stack' },
      h('h1', {}, 'ZK-DUEL'),
      h('p', { class: 'muted' }, '1v1. Every move proven.'),
      opts.versionError ? h('div', { class: 'banner', role: 'alert' }, opts.versionError) : null,
      h('label', { for: 'name', class: 'muted' }, 'Display name'),
      input,
      err,
      h('div', { class: 'row' }, find),
      h(
        'div',
        { class: 'row muted' },
        h(
          'a',
          { href: '#', onclick: (e: Event) => (e.preventDefault(), dialog.showModal()) },
          'How it works',
        ),
      ),
      dialog,
    ),
  );
}

export function queueScreen(onCancel: () => void): { el: HTMLElement; dispose: () => void } {
  const elapsed = mono('00:00');
  const t0 = Date.now();
  const timer = window.setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    setText(
      elapsed,
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
    );
  }, 250);
  const el = h(
    'main',
    { class: 'center' },
    h(
      'div',
      { class: 'card stack', style: 'text-align:center; display:grid; justify-items:center' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h2', { id: 'queue-status' }, 'Waiting for opponent…'),
      elapsed,
      h('button', { class: 'secondary', id: 'cancel-queue', onclick: onCancel }, 'Cancel'),
    ),
  );
  return { el, dispose: () => clearInterval(timer) };
}

const REASONS: Record<string, string> = {
  rounds: 'by rounds',
  forfeit: 'by forfeit',
  forfeit_proof: 'proof failure forfeit',
  disconnect: 'opponent disconnected',
  abort: 'match aborted',
};

export function resultsScreen(opts: {
  summary: MatchSummary;
  onLobby: () => void;
  onDownloadTickLog: (() => void) | null;
}): HTMLElement {
  const s = opts.summary;
  const winner = s.winnerIndex === null ? null : s.players[s.winnerIndex];
  const score = s.players.map((p) => p.roundsWon).join(' – ');
  const headline =
    s.winnerIndex === null
      ? 'No winner'
      : s.you === s.winnerIndex
        ? 'You win'
        : `${winner?.displayName ?? '?'} wins`;
  return h(
    'main',
    { class: 'center' },
    h(
      'div',
      { class: 'card stack', style: 'width:min(720px,100%)', id: 'results' },
      h('h1', {}, headline),
      h(
        'div',
        { class: 'row' },
        mono(score, 'score'),
        h('span', { class: 'muted' }, REASONS[s.endReason ?? ''] ?? s.endReason ?? ''),
      ),
      h(
        'div',
        { class: 'cols' },
        ...s.players.map((p) =>
          h(
            'section',
            {},
            h(
              'h3',
              { class: `p${p.playerIndex}` },
              `${p.displayName}${s.you === p.playerIndex ? ' (you)' : ''}`,
            ),
            h(
              'table',
              {},
              h('tr', {}, h('td', {}, 'Rounds won'), h('td', {}, mono(String(p.roundsWon)))),
              h('tr', {}, h('td', {}, 'Shots'), h('td', {}, mono(String(p.shots)))),
              h('tr', {}, h('td', {}, 'Hits'), h('td', {}, mono(String(p.hits)))),
              h(
                'tr',
                {},
                h('td', {}, 'Accuracy'),
                h('td', {}, mono(p.shots ? `${Math.round((100 * p.hits) / p.shots)}%` : '–')),
              ),
              h(
                'tr',
                {},
                h('td', { class: 'muted' }, 'Proof windows'),
                h('td', { class: 'muted' }, 'Phase 3'),
              ),
            ),
          ),
        ),
      ),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'Round'), h('th', {}, 'Winner'), h('th', {}, 'Ticks')),
        ...s.rounds.map((r) =>
          h(
            'tr',
            {},
            h('td', {}, mono(String(r.roundNo))),
            h(
              'td',
              {},
              r.winnerIndex === null ? '–' : (s.players[r.winnerIndex]?.displayName ?? '?'),
            ),
            h('td', {}, mono(r.endTick === null ? '–' : String(r.endTick - r.startTick + 1))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: opts.onLobby, id: 'back-lobby' }, 'Back to lobby'),
        opts.onDownloadTickLog
          ? h(
              'button',
              { class: 'secondary', onclick: opts.onDownloadTickLog },
              'Download tick log (dev)',
            )
          : null,
      ),
    ),
  );
}
