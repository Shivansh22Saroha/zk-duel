# DEMO.md — viva runbook (one laptop, no internet needed)

Everything runs locally: the game, the proving key, the fonts and `/bench` make no external request. This was verified with outbound traffic blocked (`npm run offline:check`).

## Before the viva (day before + 10 min before)

| When | Do | Check |
|---|---|---|
| Day before | `npm run offline:check` and `npm run demo:rehearse` (with `npm run demo` running) | both print only `PASS` |
| 10 min before | **Charger plugged in.** Armoury Crate → **Performance** mode. Windows power mode → **Best performance** | PowerShell: `(Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus).PowerOnline` → `True` |
| | Chrome → `chrome://settings/performance` → **Energy saver off** (and Memory saver off) | |
| | Close other apps (Teams, Zoom, IDE indexing, OneDrive sync) | Task Manager CPU idle < 15 % |
| | `fnm use 22`, then `npm run demo:reset` (old test matches → a backup) and `npm run demo` | banner "ZK-Duel demo is running" with the URLs |
| | Open `http://localhost:5173/` once and click **Find Match**, then **Cancel**: the proving key (35 MB) is now cached | progress bar reaches 100 % |

Two Chrome windows side by side: **left = you** (`http://localhost:5173/`), **right = the bot**.

## Demo script (≈ 5 min)

| # | What the audience sees | Exact clicks / keys | Rehearsal timing |
|---|---|---|---|
| 1 | **Honest match vs bot.** Every window of play is committed; random windows are spot-checked and proven live. The proof strip under each name fills with ✓ | Left: type a name → **Find Match**. Right: open `http://localhost:5173/?bot=7` (it queues itself). Play: **WASD** move, **mouse** aim, **click** fire, **R** reload, **V** camera | live after **4.3–4.6 s**, first ✓ at **≈ 8 s**, match over at 13–20 s (two bots), audit done at **20–38 s** |
| 2 | **Cheat in a strict private room.** Speedhack → the next spot-check of a cheated window cannot be proven → the match is forfeited | Left: **Back to lobby** → **Private Room ▾** → Enforcement **strict** → **Create room** → read out the 6-letter code. Right: open `http://localhost:5173/?bot=8&manual=1&acc=1800&miss=300` → **Private Room ▾** → type the code → **Join**. Once the match is live, left: **F9** → tick **Speedhack (×2 speed)** → move | room → live in **4.3–4.5 s**; forfeit banner "Spot-check failed: unprovable …" **1.9–4.4 s** after the speedhack was switched on |
| 3 | **Results page.** After the audit: **AUDITED CLEAN** for match 1, **AUDIT FAILED** for the cheater in match 2, with per-player windows, spot-checks, challenge rate, prove/verify times | Nothing: the results open by themselves when the audit ends (match 2: audit done ≈ 5–10 s after the forfeit). Optional: F9 → **Smooth-aimbot** in a new strict room stays ✓ → **AUDITED CLEAN** (the input-provenance limit) | |
| 4 | **Benchmarks.** Groth16 vs PLONK prove time vs window size with the play-time line, proof size, verify time, r_max | **Back to lobby** → **Benchmarks** (or `http://localhost:5173/bench`) | charts in **0.5 s** |

The detection-matrix chart is not on `/bench` (it is export-only): show `bench/out/charts/detection-matrix.png`.

*Timings: two `npm run demo:rehearse` runs on 2026-10-17 (bots in both windows, AC, one laptop); `npm run demo` was ready in 5–8 s including a rebuild. With a human the honest match lasts as long as you play. The audit proves every window that was not spot-checked live, ≈ 2 s each with both players on one laptop (Phase 3: 242 s after a 3-min match), so keep the demo matches short.*

## What if it breaks

| Symptom | Fix |
|---|---|
| **Proving key does not load** (progress bar stuck, "proving key unavailable", hash mismatch after a rebuild) | Check the file is served: PowerShell `Invoke-WebRequest -Method Head http://localhost:5173/zk/groth16_60/window_final.zkey` → 200. If 404: `npm run circuits:build` (needs internet once for the ptau). If it is a stale cache: DevTools (**F12**) → Application → Storage → **Clear site data**, then **Ctrl+Shift+R** |
| **Port already in use** (`npm run demo` says port 8080 / 5173 is in use) | PowerShell: `Get-NetTCPConnection -LocalPort 8080,5173 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`, then `npm run demo` |
| **Audit is slow** (minutes instead of seconds) | It is still correct, so let it run (results appear by themselves; a page reload resumes it from IndexedDB). Check the charger and Performance mode (`PowerOnline` above; on battery proving is ≈ 3.7× slower). Next time play shorter matches: the audit is proportional to the windows played |
| **Browser stall / frozen page** | **F5** reloads; the session and the audit resume. A reload *during* live play breaks that round's chain (the match can then only reach AUDIT INCOMPLETE), so start a new match. Still stuck: **Ctrl+C** in the demo terminal, `npm run demo`, new match |
| **Bot too strong / match ends too fast** | Use `http://localhost:5173/?bot=7&miss=300` (the bot fires but never hits) |
| Wrong Node | `fnm use 22` (`npm run demo` refuses anything but 22.x) |
| Clutter from old matches | Stop the demo (**Ctrl+C**), `npm run demo:reset` (backs up to `server/data/backup-<date>.db`; benchmark runs are kept for `/bench`), `npm run demo` |
