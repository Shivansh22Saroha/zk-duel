# Phase 5 — Benchmark results

All numbers below are from **one session on 2026-10-12** (after a reboot), so they are comparable with each other. Tables come from `npx tsx bench/tables.ts` (raw files in `bench/out/raw/`); per-sample rows in `bench/out/results.csv` (`npm run bench:export`); charts in `bench/out/charts/` (`npm run bench:browser -- --export-only`).

## Conditions
- Dev laptop: Intel Core 5 210H (8 cores / 12 threads), 16 GB RAM, Windows 11. Node 22.23.3, snarkjs 0.7.6, Chrome via Playwright (visible window, one tab in front), production build (`npm run perf:serve`).
- **AC power, Windows "Performance" scheme + "Best performance" overlay** for every sample. A watcher logged the power state every 5 s during the runs (and would restore the scheme if ASUS Armoury Crate switched it); **no mode change or charger drop happened**, so no sample was re-run.
- Idle CPU load before the runs: 2–13 %. Pre-run check (groth16_60, Node, 2 warm-ups + 3 samples): prove p50 **1.17 s**, within 10 % of the clean 1.24 s reference → measured runs started. That check and an earlier slow pre-reboot check (1.92 s) are kept in `bench/out/excluded/` and are **not** used here.
- Input: deterministic bench log `bench-seed42-2640t.jsonl` (seed 42, sha256 `3e254c95…4d67`), sliced into windows of N ticks; the same windows for every variant and environment.
- Groth16: 2 warm-ups (not stored) + **20 samples** per variant and environment. Valid = proof verifies **and** the public signals equal the JS reference.

## Groth16

| env | variant | constraints | n (valid) | witness p50 ms | prove mean s | p5 | p50 | p95 | verify p50 ms | proof B | peak MiB | prove/play | r_max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Node | groth16_30 | 16,968 | 20 (20) | 61 | 0.76 | 0.74 | 0.75 | 0.77 | 9.9 | 723 | 945 | 1.51 | 0.66 |
| Node | groth16_60 | 32,748 | 20 (20) | 78 | 1.16 | 1.13 | 1.15 | 1.19 | 7.2 | 723 | 991 | 1.16 | 0.86 |
| Node | groth16_120 | 64,308 | 20 (20) | 118 | 2.21 | 2.15 | 2.21 | 2.25 | 10.1 | 723 | 1090 | 1.10 | 0.91 |
| Chrome | groth16_30 | 16,968 | 20 (20) | 52 | 0.86 | 0.82 | 0.85 | 0.90 | 8.0 | 723 | 3480 | 1.72 | 0.58 |
| Chrome | groth16_60 | 32,748 | 20 (20) | 62 | 1.25 | 1.20 | 1.25 | 1.28 | 7.2 | 723 | 5640 | 1.25 | 0.80 |
| Chrome | groth16_120 | 64,308 | 20 (20) | 118 | 2.43 | 2.35 | 2.41 | 2.56 | 7.5 | 722 | 3724 | 1.22 | 0.82 |

**Earlier clean measurements (Phase 3/4, different sessions — reference only, not part of this run):**

| env | variant | prove p50 s | source |
|---|---|---|---|
| Node | groth16_60 | 1.19–1.24 | Phase 3 profile / Phase 5 pre-reboot clean check (AC) |
| Chrome | groth16_30 | 0.89 | Phase 3 Step 1 (AC) |
| Chrome | groth16_60 | 1.42 | Phase 3 Step 1 (AC) |

Today's numbers are 3–7 % (Node) and 4–12 % (Chrome) **faster** than the earlier ones. The likely reason is that the Performance scheme + Best-performance overlay is now enforced for the whole run, whereas Phase 3 only checked AC power; this is not proven.

### Reading the table
- **prove/play** = mean prove time ÷ the play time one window covers (N / 60 s). Every Groth16 variant is **> 1**: one prover on this laptop cannot prove every window as fast as it is played. This is why the game proves only spot-checked windows live (commit/challenge) and the rest in the post-match audit.
- **r_max** = play time ÷ mean prove time = the largest challenge rate one prover can sustain. Larger windows amortise the fixed cost better (Node 0.66 → 0.86 → 0.91 for N = 30 → 60 → 120), but a challenged window then takes longer to answer (2.2–2.4 s at N = 120).
- Prove time grows roughly linearly with constraints (≈ 34 µs/constraint in Node at N = 120, more at N = 30 because of the fixed cost). Witness generation is 5–8 % of proving.
- Verify time (7–10 ms) and proof size (722–726 B; JSON as sent on the wire) do not depend on N — as expected for Groth16.
- Chrome proving is 9–13 % slower than Node (p50).
- **Memory:** Node = peak process RSS. Chrome = peak private bytes summed over **all processes of the test browser**, so it includes the browser's own baseline, which varied between tabs (2.36 GiB before groth16_30/60, 0.27 GiB before groth16_120). The Chrome column is therefore an upper bound, not the prover's memory alone.

## Charts
- `bench/out/charts/prove-time-vs-n.png` — p50 with p5–p95 band, log scale, with the play-time line (below it = keeps up with play).
- `verify-time.png`, `proof-size.png`, `r-max-vs-n.png`, `detection-matrix.png` (Phase 4 detection experiment).

## PLONK
_Pending (next step)._
