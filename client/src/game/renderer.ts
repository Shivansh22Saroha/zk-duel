/**
 * Canvas 2D arena renderer (UI_UX §3.3) — one implementation of GameRenderer (view.ts).
 * Pure presentation: draws a RenderFrame; knows nothing about the sim, input or network.
 * Letterboxed 5:3, 50-unit grid, players as filled circles with a 28-unit aim line,
 * 1-frame tracers for shots, white flash on hit.
 */
import { ANGLE_UNITS, PLAYER_RADIUS, RAY_LENGTH } from '@zkduel/shared/constants';
import type { GameRenderer, RenderFrame } from './view';

const GRID = 50;
const AIM_LEN = 28;
const BG = '#0E1116';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

class Canvas2DRenderer implements GameRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private arenaW = 1;
  private arenaH = 1;
  private readonly colors = {
    floor: cssVar('--arena-floor', '#12161C'),
    grid: cssVar('--arena-grid', '#1B2129'),
    p0: cssVar('--p0', '#4FB3FF'),
    p1: cssVar('--p1', '#FF7A59'),
    border: cssVar('--border', '#2D3643'),
    aim: cssVar('--text', '#E6EDF3'),
  };

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  /** Fit the canvas to its CSS box (device-pixel aware); the letterbox is computed in draw(). */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private layout(arenaW: number, arenaH: number): void {
    const { width: w, height: h } = this.canvas;
    this.arenaW = arenaW;
    this.arenaH = arenaH;
    this.scale = Math.min(w / arenaW, h / arenaH);
    this.ox = (w - arenaW * this.scale) / 2;
    this.oy = (h - arenaH * this.scale) / 2;
  }

  draw(frame: RenderFrame): void {
    this.layout(frame.arena.width, frame.arena.height);
    const { ctx, scale: s, arenaW: W, arenaH: H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, this.ox, this.oy);

    ctx.fillStyle = this.colors.floor;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1 / s;
    ctx.beginPath();
    for (let x = GRID; x < W; x += GRID) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = GRID; y < H; y += GRID) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.strokeStyle = this.colors.border;
    ctx.lineWidth = 2 / s;
    ctx.strokeRect(0, 0, W, H);

    for (const t of frame.tracers) {
      const a = (t.angle * 2 * Math.PI) / ANGLE_UNITS;
      ctx.strokeStyle = t.player === 0 ? this.colors.p0 : this.colors.p1;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5 / s;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + Math.cos(a) * RAY_LENGTH, t.y + Math.sin(a) * RAY_LENGTH);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const p of frame.players) {
      if (!p) continue;
      ctx.fillStyle = p.flashing ? '#FFFFFF' : p.index === 0 ? this.colors.p0 : this.colors.p1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      const a = (p.angle * 2 * Math.PI) / ANGLE_UNITS;
      ctx.strokeStyle = this.colors.aim;
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(a) * AIM_LEN, p.y + Math.sin(a) * AIM_LEN);
      ctx.stroke();
    }

    // letterbox mask: hides tracer overflow outside the arena
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const aw = W * s;
    const ah = H * s;
    ctx.fillRect(0, 0, cw, this.oy);
    ctx.fillRect(0, this.oy + ah, cw, ch - this.oy - ah);
    ctx.fillRect(0, 0, this.ox, ch);
    ctx.fillRect(this.ox + aw, 0, cw - this.ox - aw, ch);
  }

  dispose(): void {
    /* nothing to release for Canvas 2D */
  }
}

/** Renderer factory — the only place that picks an implementation. */
export function createRenderer(canvas: HTMLCanvasElement): GameRenderer {
  return new Canvas2DRenderer(canvas);
}
