/**
 * Dev cheat drawer (UI_UX §3.3, FEATURES F13): F9 opens a 280 px right-side drawer with one toggle
 * per cheat and a DEV badge. Loaded only by builds with VITE_DEV_CHEATS=true (dynamic import).
 */
import type { CheatName } from '@zkduel/shared/protocol';
import { CHEAT_LABELS, CHEATS, type Cheats } from '../game/cheats';
import { h } from './dom';

export function cheatPanel(
  cheats: Cheats,
  onToggle: (c: CheatName, on: boolean) => void,
): { el: HTMLElement; dispose: () => void } {
  const boxes = new Map<CheatName, HTMLInputElement>();
  const el = h(
    'aside',
    { class: 'cheat-drawer', hidden: true, 'aria-label': 'Dev cheats' },
    h('div', { class: 'row' }, h('h2', {}, 'Cheats'), h('span', { class: 'dev-badge' }, 'DEV')),
    h(
      'p',
      { class: 'muted' },
      'Cheats change your real state. Every rule-breaking cheat makes the windows it touches unprovable — caught by a spot-check or by the audit. Smooth-aim stays valid.',
    ),
    ...CHEATS.map((c) => {
      const box = h('input', { type: 'checkbox', id: `cheat-${c}` });
      box.checked = cheats.active.has(c);
      box.addEventListener('change', () => onToggle(c, box.checked));
      boxes.set(c, box);
      return h('label', { class: 'cheat-row', for: `cheat-${c}` }, box, CHEAT_LABELS[c]);
    }),
    h('p', { class: 'muted' }, 'F9 closes this drawer.'),
  );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'F9') return;
    e.preventDefault();
    el.hidden = !el.hidden;
    for (const [c, b] of boxes) b.checked = cheats.active.has(c);
  };
  window.addEventListener('keydown', onKey);
  return { el, dispose: () => window.removeEventListener('keydown', onKey) };
}
