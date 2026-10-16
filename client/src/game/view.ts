/**
 * The renderer seam. Game logic is 2D and integer; renderers only ever see a `RenderFrame`,
 * a plain snapshot of what to draw this frame (already interpolated, floats allowed).
 *
 *   sim / input / net  →  GameSession  →  FrameBuilder.build(now)  →  GameRenderer.draw(frame)
 *
 * A renderer must not import the sim, the session, input or networking. Two exist: the Canvas 2D
 * renderer (renderer.ts, `?renderer=2d`) and the Three.js one (renderer3d.ts, the default).
 */
import { ARENA_H, ARENA_W, type PlayerIndex } from '@zkduel/shared/constants';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { lerpPose, opponentPose, type RenderPose } from './interp';
import type { GameSession } from './session';

export interface RenderPlayer extends RenderPose {
  index: PlayerIndex;
  hp: number;
  isSelf: boolean;
  /** Hit flash active this frame. */
  flashing: boolean;
}

export interface RenderTracer {
  x: number;
  y: number;
  /** Angle in angle units (tenths of a degree). */
  angle: number;
  player: PlayerIndex;
}

export interface RenderFrame {
  arena: { width: number; height: number };
  /** Indexed by player index; null when a player has no known pose yet. */
  players: [RenderPlayer | null, RenderPlayer | null];
  /** Shots fired since the previous frame (draw once). */
  tracers: RenderTracer[];
  phase: GameSession['phase'];
}

export interface GameRenderer {
  /** Fit to the current canvas/container size. Cheap; called every frame. */
  resize(): void;
  draw(frame: RenderFrame): void;
  dispose(): void;
  /** True when the camera turns with the aim (3D first-person); absent = never. */
  isFirstPerson?(): boolean;
}

const OPPONENT_DELAY_MS = 50;
const FLASH_FRAMES = 4;

/** Turns session state + server events into RenderFrames. */
export class FrameBuilder {
  private tracers: RenderTracer[] = [];
  private flash: [number, number] = [0, 0];
  private lastTick = -1;
  private lastRound = 0;
  private readonly off: () => void;

  constructor(private readonly game: GameSession) {
    this.off = game.onMessage((m: ServerMessage) => {
      if (m.t !== 'state' || m.phase !== 'live') return;
      const op = game.opponentIndex;
      const s = m.players[op];
      if (s.fired === 1) this.tracers.push({ x: s.x, y: s.y, angle: s.angle, player: op });
      for (const hit of m.hits) this.flash[hit.target] = FLASH_FRAMES;
    });
  }

  build(now: number): RenderFrame {
    const g = this.game;
    const me = g.playerIndex;
    // own shots straight from the local sim (no network delay)
    if (g.roundNo !== this.lastRound) {
      this.lastRound = g.roundNo;
      this.lastTick = -1;
    }
    for (const r of g.records.slice(Math.max(0, this.lastTick + 1))) {
      if (r.fired === 1) this.tracers.push({ x: r.x, y: r.y, angle: r.angle, player: me });
    }
    this.lastTick = g.tick;

    const live = g.phase === 'live';
    const mine: RenderPose = live ? lerpPose(g.prevSelf.pub, g.self.pub, g.alpha(now)) : g.self.pub;
    const st = g.lastState?.players[g.opponentIndex];
    const theirs: RenderPose | null = live
      ? opponentPose(g.opponentBuffer, now, OPPONENT_DELAY_MS)
      : st
        ? { x: st.x, y: st.y, angle: st.angle }
        : null;

    const player = (index: PlayerIndex, pose: RenderPose | null): RenderPlayer | null => {
      if (!pose) return null;
      const flashing = this.flash[index] > 0;
      if (flashing) this.flash[index]--;
      return {
        index,
        x: pose.x,
        y: pose.y,
        angle: pose.angle,
        hp: g.hp[index],
        isSelf: index === me,
        flashing,
      };
    };
    const frame: RenderFrame = {
      arena: { width: ARENA_W, height: ARENA_H },
      players:
        me === 0 ? [player(0, mine), player(1, theirs)] : [player(0, theirs), player(1, mine)],
      tracers: this.tracers,
      phase: g.phase,
    };
    this.tracers = [];
    return frame;
  }

  dispose(): void {
    this.off();
  }
}
