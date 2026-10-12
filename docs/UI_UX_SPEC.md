# UI/UX SPEC — ZK-Duel

## 1. Design direction

**"Lab instrument meets arena."** The game is a research demo shown to examiners, so the UI should feel precise and readable rather than flashy. Dark arena, crisp vector shapes, monospaced numbers for anything measured. The one signature element is the **proof strip** — a row of small cells that turn green or red as each window is verified. It should be legible from the back of a classroom.

## 2. Design tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0E1116` | Page background |
| `--surface` | `#161B22` | Panels, cards |
| `--surface-2` | `#1F2630` | Hover, inputs |
| `--border` | `#2D3643` | 1px dividers |
| `--text` | `#E6EDF3` | Primary text |
| `--text-muted` | `#8B98A9` | Labels, secondary |
| `--p0` | `#4FB3FF` | Player 0 (blue) |
| `--p1` | `#FF7A59` | Player 1 (orange) |
| `--valid` | `#3FB950` | Proof valid |
| `--invalid` | `#F85149` | Proof invalid / mismatch |
| `--pending` | `#D29922` | Proving / awaiting verify |
| `--timeout` | `#6E7681` | Proof missing (hatched) |
| `--arena-floor` | `#12161C` | Arena fill |
| `--arena-grid` | `#1B2129` | 50-unit grid lines |

Status is never shown by color alone: committed = hollow cell (`--border` outline, not yet proven), challenged / proving ◌ (`--pending`), valid ✓ (`--valid`), failure ✕ (`invalid`, `mismatch_*`, `missing_commit`, `malformed`, `unprovable`, `timeout` — `--invalid`), chain_broken ⛓ (`--timeout`), unaudited = hollow hatched (`--timeout`) inside each cell. The tooltip always names the exact status.

### Typography
| Role | Font | Size |
|---|---|---|
| Headings | Inter, 600 | 28 / 20 / 16 px |
| Body | Inter, 400 | 14–15 px |
| Numbers, HUD, timings | JetBrains Mono, 500 | 13–24 px, `tabular-nums` |

Load via Google Fonts; fall back to `system-ui` and `ui-monospace`.

### Spacing & shape
4 px base unit (4, 8, 12, 16, 24, 32). Radius 6 px on panels, 4 px on buttons, 2 px on proof cells. No drop shadows except the modal (one soft shadow).

## 3. Screens

### 3.1 Landing / Name entry (`/`)
```
┌───────────────────────────────────────────┐
│               ZK-DUEL                      │
│   1v1. Every move proven.                  │
│                                            │
│   [ Display name ____________ ]            │
│   [  Find Match  ]  [ Private Room ▾ ]     │
│                                            │
│   How it works · Benchmarks · About        │
└───────────────────────────────────────────┘
```
- Name validation inline (3–16, `[A-Za-z0-9_]`). Button disabled until valid.
- Private Room menu: *Create room* / *Join with code* (6-char input, auto-uppercase).
- "How it works" opens a 3-step explainer modal (play → prove → verify) with the limitation stated in one sentence.

### 3.2 Queue / Room wait
- Centered card: spinner, "Waiting for opponent…", elapsed time `00:12`, Cancel button.
- Private room: large room code in mono 32 px with a copy button.
- Below: "Loading proving key… 34%" progress bar (artefacts preload while waiting). Match cannot start until the key has loaded; if the opponent is ready first, show "Opponent ready".

### 3.3 Match (`/match/:id`)
```
┌──────────────────────────────────────────────────────────────┐
│ P0 name  ███████░░ 75   R 2–1   ░░░░░░███ 50  P1 name         │  top bar
│ proofs ▫▫✓▫◌▫▫▫  7/7       proofs ▫✓▫▫✕▫◌▫  4/5               │  proof strips + spot-checks
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    ARENA (1000×600, scaled to fit)            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ AMMO 7/10   ▮▮▮▮▮▮▮▯▯▯   RELOAD ──        prove 412 ms  ⚙     │  bottom HUD (own only)
└──────────────────────────────────────────────────────────────┘
```
- **Arena — 3D renderer (default, Phase 4.5, `client/src/game/renderer3d.ts`, Three.js):** rendering only — positions stay integer x, y on a flat floor, aim is a single yaw angle, shots are horizontal rays. 1000×600 floor in `--arena-floor` with a 50-unit grid (between `--arena-grid` and `--border` so it survives a projector), low walls (`--border`, 22 units) on the edges, hemisphere + directional light, no shadows. Players: low-poly capsules at their true radius (12) in `--p0`/`--p1` (self-lit base so they match the HUD colours), a light barrel at chest height and a floor arrow showing the aim direction; hits flash the capsule white for 4 frames. Shots: tracer lines in the shooter's colour at barrel height, clipped to the walls, fading over 140 ms. Opponent interpolated exactly as in 2D.
  - **Camera (V toggles, remembered per browser):** *Top-down* (default) — angled (58°) view of the whole arena, fitted to the window; *First-person* — eye height 40 at the own position, yaw = aim angle, no pitch, own capsule hidden, crosshair overlay. A small badge bottom-right shows the mode. Movement keys: arena-aligned in top-down (W = −y); facing-relative in first-person (W forward along the aim, S back, A/D strafe; the step is rotated with the integer sin/cos table and each axis rounded and clamped to ±MAX_SPEED, so it is always a legal step — no rule change).
  - HUD, proof strips, cheat drawer, banners and the settings overlay stay HTML overlays on top of the canvas.
