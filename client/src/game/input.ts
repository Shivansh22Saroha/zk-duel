/**
 * Keyboard + pointer-locked mouse (FEATURES F5, UI_UX §6).
 * Mouse X movement × sensitivity accumulates a pending turn; each tick consumes at most
 * MAX_TURN of it, so the sim's clamp never discards input and the turn direction is kept.
 */
import { MAX_TURN } from '@zkduel/shared/constants';
import type { TickInput } from '@zkduel/shared/sim';
import type { InputContext, InputSource } from './session';

const SENS_KEY = 'zkd.sensitivity';
export const DEFAULT_SENSITIVITY = 3; // angle units (0.1°) per mouse pixel
/** Cap on queued turn so a huge flick doesn't keep turning for seconds. */
const MAX_PENDING_TURN = 1800;

export class KeyboardMouseInput implements InputSource {
  private keys = new Set<string>();
  private mouseDown = false;
  private pendingTurn = 0;
  sensitivity: number;
  private readonly abort = new AbortController();

  constructor(private readonly target: HTMLElement) {
    let s = DEFAULT_SENSITIVITY;
    try {
      s = Number(localStorage.getItem(SENS_KEY)) || DEFAULT_SENSITIVITY;
    } catch {
      /* storage unavailable */
    }
    this.sensitivity = s;
    const o = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.onKey(e, true), o);
    window.addEventListener('keyup', (e) => this.onKey(e, false), o);
    window.addEventListener('blur', () => this.reset(), o);
    target.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 0) return;
        if (document.pointerLockElement !== target) void target.requestPointerLock();
        else this.mouseDown = true;
      },
      o,
    );
    window.addEventListener('mouseup', (e) => e.button === 0 && (this.mouseDown = false), o);
    window.addEventListener(
      'mousemove',
      (e) => {
        if (document.pointerLockElement !== target) return;
        this.pendingTurn = Math.max(
          -MAX_PENDING_TURN,
          Math.min(MAX_PENDING_TURN, this.pendingTurn + e.movementX * this.sensitivity),
        );
      },
      o,
    );
  }

  setSensitivity(v: number): void {
    this.sensitivity = v;
    try {
      localStorage.setItem(SENS_KEY, String(v));
    } catch {
      /* ignore */
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'r'].includes(k)) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      if (this.locked) e.preventDefault();
    }
  }

  private reset(): void {
    this.keys.clear();
    this.mouseDown = false;
  }

  sample(ctx: InputContext): TickInput {
    const turn = Math.round(Math.max(-MAX_TURN, Math.min(MAX_TURN, this.pendingTurn)));
    this.pendingTurn -= turn;
    const k = this.keys;
    return {
      moveX: (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0),
      moveY: (k.has('s') ? 1 : 0) - (k.has('w') ? 1 : 0),
      aimTarget: ctx.self.pub.angle + turn,
      fire: this.mouseDown && this.locked,
      reload: k.has('r'),
    };
  }

  dispose(): void {
    this.abort.abort();
    if (this.locked) document.exitPointerLock();
  }
}
