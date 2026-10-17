# ZK-Duel — Results and Limitations (seminar report sections)

Draft sections for the CSC301 seminar report. Every number below is a measurement from this repository; the source of each table is named under it, so it can be re-checked or regenerated. Nothing is estimated unless it says so.

**Test machine (all results):** Intel Core 5 210H (8 cores / 12 threads), 16 GB RAM, Windows 11, AC power with the Windows "Performance" scheme. Node 22.23.3, snarkjs 0.7.6, Chrome (production build). Circuits compiled with circom `--O2`.

---

## 1. Results

### 1.1 What was measured

| Question (PRD) | Experiment | Data |
|---|---|---|
| Objective 3: how do Groth16 and PLONK compare against real-time budgets? | 12 variants (Groth16 / PLONK × N = 30 / 60 / 120 ticks × Node / Chrome), same input windows for every variant | `bench/out/results.csv` (137 samples), `bench/RESULTS.md` |
| Objective 4: does commit + random spot-check + post-match audit catch rule-breaking cheats, and how fast? | 135 matches with a scripted cheat (5 cheats × m = 1 / 5 / 20 cheated windows, Node bots; plus one live run per cheat in two Chrome windows) | `bench/out/detection.csv` (rows 1–135) |
| Is the game still playable while proving? | 3-minute matches, two Chrome windows on one laptop, both proving throughout | CHANGELOG Phase 3 / 4.5 |

### 1.2 Circuit size

One circuit proves one window of N ticks: movement speed, arena bounds, turn rate, and the weapon state machine (ammo, cooldown, reload) over committed hidden state. It also binds the window to the public snapshot digest and to the commitments of the windows before and after it.

| N (ticks) | Window length | R1CS constraints | PLONK constraints | Groth16 zkey | PLONK zkey |
|---|---|---|---|---|---|
| 30 | 0.5 s | 16,968 | 270,648 | – | 0.99 GiB |
| 60 | 1.0 s | 32,748 | 530,058 | 34.8 MiB | 1.98 GiB |
| 120 | 2.0 s | 64,308 | 1,097,478 | – | 3.96 GiB |

The constraint count grows linearly with N (≈ 537 constraints per tick). PLONK needs ≈ 16–17× as many constraints as R1CS, because every gate (additions too) becomes a PLONK row.

### 1.3 Groth16 performance (Objective 3)

20 samples per variant and environment, after 2 warm-ups. All 120 samples were valid: each proof verifies and its public signals equal the JavaScript reference.

| env | N | witness p50 | prove p50 (p5–p95) | verify p50 | proof size | prove / play | r_max |
|---|---|---|---|---|---|---|---|
| Node | 30 | 61 ms | 0.75 s (0.74–0.77) | 9.9 ms | 723 B | 1.51 | 0.66 |
| Node | 60 | 78 ms | 1.15 s (1.13–1.19) | 7.2 ms | 723 B | 1.16 | 0.86 |
| Node | 120 | 118 ms | 2.21 s (2.15–2.25) | 10.1 ms | 723 B | 1.10 | 0.91 |
| Chrome | 30 | 52 ms | 0.85 s (0.82–0.90) | 8.0 ms | 723 B | 1.72 | 0.58 |
| Chrome | 60 | 62 ms | 1.25 s (1.20–1.28) | 7.2 ms | 723 B | 1.25 | 0.80 |
| Chrome | 120 | 118 ms | 2.41 s (2.35–2.56) | 7.5 ms | 722 B | 1.22 | 0.82 |

*prove / play* = mean prove time ÷ the play time the window covers. *r_max* = the inverse, i.e. the largest fraction of windows one prover can keep up with.

Key findings:
- **Groth16 cannot prove every window in real time on this laptop.** prove / play is above 1 for every variant (1.10–1.72). So the design commits to every window and proves only a random sample live (spot-checks). The rest are proven in a post-match audit.
- **Larger windows spread the fixed cost better** (Node r_max 0.66 → 0.86 → 0.91). The trade-off is that a challenged window takes longer to answer: 2.2–2.4 s at N = 120 vs 0.75–0.85 s at N = 30. N = 60 is the live default.
- **Verification is cheap and constant:** 7–10 ms and ≈ 723 B, whatever N is. The server verifies in a worker pool; under integration-test load it measured p50 9.5 ms / p95 12.8 ms (n = 390).
- Proving in Chrome is 9–13 % slower than in Node. Witness generation takes 5–8 % of the proving time.