- **Arena — Canvas 2D fallback (`?renderer=2d`, or automatically when WebGL is unavailable):** letterboxed to keep 5:3 ratio, scaled to fit window; 50-unit grid; players are filled circles in `--p0`/`--p1` with a 2 px aim line (length 28); shots are 1-frame tracer lines; hits flash the target white for 4 frames.
- **Top bar:** names, HP bars (smooth drain), round score in mono.
- **Proof strips:** last 10 windows per player, newest on the right; most cells are hollow (`committed`) during play — only challenged windows are proven live. Next to each strip: `Spot-checks: 7/7 passed` (challenges decided valid / decided). Hover/focus a cell shows tooltip `Window 14 · valid · challenged · prove 412 ms · verify 6 ms`.
- **Bottom HUD (own player only):** ammo count + pips, reload progress bar, last proof time, settings cog. The opponent's ammo is **never** shown (it is hidden state).
- **Countdown overlay:** 3-2-1 in mono 96 px, fades.
- **Round end:** banner "Round to P0" for 1.5 s.
- **Strict mode forfeit:** full-width red banner "Spot-check failed — window 14. Match forfeited." with the reason.
- **Cheat panel (dev only, F9):** right-side drawer, 280 px, toggles with labels; header badge `DEV`. Active cheats show a small red `CHEAT` tag under the player's name for both players — the demo is honest about what is on.

### 3.4 Results (`/match/:id/results`)
- Winner headline, round score.
- **Audit banner** at the top while the audit runs: "Auditing… 23/150 windows" (own windows proven / own windows to prove) with a progress bar and the opponent's progress; then the final status `AUDITED CLEAN` (green) / `AUDIT FAILED` (red) / `AUDIT INCOMPLETE` (grey); an `OVERTURNED` stamp when the winner's audit failed, an `UNVERIFIED` stamp (grey) when the winner's audit did not finish (the recorded result stays visible underneath in both cases). Leaving the page during the audit asks "Stop the audit? Remaining windows will be unaudited."
- Two columns (one per player): window counts per status (valid / failed by kind / committed / unaudited / chain_broken), spot-checks passed / issued, challenge rate r, live detection latency (Phase 4), audit duration, mean & p95 prove ms, mean verify ms, cheats active.
- Full proof timeline: one cell per window across the match (wraps).
- Buttons: *Back to lobby*, *Download match log (JSON)*. (Rematch dropped — not in PRD.)

### 3.5 Benchmarks (`/bench`)
- Run selectors: one Chrome run and one Node run (latest of each by default); both appear in every chart (colour = scheme, line style/marker = environment).
- Chart 1: proof time (ms, log) vs window size, median line with a p5–p95 band per scheme × environment, a dashed reference line for each window's play duration (N/60 s). Points under it are "real-time feasible".
- Chart 2: proof size (bytes) by scheme; Chart 3: verify time by scheme (grouped bars — two charts, one axis each).
- Chart 4: r_max ≈ window duration / mean prove time vs N, with the r = 1 line.
- Table: environment, scheme, N, constraints, mean/p50/p95 prove, witness, verify, proof bytes, peak memory, prove/play, r_max, valid/samples.
- *Export PNGs*: every chart re-rendered light on white at 1600×900 for slides.
- *Run benchmark in this browser* button with live progress, and *Export CSV*.

### 3.6 About / How it works
Static page: what is proven, what isn't (input provenance), seminar credit.

## 4. Components

| Component | Notes |
|---|---|
| `Button` | Primary (filled `--p0`), secondary (outline), danger (`--invalid`). 36 px height. Visible focus ring 2 px `--p0`. |
| `TextInput` | 36 px, `--surface-2`, error text below in `--invalid`. |
| `ProofCell` | 14×14 px, radius 2, symbol centered; `aria-label` with status. Pending cells pulse at 1 Hz (disabled under `prefers-reduced-motion`). |
| `ProofStrip` | Row of 10 `ProofCell`, 3 px gap. |
| `HPBar` | 160×10 px, team color fill, number at end in mono. |
| `AmmoPips` | 10 pips, 6×12 px. |
| `Toast` | Bottom-center, auto-dismiss 3 s; used for disconnects and errors. |
| `Modal` | Max 560 px wide, focus-trapped, Esc closes. |
| `Chart` | Chart.js line/bar, theme colors from tokens. |

## 5. Responsive behaviour

| Width | Behaviour |
|---|---|
| ≥ 1280 px | Full layout as drawn |
| 960–1279 | Arena scales down; bottom HUD condenses to one line |
| 720–959 | Proof strips move below top bar; cheat drawer overlays arena |
| < 720 | Match is not supported — show "ZK-Duel needs a keyboard and mouse on a larger screen." Landing, results and bench pages remain usable, single column |

## 6. Interaction details

- Pointer lock on click into arena; Esc releases and opens a pause-free settings overlay (the match keeps running).
- Sensitivity slider (settings): maps mouse delta to angle units; turn is clamped to `MAX_TURN` per tick regardless of sensitivity.
- Disconnect: opponent shows "Reconnecting… 5 s"; after 10 s, match ends with forfeit.
- All transitions ≤ 200 ms ease-out. Respect `prefers-reduced-motion`.

## 7. Accessibility

- Contrast ≥ 4.5:1 for text on `--bg`/`--surface`.
- Status conveyed by symbol + color + tooltip text.
- All non-game screens fully keyboard-navigable.
- Colorblind check: `--p0` blue vs `--p1` orange is safe for common deficiencies; `--valid`/`--invalid` always paired with ✓/✕.
