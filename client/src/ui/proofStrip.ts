/**
 * Proof strip (UI_UX §2/§3.3, FEATURES F12): last 10 windows of one player, newest on the right.
 *   hollow = committed · ◌ = challenged / proving · ✓ valid · ✕ failure · ⛓ chain_broken
 * plus "Spot-checks: 7/7 passed". Status is never shown by colour alone; the tooltip names it.
 * Re-rendered only when the ProofClient reports a change (never per frame).
 */
import type { PlayerIndex } from '@zkduel/shared/constants';
import { isFailedStatus, type ProofClient, type WindowView } from '../zk/proofClient';
import { h, setText } from './dom';

export const STRIP_CELLS = 10;

export function cellOf(w: WindowView): { cls: string; symbol: string } {
  if (w.status === 'valid') return { cls: 'valid', symbol: '✓' };
  if (w.status === 'chain_broken') return { cls: 'broken', symbol: '⛓' };
  if (isFailedStatus(w.status)) return { cls: 'failed', symbol: '✕' };
  if (w.status === 'unaudited') return { cls: 'unaudited', symbol: '' };
  if (w.challenged || w.proving) return { cls: 'challenged', symbol: '◌' };
  return { cls: 'committed', symbol: '' }; // committed (or commit in flight): hollow
}

export function tooltipOf(w: WindowView, own: boolean): string {
  const parts = [
    `Round ${w.roundNo} · window ${w.windowIndex}`,
    w.status === 'pending' ? 'committing' : w.status,
  ];
  if (w.challenged) parts.push('challenged');
  if (own && w.proveMs !== null) parts.push(`prove ${w.proveMs} ms`);
  if (w.verifyMs !== null) parts.push(`verify ${w.verifyMs.toFixed(1)} ms`);
  return parts.join(' · ');
}

export function proofStrip(
  proof: ProofClient,
  p: PlayerIndex,
  own: boolean,
): { el: HTMLElement; dispose: () => void } {
  const cells = Array.from({ length: STRIP_CELLS }, () =>
    h('span', { class: 'cell empty', role: 'img', 'aria-label': 'no window yet' }),
  );
  const spot = h('span', { class: 'spot mono' }, 'Spot-checks: 0/0');
  const el = h(
    'div',
    { class: 'strip-wrap' },
    h('div', { class: 'strip', 'aria-label': 'proof windows' }, ...cells),
    spot,
  );
  const render = (): void => {
    const ws = proof.recent(p, STRIP_CELLS);
    cells.forEach((c, i) => {
      const w = ws[i - (STRIP_CELLS - ws.length)];
      if (!w) {
        c.className = 'cell empty';
        c.textContent = '';
        c.removeAttribute('title');
        c.setAttribute('aria-label', 'no window yet');
        return;
      }
      const { cls, symbol } = cellOf(w);
      c.className = `cell ${cls}`;
      setText(c, symbol);
      const tip = tooltipOf(w, own);
      c.title = tip;
      c.setAttribute('aria-label', tip);
    });
    const s = proof.spotChecks(p);
    setText(
      spot,
      `Spot-checks: ${s.passed}/${s.decided} passed${s.pending ? ` · ${s.pending} ◌` : ''}`,
    );
    spot.classList.toggle('bad', s.decided > s.passed);
  };
  render();
  const off = proof.onChange(render);
  return { el, dispose: off };
}