Chart: `bench/out/charts/prove-time-vs-n.png` (log scale, with the play-time line), plus `r-max-vs-n.png`, `verify-time.png` and `proof-size.png`.

### 1.4 PLONK performance (Objective 3)

The PLONK runs used fewer samples, because one proof takes minutes (owner decision).

| env | N | samples (valid) | prove p50 | verify p50 | proof size | peak memory | prove / play |
|---|---|---|---|---|---|---|---|
| Node | 30 | 5 (5) | 162.6 s | 8.3 ms | 2,098 B | 5.1 GiB | 325 |
| Node | 60 | 5 (5) | 327.0 s | 8.8 ms | 2,101 B | 9.2 GiB | 327 |
| Node | 120 | 3 (3) | 705.6 s | 14.3 ms | 2,098 B | 10.9 GiB | 352 |
| Chrome | 30 | 3 (3) | 147.5 s | 11.6 ms | 2,098 B | 6.8 GiB | 295 |
| Chrome | 60 | 1 (1) | 397.9 s | 28.1 ms | 2,098 B | 15.1 GiB | 398 |
| Chrome | 120 | 0 | **failed**: 3.96 GiB zkey download, `Failed to fetch` | | | | |

- **On this hardware PLONK proves 170–320× slower than Groth16** at the same N. One second of play takes 5–7 minutes to prove (r_max ≈ 0.003). That is too slow for live spot-checks and too slow for a post-match audit.
- **Memory is a hard limit.** Chrome plonk_60 peaked at 15.1 GiB of the laptop's 16 GB. Chrome could not load the plonk_120 zkey at all.
- PLONK proofs are ≈ 2.9× larger (2.1 kB vs 0.72 kB). Verification time is similar.
- PLONK's advantage is a universal setup, with no per-circuit ceremony (see Limitation L2). That does not make up for the proving cost here.

**Objective 3 answer:** of the two schemes, only Groth16 is usable for a real-time game in the browser on a mid-range laptop. Even Groth16 is usable only with sampling (spot-checks) plus a deferred full audit, not with proving every window.

### 1.5 Detection of cheats (Objective 4)

**Setup.** Every window's commitment is fixed when the window ends. The server challenges random still-unproven windows during play. After the match, every remaining window is proven (the audit). A cheat is switched on from window 3 for m windows.

- *Node matrix:* 4 rule-breaking cheats × m ∈ {1, 5, 20} × 10 runs, plus smooth-aim × 10. Two Node bots prove in worker threads on the same CPU, with N = 60 and the real groth16_60 circuit.
- *Browser:* one live run per cheat in two Chrome windows on one laptop.

**Outcome per match (all 135 runs):**

| | runs | final status of the cheater |
|---|---|---|
| Rule-breaking cheats (speedhack, rapid-fire, infinite ammo, snap-aim) | 124 (120 Node + 4 browser) | **124/124 `audited_failed`** |
| Smooth-aim (stays within the turn-rate limit) | 11 (10 Node + 1 browser) | **11/11 `audited_clean`** |

Anomalies: none. In every run, every cheater window that broke a rule failed, and every other window was valid. Ground truth for this check is the rule checker run on the cheater's own tick log.

**Live catch rate vs prediction (Node):**

| m (cheated windows) | live catch rate | naive 1 − (1 − r)^m | scheduler-aware prediction |
|---|---|---|---|
| 1 | **34/40 = 85 %** (95 % CI ≈ 70–94 %) | ≈ 55 % | ≈ 81 % |
| 5 | 40/40 = 100 % | 97–100 % | 100 % |
| 20 | 40/40 = 100 % | 100 % | 100 % |

