/**
 * Three.js renderer (Phase 4.5) — a second GameRenderer behind the seam in view.ts. Rendering only:
 * the game stays 2D and integer (x, y on a flat floor, one yaw angle, horizontal hit-scan rays);
 * this file just draws a RenderFrame in 3D. Like the Canvas 2D renderer it knows nothing about the
 * sim, input or network (lint-enforced).
 *
 * World mapping: arena x → X, arena y → Z, Y is up. Heading (cos a, sin a) in arena units becomes
 * (cos a, 0, sin a), so a positive turn is a right turn in first-person as well.
 *
 * Camera modes (V): 'third' — angled top-down view of the whole arena (default, projector friendly)
 * and 'first' — first-person from the own player's position, yaw = aim angle, no pitch, crosshair.
 */
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { PLAYER_RADIUS, RAY_LENGTH } from '@zkduel/shared/constants';
import type { GameRenderer, RenderFrame, RenderPlayer } from './view';
import { placeFirstPerson, placeOverview, radiansOf, yawOf } from './renderer3dCamera';

export type CameraMode = 'third' | 'first';

const GRID = 50;
const WALL_H = 22;
const WALL_T = 8;
const BODY_LEN = 20; // capsule cylinder part; total height = BODY_LEN + 2·R
const BARREL_H = 28;
const TRACER_MS = 140;
const FLASH_COLOR = new Color('#FFFFFF');
const BODY_GLOW = 0.45;
const MODE_KEY = 'zkd.camera';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

interface PlayerView {
  group: Group;
  body: MeshStandardMaterial;
  base: Color;
}

interface Tracer {
  line: Line;
  bornAt: number;
}

