/**
 * Canvas 2D arena renderer (UI_UX §3.3). Render-only: floats are fine here.
 * Letterboxed 5:3, 50-unit grid, players as filled circles with a 28-unit aim line,
 * 1-frame tracers for shots, 4-frame white flash on hit.
 */
import {
  ANGLE_UNITS,
  ARENA_H,
  ARENA_W,
  PLAYER_RADIUS,
  RAY_LENGTH,
  type PlayerIndex,
} from '@zkduel/shared/constants';
import type { RenderPose } from './interp';

const GRID = 50;
const AIM_LEN = 28;
const FLASH_FRAMES = 4;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface Tracer {
  x: number;
  y: number;
  angle: number;
  player: PlayerIndex;
}

export class ArenaRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private flash: [number, number] = [0, 0];
  private tracers: Tracer[] = [];
  private readonly colors = {
    floor: cssVar('--arena-floor', '#12161C'),
    grid: cssVar('--arena-grid', '#1B2129'),
    p0: cssVar('--p0', '#4FB3FF'),
    p1: cssVar('--p1', '#FF7A59'),
    border: cssVar('--border', '#2D3643'),
  };

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  /** Fit the canvas to its CSS box (device-pixel aware) and compute the 5:3 letterbox. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = Math.min(w / ARENA_W, h / ARENA_H);
    this.ox = (w - ARENA_W * this.scale) / 2;
    this.oy = (h - ARENA_H * this.scale) / 2;
  }

  addTracer(t: Tracer): void {
    this.tracers.push(t);
  }

  hit(target: PlayerIndex): void {
    this.flash[target] = FLASH_FRAMES;
  }

  draw(poses: [RenderPose | null, RenderPose | null]): void {
    const { ctx, scale: s } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0E1116';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, this.ox, this.oy);

    ctx.fillStyle = this.colors.floor;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1 / s;
    ctx.beginPath();
    for (let x = GRID; x < ARENA_W; x += GRID) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA_H);
    }
    for (let y = GRID; y < ARENA_H; y += GRID) {
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA_W, y);
    }
    ctx.stroke();
    ctx.strokeStyle = this.colors.border;
    ctx.lineWidth = 2 / s;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);

    // tracers (1 frame)
    for (const t of this.tracers) {
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
    this.tracers = [];

    poses.forEach((p, i) => {
      if (!p) return;
      const idx = i as PlayerIndex;
      const flashing = this.flash[idx] > 0;
      ctx.fillStyle = flashing ? '#FFFFFF' : idx === 0 ? this.colors.p0 : this.colors.p1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      const a = (p.angle * 2 * Math.PI) / ANGLE_UNITS;
      ctx.strokeStyle = '#E6EDF3';
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(a) * AIM_LEN, p.y + Math.sin(a) * AIM_LEN);
      ctx.stroke();
      if (flashing) this.flash[idx]--;
    });

    // letterbox mask over tracer overflow
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0E1116';
    const W = this.canvas.width;
    const H = this.canvas.height;
    const aw = ARENA_W * s;
    const ah = ARENA_H * s;
    ctx.fillRect(0, 0, W, this.oy);
    ctx.fillRect(0, this.oy + ah, W, H - this.oy - ah);
    ctx.fillRect(0, 0, this.ox, H);
    ctx.fillRect(this.ox + aw, 0, W - this.ox - aw, H);
  }
}