- **The naive formula is a lower bound, not a prediction.** It assumes each window is checked independently with probability r. The scheduler actually draws uniformly from all windows of the round that are not yet proven, so a window that ends early in a round stays in the pool for many draws. A Monte Carlo replay of each run's real challenge times (`server/scripts/detection.ts`) gives 81 %, inside the binomial margin of the observed 85 %.
- **The corollary: windows near the end of a round are rarely checked live.** Spot-checks alone cannot guarantee detection. The six m = 1 cheats that were not caught live were all caught by the audit. **The post-match audit is what makes the guarantee complete.**
- **Achieved challenge rate:** r ≈ 0.49 in honest play with two Node provers, and 0.34–0.65 with two Chrome provers. It rises to 0.53–0.85 while cheating, because a cheated window fails within milliseconds (witness generation aborts) and the next challenge comes sooner.
- **Effective cheat length can be shorter than nominal.** Rapid-fire only breaks a rule when a shot falls inside the cooldown, so on average only 3.7 of 5 (and 13 of 20) cheated windows actually broke a rule.

**Live detection latency** (time from switching the cheat on to the first failed spot-check):

| | live catches | median | p95 | max | caught in the activation window | within ≤ 3 windows |
|---|---|---|---|---|---|---|
| Node | 114 | 4.5 s | 8.6 s | 10.6 s | 62/114 | 113/114 |
| Node + browser | 118 | 4.5 s | 8.6 s | 10.6 s | 64/118 | 117/118 |

With strict enforcement, a failed spot-check ends the match immediately. In the browser E2E test (strict mode, speedhack), the forfeit came 1.6–2.3 s after activation.

Chart: `bench/out/charts/detection-matrix.png`. Full matrix (per cheat, m and environment): CHANGELOG → Phase 4 → "Detection experiment — results".

**Objective 4 answer:** ZK proofs over committed hidden state catch every cheat that breaks a rule the circuit encodes. Most are caught live within seconds, and the rest are caught for certain by the audit. They do not catch a cheat that stays inside the rules (smooth-aim; see L1). That gap is the reason for the hybrid recommendation: ZKPs for auditable rule claims, server-side and behavioural detection for input provenance.

### 1.6 Playability while proving

These runs are the worst case: two Chrome windows on one laptop, each running a 12-thread prover on the same 8-core CPU, with the server on the same machine as well.

| Run | play | spot-checks | audit | frame interval p95 (≈ 144 Hz display) |
|---|---|---|---|---|
| Phase 3: honest 3-min match, Canvas 2D | 180 windows / player | 64/64 passed, r = 0.36 | 242 s, 180/180 valid → `audited_clean` | 7.1 ms |
| Phase 4.5: 90 s, Canvas 2D | 90 windows / player | all passed | 316 s* → `audited_clean` | 7.1 ms |
| Phase 4.5: 90 s, 3D top-down / first-person | 90 windows / player | all passed | 135 s → `audited_clean` | 13.9 ms |

\* That 2D run happened to have background load on the laptop (its spot-check prove mean was 4.3 s vs 2.3 s in the other runs).

- **Proving does not hurt frame time**, because the prover runs in a Web Worker. The 2D frame p95 stays at one refresh interval (7.1 ms), and 3D stays at two (13.9 ms). Both are within the 20 ms requirement (NFR-2).
- With both provers sharing one CPU, a live spot-check proof takes ≈ 2.2 s on average (p95 2.8 s), against 1.25 s for one prover alone.
- **The audit is the visible cost.** After a 3-minute match the players wait about 2–4 minutes for the remaining windows to be proven on this laptop.

---

## 2. Limitations

**L1. Input provenance: a smooth aimbot is undetectable (core finding).** A proof shows that the inputs obeyed the rules, not that a human produced them. Smooth-aim turns towards the target at or below `MAX_TURN` per tick. It is legal by every rule the circuit checks, and it ended `audited_clean` in 11/11 runs. The same applies to any input automation that stays within the rules (triggerbots, perfect strafing). Detecting it needs non-ZK methods (behavioural statistics, trusted input hardware). This is why ZK-Duel argues for a hybrid model rather than "ZK replaces anti-cheat". (SECURITY A10)

