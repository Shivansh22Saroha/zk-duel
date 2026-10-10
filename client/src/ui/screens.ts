/** Landing, queue and results screens (UI_UX §3.1, §3.2, §3.4). */
import { DISPLAY_NAME_PATTERN } from '@zkduel/shared/constants';
import type { MatchSummary } from '../api';
import type { ProofClient } from '../zk/proofClient';
import { h, mono, setText } from './dom';
import { cellOf, tooltipOf } from './proofStrip';

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
        'Commit: every window of ticks, your browser commits to its hidden weapon state (ammo, cooldown, reload) without revealing it.',
      ),
      h(
        'li',
        {},
        'Prove: the server spot-checks random windows during play; your browser proves (zk-SNARK) that you followed the rules in them. After the match it proves all the rest — the audit.',
      ),
      h(
        'li',
        {},
        'Verify: the server checks each proof in milliseconds and shows ✓ / ✕ for both players; only a fully audited match is "clean".',
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      'Limitation: a proof shows the inputs obeyed the rules, not that a human produced them — a smooth aimbot within the turn limit passes.',
    ),
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

export function queueScreen(
  onCancel: () => void,
  loadProgress: () => number = () => 1,
): { el: HTMLElement; dispose: () => void } {
  const elapsed = mono('00:00');
  const loading = h('div', { class: 'muted', id: 'key-progress' });
  const bar = h('progress', { max: 1, value: 0, style: 'width:100%' });
  const t0 = Date.now();
  const timer = window.setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    setText(
      elapsed,
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
    );
    const f = loadProgress();
    bar.value = f;
    setText(
      loading,
      f >= 1 ? 'Proving key loaded and verified.' : `Loading proving key… ${Math.round(100 * f)}%`,
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
      loading,
      bar,
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

const AUDIT_LABEL: Record<string, [string, string]> = {
  audited_clean: ['AUDITED CLEAN', 'clean'],
  audited_failed: ['AUDIT FAILED', 'failed'],
  audit_incomplete: ['AUDIT INCOMPLETE', 'incomplete'],
};

const fmtMs = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined ? '–' : `${v.toFixed(digits)} ms`;

/**
 * Audit panel (UI_UX §3.4): live "Auditing… 23/150 windows" from this client's ProofClient while
 * the audit runs, then the final status (from audit_end or the stored summary).
 */
function auditPanel(
  s: MatchSummary,
  proof: ProofClient | null,
): { el: HTMLElement; update: () => void } {
  const status = h('div', { class: 'status' });
  const detail = h('div', { class: 'muted' });
  const bar = h('progress', { max: 1, value: 0 });
  const stamp = h('span', { class: 'overturned', hidden: true }, 'OVERTURNED');
  const el = h(
    'section',
    { class: 'audit stack', id: 'audit' },
    h('div', { class: 'row' }, status, stamp),
    bar,
    detail,
  );
  const update = (): void => {
    const live = proof && !proof.auditDone && proof.auditing;
    const final = proof?.auditStatus ?? (s.auditStatus === 'auditing' ? null : s.auditStatus);
    const overturned = proof?.auditDone ? proof.overturned : s.overturned;
    if (live) {
      el.className = 'audit stack';
      const total = Math.max(proof.auditTotal, proof.auditProven);
      setText(status, `Auditing… ${proof.auditProven}/${total} windows`);
      bar.max = Math.max(1, total);
      bar.value = proof.auditProven;
      bar.hidden = false;
      setText(
        detail,
        'Your browser is proving every window that was not spot-checked during play. Keep this tab open.',
      );
    } else if (final) {
      const [label, cls] = AUDIT_LABEL[final] ?? [final, ''];
      el.className = `audit stack ${cls}`;
      setText(status, label);
      bar.hidden = true;
      setText(
        detail,
        final === 'audited_clean'
          ? 'Every window of both players was proven and verified.'
          : final === 'audited_failed'
            ? 'At least one window failed (a rule was broken, or a proof/commit was withheld).'
            : 'Some windows were never proven (audit stopped, timed out, or a disconnect broke the chain).',
      );
    } else {
      el.className = 'audit stack';
      setText(status, 'Audit running (other player)…');
      bar.hidden = true;
      setText(detail, '');
    }
    stamp.hidden = !overturned;
  };
  update();
  return { el, update };
}

export function resultsScreen(opts: {
  summary: MatchSummary;
  /** This client's proof state for the match (live audit progress), if it played it. */
  proof: ProofClient | null;
  onLobby: () => void;
  onDownloadTickLog: (() => void) | null;
}): { el: HTMLElement; dispose: () => void } {
  const s = opts.summary;
  const winner = s.winnerIndex === null ? null : s.players[s.winnerIndex];
  const score = s.players.map((p) => p.roundsWon).join(' – ');
  const headline =
    s.winnerIndex === null
      ? 'No winner'
      : s.you === s.winnerIndex
        ? 'You win'
        : `${winner?.displayName ?? '?'} wins`;
  const audit = auditPanel(s, opts.proof);
  const timeline = (p: number) => {
    const box = h('div', { class: 'timeline' });
    const render = () => {
      const ws = opts.proof ? opts.proof.recent(p as 0 | 1, 100_000) : [];
      box.replaceChildren(
        ...ws.map((w) => {
          const { cls, symbol } = cellOf(w);
          const tip = tooltipOf(w, s.you === p);
          return h('span', { class: `cell ${cls}`, title: tip, 'aria-label': tip }, symbol);
        }),
      );
    };
    render();
    return { box, render };
  };
  const timelines = s.players.map((p) => timeline(p.playerIndex));
  let last = 0;
  const off = opts.proof?.onChange(() => {
    audit.update();
    const now = performance.now();
    if (now - last > 250 || opts.proof?.auditDone) {
      last = now;
      timelines.forEach((t) => t.render());
    }
  });
  const el = h(
    'main',
    { class: 'center' },
    h(
      'div',
      { class: 'card stack', style: 'width:min(760px,100%)', id: 'results' },
      h('h1', {}, headline),
      audit.el,
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
                h('td', {}, 'Windows (committed)'),
                h('td', {}, mono(`${p.windows} (${p.windowsCommitted})`)),
              ),
              ...Object.entries(p.proofs.byStatus)
                .sort()
                .map(([st, n]) =>
                  h('tr', {}, h('td', { class: 'muted' }, `  ${st}`), h('td', {}, mono(String(n)))),
                ),
              h(
                'tr',
                {},
                h('td', {}, 'Spot-checks passed'),
                h('td', {}, mono(`${p.challengesPassed}/${p.challenges}`)),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Challenge rate r'),
                h('td', {}, mono(p.challengeRate === null ? '–' : p.challengeRate.toFixed(3))),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Live detection latency'),
                h(
                  'td',
                  {},
                  mono(
                    p.detectionLatencyWindows === null
                      ? '– (Phase 4)'
                      : `${p.detectionLatencyWindows} windows`,
                  ),
                ),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Audit duration'),
                h('td', {}, mono(p.auditMs === null ? '–' : `${(p.auditMs / 1000).toFixed(1)} s`)),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Prove mean / p95'),
                h('td', {}, mono(`${fmtMs(p.proofs.proveMsMean)} / ${fmtMs(p.proofs.proveMsP95)}`)),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Verify mean'),
                h('td', {}, mono(fmtMs(p.proofs.verifyMsMean, 1))),
              ),
            ),
            timelines[p.playerIndex]?.box ?? null,
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
  return { el, dispose: () => off?.() };
}
