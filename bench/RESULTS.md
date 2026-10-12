# Phase 5 — Benchmark results

All numbers below are from **one session on 2026-10-12** (after a reboot), so they are comparable with each other. Tables come from `npx tsx bench/tables.ts` (raw files in `bench/out/raw/`); per-sample rows in `bench/out/results.csv` (`npm run bench:export`); charts in `bench/out/charts/` (`npm run bench:browser -- --export-only`).

## Conditions
- Dev laptop: Intel Core 5 210H (8 cores / 12 threads), 16 GB RAM, Windows 11. Node 22.23.3, snarkjs 0.7.6, Chrome via Playwright (visible window, one tab in front), production build (`npm run perf:serve`).
- **AC power, Windows "Performance" scheme + "Best performance" overlay** for every sample. A watcher logged the power state every 5 s during the runs (and would restore the scheme if ASUS Armoury Crate switched it); **no mode change or charger drop happened**, so no sample was re-run.
- Idle CPU load before the runs: 2–13 %. Pre-run check (groth16_60, Node, 2 warm-ups + 3 samples): prove p50 **1.17 s**, within 10 % of the clean 1.24 s reference → measured runs started. That check and an earlier slow pre-reboot check (1.92 s) are kept in `bench/out/excluded/` and are **not** used here.
- Input: deterministic bench log `bench-seed42-2640t.jsonl` (seed 42, sha256 `3e254c95…4d67`), sliced into windows of N ticks; the same windows for every variant and environment.
- Groth16: 2 warm-ups (not stored) + **20 samples** per variant and environment. PLONK: fewer samples (owner decision, see below). Valid = proof verifies **and** the public signals equal the JS reference.

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

## PLONK — impractical for live play on this laptop

Same circuits, same input windows, snarkjs PLONK (universal setup, ptau up to power 21). Owner decision: fewer samples, because one PLONK proof takes 2.5–12 min here.

| env | variant | R1CS / PLONK constraints | zkey | warm-ups + samples (valid) | prove mean s | p5 | p50 | p95 | verify p50 ms | proof B | peak MiB | prove/play | r_max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Node | plonk_30 | 16,968 / 270,648 | 0.99 GiB | 1 + 5 (5) | 162.7 | 162.3 | 162.6 | 163.0 | 8.3 | 2,098 | 5,178 | 325 | 0.003 |
| Node | plonk_60 | 32,748 / 530,058 | 1.98 GiB | 1 + 5 (5) | 327.3 | 325.3 | 327.0 | 329.7 | 8.8 | 2,101 | 9,374 | 327 | 0.003 |
| Node | plonk_120 | 64,308 / 1,097,478 | 3.96 GiB | 1 + 3 (3) | 703.2 | 691.9 | 705.6 | 712.2 | 14.3 | 2,098 | 11,147 | 352 | 0.003 |
| Chrome | plonk_30 | 16,968 / 270,648 | 0.99 GiB | 1 + 3 (3) | 147.6 | 147.3 | 147.5 | 147.8 | 11.6 | 2,098 | 6,969 | 295 | 0.003 |
| Chrome | plonk_60 | 32,748 / 530,058 | 1.98 GiB | 0 + 1 (1) | 397.9 | – | 397.9 | – | 28.1 | 2,098 | 15,492 | 398 | 0.003 |
| Chrome | plonk_120 | 64,308 / 1,097,478 | 3.96 GiB | 0 + 0 | **failed** | | | | | | | | |

- **Chrome plonk_120 result = error:** the zkey download failed after 9 s with `Failed to fetch` (exact error, no proof attempted; no retry, per plan). The zkey is 3.96 GiB. I have not confirmed which browser limit was hit (size of one response body / ArrayBuffer vs memory). Not uploaded (an upload needs ≥ 1 sample); recorded in `bench/out/raw/browser-…` for that run.
- **Memory is the limit, not just time:** Chrome plonk_60 peaked at **15.5 GiB** of the laptop's 16 GB (one proof only, as planned). Node plonk_120 peaked at 11.1 GiB; during that run Claude Code's own memory guard reaped the background shell (the Node process itself survived and finished 3/3 valid, see below).
- PLONK proves **170–320× slower than Groth16** at the same N (p50; Node 216× at N = 30 up to 319× at N = 120, Chrome 173–319×). prove/play ≈ 300–400: a 1-second window takes 5–7 minutes to prove, so r_max ≈ 0.003 — **not usable for live spot-checks or a post-match audit** on this hardware. The cause is the PLONK constraint count (≈ 16–17 × the R1CS count: every gate, including additions, becomes a PLONK row) and the larger FFTs.
- PLONK proofs are ≈ 2.1 kB vs 0.72 kB for Groth16; verify time is similar (8–28 ms). PLONK's advantage — a universal, circuit-independent setup with no per-circuit phase-2 ceremony — does not offset the proving cost here.
- Chrome plonk_30 was 9 % **faster** than Node (147.6 vs 162.7 s); for Groth16 Chrome was slower. Observed, not explained (n = 3 vs 5).
- Chrome memory for PLONK: the test browser's baseline was 0.31–0.36 GiB before each PLONK variant (one fresh browser per variant), so these peaks are mostly the prover.

### Caveats for the PLONK runs
- **Idle driver process overlapping plonk_30/60 Node (and the start of plonk_120):** the Chrome Groth16 driver's process stayed alive from its last output (16:24) until 17:54 because a 90-min timeout timer was never cleared. The browser had already closed and the charts were exported, so the process was idle on a timer; the expected effect is negligible, and the plonk_30/60 samples are tight (p5–p95 within 0.4 % / 1.4 %). Fixed in `client/scripts/bench-browser.ts` (`81bc898`).
- **plonk_120 Node:** I first reported this run as stopped at sample 2 (the reaped shell's log ended there) and recorded the logged warm-up + sample 1 as a partial result. The Node process had in fact finished all 3 samples and uploaded them, so the complete run is used; the partial record is in `bench/out/excluded/`. Its database copy (run `7b5f5110…`, 1 sample duplicating sample 1 of the complete run) was deleted with the owner's approval; `bench/out/results.csv` was regenerated (137 samples).

## Limitations
- **One machine only.** All numbers are from the baseline laptop (Intel Core 5 210H, 16 GB). The planned run on a stronger machine was **not done — deferred to future work**; how PLONK scales with more RAM/cores and how Groth16 prove/play changes on faster hardware is untested.
- PLONK sample counts are small (Chrome plonk_60: one proof) and Chrome plonk_120 has no measurement (zkey load failed).
- Chrome memory is the whole test browser's private bytes (upper bound).

## Charts
`bench/out/charts/` (exported from the `/bench` dashboard, default selection "Best run per variant (all runs)": per scheme × N, the run with the most samples):
- `prove-time-vs-n.png` — p50 with p5–p95 band, log scale, Groth16 and PLONK for Node and Chrome, with the play-time line (below it = keeps up with play). The subtitle states n per point (1–20).
- `verify-time.png`, `proof-size.png`, `r-max-vs-n.png`, `detection-matrix.png` (Phase 4 detection experiment). Chrome plonk_120 has no point (failed).