**L2. Single-party Groth16 trusted setup.** Phase 1 uses the public Hermez Powers-of-Tau ceremony, but the circuit-specific phase 2 is a single local contribution. Whoever ran the setup could in principle forge proofs. A production system would need a multi-party phase-2 ceremony, or a transparent / universal scheme. PLONK avoids per-circuit toxic waste, but L5 shows it is impractical here. (SECURITY A8)

**L3. No walls or obstacles in the circuit.** v1 has an open arena. The circuit proves only that each player stays inside the arena bounds (the low walls in the 3D view are those edges). Interior obstacles, cover and line-of-sight are therefore absent from both the game rules and the proofs. Wall-clipping and wallhack-style cheats cannot be expressed in v1 at all, and wallhacks would be out of scope anyway, since opponent positions are public snapshots. Proving point-outside-rectangle constraints is a listed stretch goal. (PRD §9, SECURITY A11)

**L4. No real-time proving of every window.** Groth16 prove / play is 1.10–1.72 on this laptop, so the system proves a random sample live and audits the rest after the match. Consequences:
- A cheat is caught *for certain* only at the end of the match, and the audit takes ≈ 2–4 minutes after a 3-minute match.
- Late windows in a round are rarely spot-checked live (§1.5).
- If a player leaves before the audit finishes, the result is `audit_incomplete` / `unverified`, never `audited_clean`. That outcome is visible, but it is not a proof of cheating.

**L5. PLONK only partially measured.** The PLONK sample counts are small (1–5 per variant; Chrome plonk_60 is a single proof), and Chrome plonk_120 has no measurement because the 3.96 GiB zkey failed to load. The conclusion "impractical" is robust (two orders of magnitude), but the PLONK numbers are less precise than the Groth16 ones.

**L6. One machine; one-laptop matches.** All numbers come from one mid-range laptop. The planned run on a stronger machine was not done, so how the results scale with more cores or RAM is untested. Every "two players" measurement ran both clients on that one laptop, sharing its CPU, which is pessimistic for proving. A two-laptop LAN match was not available.

**L7. Hidden state is only partially hidden.** The commitments never reveal ammo, cooldown or reload state, but `fired` is public every tick. An observer can therefore estimate ammo (magazine size − shots since the last reload) and cooldown. What stays truly hidden is the reload timing and the salts. (SECURITY A14)

**L8. Disconnects make windows unverifiable.** A disconnect turns the rest of that round into `chain_broken`. That is not counted as a failure, but the match can then reach only `audit_incomplete`, never `audited_clean`. A cheater could hide a cheat in a disconnected stretch, at the cost of an unverifiable result, which is visible and logged. (SECURITY A16)

**L9. Server trust for hits and damage.** Hits, damage and round outcomes are computed by the authoritative server and are not proven. The proofs cover the client's movement, aim and weapon rules only. A dishonest server is outside the threat model.

**L10. Experiment design simplifications.**
- The detection bots always miss (to keep each match to one round), switch the cheat on at window 3, and the snap-aim bot snaps every 10 ticks.
- The browser detection runs are a single run per cheat (n = 1).
- The Node bots prove ≈ 1.2× faster than Chrome, so the challenge rate r in the Node matrix is somewhat higher than two browsers would reach.
- Chrome memory figures are the whole test browser's private bytes, so they are an upper bound.
- The client-reported prove time is never trusted by the server, but it is still used for the timing statistics.

---

### Regenerating the numbers
- Groth16 / PLONK tables: `npx tsx bench/tables.ts` (raw files in `bench/out/raw/`); per-sample CSV: `npm run bench:export`.
- Detection matrix: `npx tsx server/scripts/detection-report.ts`. Note that this re-exports `bench/out/detection.csv` from the local database, which also holds the 10 demo-checklist rows (ids 136–145, `bench/out/detection-checklist.csv`). The tables above use rows 1–135 only.
- Charts: `/bench` dashboard → export, or `npm run bench:browser -- --export-only`.
