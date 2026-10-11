/**
 * On-screen direction check: every movement key and every aim angle must point the same way in
 * the 3D top-down view as in the Canvas 2D renderer (2D: screen = origin + (x, y)·scale, y down).
 * First-person is checked separately — there the view turns with the aim, movement does not.
 */
import { describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { ANGLE_UNITS, ARENA_H, ARENA_W, MAX_TURN, SPAWNS } from '@zkduel/shared/constants';
import { stepMovement } from '@zkduel/shared/sim';
import { movementFromKeys } from './input';
import { placeFirstPerson, placeOverview, radiansOf, worldOf, yawOf } from './renderer3dCamera';

const [P0_SPAWN, P1_SPAWN] = SPAWNS;
const VIEW_W = 1366;
const VIEW_H = 768;
/**
 * The angled camera is a perspective view: arena-vertical lines lean towards the vanishing point
 * (≈ 16° at the left/right edges) and diagonals are foreshortened. Below 22.5° every on-screen
 * direction still reads as the same one of the 8 compass directions as in 2D; a sign flip or
 * swapped axis would be ≥ 90° off.
 */
const MAX_BEND_DEG = 22.5;

function overview(): PerspectiveCamera {
  const cam = new PerspectiveCamera(42, VIEW_W / VIEW_H, 10, 5000);
  placeOverview(cam, ARENA_W, ARENA_H);
  cam.updateMatrixWorld(true);
  return cam;
}

/** World point → canvas pixels (x right, y down — same convention as the 2D canvas). */
function toScreen(cam: PerspectiveCamera, p: Vector3): { x: number; y: number } {
  const n = p.clone().project(cam);
  return { x: ((n.x + 1) / 2) * VIEW_W, y: ((1 - n.y) / 2) * VIEW_H };
}

/** Screen delta of the 2D renderer: uniform scale, no flip. */
function screen2d(dx: number, dy: number): { x: number; y: number } {
  return { x: dx, y: dy };
}

function bendDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const d = Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x);
  return Math.abs((((d * 180) / Math.PI + 540) % 360) - 180);
}

const POSITIONS: [string, number, number][] = [
  ['P0 spawn', P0_SPAWN.x, P0_SPAWN.y],
  ['P1 spawn', P1_SPAWN.x, P1_SPAWN.y],
  ['centre', ARENA_W / 2, ARENA_H / 2],
  ['top-left', 60, 60],
  ['bottom-right', ARENA_W - 60, ARENA_H - 60],
];

const KEYS: [string, string[], { x: number; y: number }][] = [
  ['W', ['w'], { x: 0, y: -1 }],
  ['A', ['a'], { x: -1, y: 0 }],
  ['S', ['s'], { x: 0, y: 1 }],
  ['D', ['d'], { x: 1, y: 0 }],
  ['W+D', ['w', 'd'], { x: 1, y: -1 }],
  ['S+A', ['s', 'a'], { x: -1, y: 1 }],
];

