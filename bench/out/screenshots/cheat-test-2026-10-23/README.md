# Cheat test — 2026-10-23 (demo runs)

Live anti-cheat demo: private room, **cheater_A** (P0, dev cheat via the F9 drawer) vs **honest_B** (P1, no cheats). Both players were browser bots (`?bot=…&manual=1&acc=1800&miss=300`: they fire but never hit). Variant `groth16_60` (60-tick windows).

**These are demo runs, not part of the Phase 4 detection dataset.** They are not in `bench/out/detection.csv`, the `detection_runs` table or `bench/RESULTS.md`.

| Run | Match ID | Room | Enforcement | Cheat | end_reason | Winner | Match audit | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | `e07fd55e-138e-4626-bce1-a8d51f970256` | V2SY2D | observe | speedhack, windows 5–10 (on tick 300, off tick 660) | `forfeit` | cheater_A | `audited_failed` | **overturned** |
| 2 | `e0bb2f30-f008-4ed4-aeb9-cf49b813c255` | R4Y27F | strict | rapid_fire from window 10 (tick 600) | `forfeit_proof` | honest_B | `audited_failed` | verified |

> **Run 1's `forfeit`** came from the test harness: honest_B was opened with `&stopAfter=60`, so its client sent `{t:'forfeit'}` 60 s into the match. It was not a disconnect, and the game did not cause it. The audit then overturned the cheater's win. The harness (`bench/scripts/cheat-demo.mjs`) now leaves the honest player's `stopAfter` off by default.

## Per-player results

**Run 1: observe, speedhack**

| Player | Cheat | Committed | valid | invalid | mismatch_* | unprovable | timeout | Spot-checks | r | Audit | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cheater_A | speedhack w5–10 | 56 | 50 | 0 | 0 | 6 | 0 | 24/29 | 0.518 | `audited_failed` | won by forfeit, overturned |
| honest_B | none | 56 | 56 | 0 | 0 | 0 | 0 | 25/25 | 0.446 | `audited_clean` | result overturned in their favour |

**Run 2: strict, rapid fire**

| Player | Cheat | Committed | valid | invalid | mismatch_* | unprovable | timeout | Spot-checks | r | Audit | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cheater_A | rapid_fire from w10 | 15 | 12 | 0 | 0 | 3 (w10, 11, 13) | 0 | 6/7 | 0.467 | `audited_failed` | lost by proof forfeit |
| honest_B | none | 15 | 15 | 0 | 0 | 0 | 0 | 7/7 | 0.467 | `audited_clean` | winner, verified |

## Detection

| | Run 1 (speedhack) | Run 2 (rapid fire) |
|---|---|---|
| First failed window | w7, `unprovable` (witness assert in `SpeedCheck → InRange`) | w10, `unprovable` (witness assert in `WeaponStep`) |
| Cheat on → first detection | **3.38 s** (2 windows) | **5.72 s** (0 windows) |
| Caught | live (5 of 6 failed windows live; w6 in the audit); observe mode, so play continued | live, and the match ended with `forfeit_proof`; w11 and w13 failed in the audit |

honest_B: every window was valid in both runs (56/56 and 15/15), both `audited_clean`, so there were no false positives.

## Files

- `run1-*.png`, `run2-*.png`: HUD, proof strip, forfeit banners and results pages.
- `raw/run1.json`, `raw/run2.json`: harness output (config, cheat on/off/detect times, server summary, per-window statuses, public server→client frames).
- `raw/run1.log`, `raw/run2.log`: harness console logs.
- `raw/server.log`: the server's stdout for both runs.