class ThreeRenderer implements GameRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly cam3: PerspectiveCamera;
  private readonly cam1: PerspectiveCamera;
  private readonly players: [PlayerView, PlayerView];
  private readonly tracers: Tracer[] = [];
  private readonly crosshair: HTMLElement;
  private readonly modeBadge: HTMLElement;
  private readonly colors = {
    bg: cssVar('--bg', '#0E1116'),
    floor: cssVar('--arena-floor', '#12161C'),
    grid: cssVar('--arena-grid', '#1B2129'),
    border: cssVar('--border', '#2D3643'),
    p0: cssVar('--p0', '#4FB3FF'),
    p1: cssVar('--p1', '#FF7A59'),
    aim: cssVar('--text', '#E6EDF3'),
  };
  private arena = { w: 1000, h: 600 };
  private built = false;
  private readonly size = new Vector2();
  mode: CameraMode;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.background = new Color(this.colors.bg);
    this.cam3 = new PerspectiveCamera(42, 1, 10, 5000);
    this.cam1 = new PerspectiveCamera(75, 1, 1, 3000);

    this.scene.add(new HemisphereLight(0xdfe8ff, 0x1a1f26, 1.4));
    this.scene.add(new AmbientLight(0xffffff, 0.25));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(250, 900, 150);
    this.scene.add(sun);

    this.players = [this.makePlayer(this.colors.p0), this.makePlayer(this.colors.p1)];

    // HTML overlays (siblings of the canvas): crosshair in first-person, camera mode badge
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'crosshair';
    this.crosshair.hidden = true;
    this.modeBadge = document.createElement('div');
    this.modeBadge.className = 'camera-badge mono';
    canvas.parentElement?.append(this.crosshair, this.modeBadge);

    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MODE_KEY);
    } catch {
      saved = null;
    }
    this.mode = saved === 'first' ? 'first' : 'third';
    this.applyMode();
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyV' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    this.setMode(this.mode === 'third' ? 'first' : 'third');
  };

  isFirstPerson(): boolean {
    return this.mode === 'first';
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* per-viewer convenience only */
    }
    this.applyMode();
  }

  private applyMode(): void {
    this.crosshair.hidden = this.mode !== 'first';
    this.modeBadge.textContent = this.mode === 'first' ? 'FIRST-PERSON · V' : 'TOP-DOWN · V';
  }

  private makePlayer(color: string): PlayerView {
    const group = new Group();
    // a self-lit base keeps the capsule at the HUD's player colour (readable on a projector)
    const body = new MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      emissive: new Color(color),
      emissiveIntensity: BODY_GLOW,
    });
    const capsule = new Mesh(new CapsuleGeometry(PLAYER_RADIUS, BODY_LEN, 6, 16), body);
    capsule.position.y = BODY_LEN / 2 + PLAYER_RADIUS;
    group.add(capsule);
    // aim direction: a barrel at chest height and an arrow on the floor, both along local +X
    const accent = new MeshStandardMaterial({ color: this.colors.aim, roughness: 0.4 });
    const barrel = new Mesh(new BoxGeometry(26, 5, 5), accent);
    barrel.position.set(PLAYER_RADIUS + 9, BARREL_H, 0);
    group.add(barrel);
    const arrow = new Mesh(
      new ConeGeometry(6, 14, 3),
      new MeshStandardMaterial({ color, roughness: 0.6 }),
    );
    arrow.rotation.z = -Math.PI / 2;
    arrow.position.set(PLAYER_RADIUS + 16, 1.5, 0);
    group.add(arrow);
    group.visible = false;
    this.scene.add(group);
    return { group, body, base: new Color(color) };
  }

  private buildArena(w: number, h: number): void {
    this.arena = { w, h };
    const floor = new Mesh(
      new PlaneGeometry(w, h),
      new MeshStandardMaterial({ color: this.colors.floor, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(w / 2, 0, h / 2);
    this.scene.add(floor);

    const pts: number[] = [];
    for (let x = GRID; x < w; x += GRID) pts.push(x, 0.4, 0, x, 0.4, h);
    for (let z = GRID; z < h; z += GRID) pts.push(0, 0.4, z, w, 0.4, z);
    const grid = new BufferGeometry();
    grid.setAttribute('position', new Float32BufferAttribute(pts, 3));
    // a touch brighter than --arena-grid so the grid survives a projector
    const gc = new Color(this.colors.grid).lerp(new Color(this.colors.border), 0.5);
    this.scene.add(new LineSegments(grid, new LineBasicMaterial({ color: gc })));

    const wallMat = new MeshStandardMaterial({ color: this.colors.border, roughness: 0.8 });
    const wall = (sx: number, sz: number, x: number, z: number) => {
      const m = new Mesh(new BoxGeometry(sx, WALL_H, sz), wallMat);
      m.position.set(x, WALL_H / 2, z);
      this.scene.add(m);
    };
    wall(w + 2 * WALL_T, WALL_T, w / 2, -WALL_T / 2);
    wall(w + 2 * WALL_T, WALL_T, w / 2, h + WALL_T / 2);
    wall(WALL_T, h, -WALL_T / 2, h / 2);
    wall(WALL_T, h, w + WALL_T / 2, h / 2);
    this.built = true;
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const size = this.renderer.getSize(this.size);
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      for (const c of [this.cam1, this.cam3]) {
        c.aspect = w / h;
        c.updateProjectionMatrix();
      }
      this.placeOverview();
    }
  }

  /** Angled top-down camera that keeps the whole arena in view for the current aspect ratio. */
  private placeOverview(): void {
    placeOverview(this.cam3, this.arena.w, this.arena.h);
  }

  draw(frame: RenderFrame): void {
    if (!this.built) {
      this.buildArena(frame.arena.width, frame.arena.height);
      this.placeOverview();
    }
    const now = performance.now();
    let self: RenderPlayer | null = null;
    frame.players.forEach((p, i) => {
      const v = this.players[i as 0 | 1];
      if (!p) {
        v.group.visible = false;
        return;
      }
      if (p.isSelf) self = p;
      v.group.visible = !(p.isSelf && this.mode === 'first');
      v.group.position.set(p.x, 0, p.y);
      v.group.rotation.y = yawOf(p.angle);
      v.body.emissive.copy(p.flashing ? FLASH_COLOR : v.base);
      v.body.emissiveIntensity = p.flashing ? 0.9 : BODY_GLOW;
    });

    for (const t of frame.tracers) this.addTracer(t.x, t.y, t.angle, t.player, now);
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i] as Tracer;
      const age = now - tr.bornAt;
      if (age >= TRACER_MS) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        (tr.line.material as LineBasicMaterial).dispose();
        this.tracers.splice(i, 1);
      } else {
        (tr.line.material as LineBasicMaterial).opacity = 0.95 * (1 - age / TRACER_MS);
      }
    }

    let cam: PerspectiveCamera = this.cam3;
    const me = self as RenderPlayer | null;
    if (this.mode === 'first' && me) {
      placeFirstPerson(this.cam1, me.x, me.y, me.angle);
      cam = this.cam1;
    }
    this.renderer.render(this.scene, cam);
  }

  /** Horizontal hit-scan ray at barrel height, clipped to the arena walls. */
  private addTracer(x: number, y: number, angle: number, player: number, now: number): void {
    const a = radiansOf(angle);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let len = RAY_LENGTH;
    const { w, h } = this.arena;
    if (dx > 0) len = Math.min(len, (w - x) / dx);
    if (dx < 0) len = Math.min(len, -x / dx);
    if (dy > 0) len = Math.min(len, (h - y) / dy);
    if (dy < 0) len = Math.min(len, -y / dy);
    const g = new BufferGeometry().setFromPoints([
      new Vector3(x + dx * PLAYER_RADIUS, BARREL_H, y + dy * PLAYER_RADIUS),
      new Vector3(x + dx * len, BARREL_H, y + dy * len),
    ]);
    const mat = new LineBasicMaterial({
      color: player === 0 ? this.colors.p0 : this.colors.p1,
      transparent: true,
      opacity: 0.95,
    });
    const line = new Line(g, mat);
    this.scene.add(line);
    this.tracers.push({ line, bornAt: now });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.crosshair.remove();
    this.modeBadge.remove();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
  }
}

export function createThreeRenderer(canvas: HTMLCanvasElement): GameRenderer {
  return new ThreeRenderer(canvas);
}