describe('3D top-down view matches the 2D renderer', () => {
  const cam = overview();

  for (const [key, held, expected] of KEYS) {
    for (const [where, x, y] of POSITIONS) {
      it(`${key} at ${where}`, () => {
        const { moveX, moveY } = movementFromKeys(new Set(held));
        const next = stepMovement(x, y, moveX, moveY);
        const d2 = screen2d(next.x - x, next.y - y);
        const a = toScreen(cam, worldOf(x, y));
        const b = toScreen(cam, worldOf(next.x, next.y));
        const d3 = { x: b.x - a.x, y: b.y - a.y };
        // 2D: exactly the expected screen direction
        expect(Math.sign(d2.x)).toBe(expected.x);
        expect(Math.sign(d2.y)).toBe(expected.y);
        // 3D: same signs on the dominant axes, same direction within the perspective bend
        if (expected.x !== 0) expect(Math.sign(d3.x)).toBe(expected.x);
        if (expected.y !== 0) expect(Math.sign(d3.y)).toBe(expected.y);
        expect(bendDeg(d3, d2)).toBeLessThan(MAX_BEND_DEG);
      });
    }
  }

  it('horizontal arena lines stay horizontal on screen (no roll)', () => {
    const a = toScreen(cam, worldOf(100, 500));
    const b = toScreen(cam, worldOf(900, 500));
    expect(Math.abs(b.y - a.y)).toBeLessThan(1e-6);
    expect(b.x).toBeGreaterThan(a.x);
  });

  for (let angle = 0; angle < ANGLE_UNITS; angle += ANGLE_UNITS / 16) {
    it(`aim angle ${angle}: barrel points where the 2D aim line points`, () => {
      for (const [, x, y] of POSITIONS) {
        const r = radiansOf(angle);
        const d2 = screen2d(Math.cos(r), Math.sin(r));
        // the player group: local +X barrel, rotated like renderer3d does it
        const g = new Object3D();
        g.position.copy(worldOf(x, y));
        g.rotation.y = yawOf(angle);
        g.updateMatrixWorld(true);
        const tip = g.localToWorld(new Vector3(40, 0, 0));
        const a = toScreen(cam, worldOf(x, y));
        const b = toScreen(cam, tip);
        expect(bendDeg({ x: b.x - a.x, y: b.y - a.y }, d2)).toBeLessThan(MAX_BEND_DEG);
      }
    });
  }

  it('a mouse move to the right turns the aim clockwise on screen in both renderers', () => {
    for (const angle of [0, 900, 1800, 2700]) {
      const before = radiansOf(angle);
      const after = radiansOf(angle + MAX_TURN);
      const cross2d = Math.cos(before) * Math.sin(after) - Math.sin(before) * Math.cos(after);
      expect(cross2d).toBeGreaterThan(0); // y-down screen: positive cross = clockwise
      const o = worldOf(ARENA_W / 2, ARENA_H / 2);
      const s0 = toScreen(cam, o);
      const tip = (ang: number) => {
        const g = new Object3D();
        g.position.copy(o);
        g.rotation.y = yawOf(ang);
        g.updateMatrixWorld(true);
        const p = toScreen(cam, g.localToWorld(new Vector3(40, 0, 0)));
        return { x: p.x - s0.x, y: p.y - s0.y };
      };
      const u = tip(angle);
      const v = tip(angle + MAX_TURN);
      expect(u.x * v.y - u.y * v.x).toBeGreaterThan(0);
    }
  });
});

describe('3D first-person view', () => {
  function fp(x: number, y: number, angle: number): PerspectiveCamera {
    const cam = new PerspectiveCamera(75, VIEW_W / VIEW_H, 1, 3000);
    placeFirstPerson(cam, x, y, angle);
    cam.updateMatrixWorld(true);
    return cam;
  }

  it('looks along the aim angle; a right turn moves the view to the right', () => {
    for (const angle of [0, 450, 900, 1800, 2700, 3150]) {
      const cam = fp(500, 300, angle);
      const r = radiansOf(angle);
      const ahead = toScreen(cam, worldOf(500 + Math.cos(r) * 200, 300 + Math.sin(r) * 200, 40));
      expect(ahead.x).toBeCloseTo(VIEW_W / 2, 3);
      expect(ahead.y).toBeCloseTo(VIEW_H / 2, 3);
      const r2 = radiansOf(angle + MAX_TURN);
      const turned = toScreen(cam, worldOf(500 + Math.cos(r2) * 200, 300 + Math.sin(r2) * 200, 40));
      expect(turned.x).toBeGreaterThan(VIEW_W / 2);
    }
  });

  it('movement is world-aligned: facing +x (P0 spawn), W (−y) goes to the left of the view', () => {
    // Documents current behaviour (input is unchanged by the renderer): in first-person, W is
    // "arena up", not "forward". Facing east, arena up is the player's left.
    const cam = fp(P0_SPAWN.x, P0_SPAWN.y, 0);
    const { moveX, moveY } = movementFromKeys(new Set(['w']));
    const next = stepMovement(P0_SPAWN.x, P0_SPAWN.y, moveX, moveY);
    // a point ahead, shifted the way W moves (×20 so it is well off-centre)
    const dy = (next.y - P0_SPAWN.y) * 20;
    const p = toScreen(cam, worldOf(P0_SPAWN.x + 200, P0_SPAWN.y + dy, 40));
    expect(dy).toBeLessThan(0);
    expect(p.x).toBeLessThan(VIEW_W / 2);
  });
});
