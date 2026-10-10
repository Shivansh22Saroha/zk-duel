/**
 * Detection-experiment analysis (Phase 4), shared by the Node runner (exp-detect.ts) and the
 * browser demo (client/scripts/exp-browser.ts): from the cheater's own client tick log (ground
 * truth: which windows really break a rule) and the server's window results, one detection_runs row.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../src/db/index';
import { FAILURE_STATUSES } from '@zkduel/shared/protocol';
import { checkSequence, type PlayerState } from '@zkduel/shared/sim';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { sliceLogWindows, testSalt } from '@zkduel/shared/zkInput';

const FAIL = new Set<string>(FAILURE_STATUSES);

export interface DetectionRow {
  createdAt: number;
  matchId: string;
  environment: 'node' | 'browser';
  cheat: string;
  windowTicks: number;
  mNominal: number;
  mEffective: number;
  windows: number;
  challenges: number;
  challengeRate: number | null;
  predictedLive: number | null;
  caughtLive: boolean;
  latencyWindows: number | null;
  latencyMs: number | null;
  caughtAudit: boolean;
  finalStatus: string | null;
  cheaterStatus: string | null;
  deviceLabel: string;
  notes: string;
}

/** Cheater windows that contain at least one rule violation (the circuit mirror, shared/sim.ts). */
export function violatingWindows(lines: readonly TickLogLine[], n: number): Set<string> {
  const out = new Set<string>();
  for (const w of sliceLogWindows(lines, n, testSalt(0))) {
    const start: PlayerState = {
      pub: { x: w.ctx.prev[0], y: w.ctx.prev[1], angle: w.ctx.prev[2], fired: w.ctx.prev[3] },
      hidden: { ...w.ctx.hiddenIn },
    };
    if (checkSequence(start, w.records)) out.add(`${w.ctx.roundNo}:${w.ctx.windowIndex}`);
  }
  return out;
}

export function analyzeRun(o: {
  db: DB;
  matchId: string;
  cheaterIndex: number;
  cheat: string;
  mNominal: number;
  windowTicks: number;
  cheaterLog: readonly TickLogLine[];
  environment: 'node' | 'browser';
  deviceLabel: string;
}): DetectionRow {
  const v = violatingWindows(o.cheaterLog, o.windowTicks);
  const rows = o.db
    .prepare(
      `SELECT round_no AS r, window_index AS k, status, challenged, decided_phase AS phase
         FROM proof_windows WHERE match_id = ? AND player_index = ?`,
    )
    .all(o.matchId, o.cheaterIndex) as {
    r: number;
    k: number;
    status: string;
    challenged: number;
    phase: string | null;
  }[];
  const mp = o.db
    .prepare(
      `SELECT windows, windows_committed AS committed, challenges, challenge_rate AS r,
              detection_latency_windows AS lw, detection_latency_ms AS lms, audit_status AS st
         FROM match_players WHERE match_id = ? AND player_index = ?`,
    )
    .get(o.matchId, o.cheaterIndex) as {
    windows: number;
    committed: number;
    challenges: number;
    r: number | null;
    lw: number | null;
    lms: number | null;
    st: string | null;
  };
  const m = o.db.prepare('SELECT audit_status AS st FROM matches WHERE id = ?').get(o.matchId) as {
    st: string | null;
  };
  const byKey = new Map(rows.map((x) => [`${x.r}:${x.k}`, x]));
  let caughtLive = false;
  let caughtAudit = false;
  const anomalies: string[] = [];
  for (const k of v) {
    const w = byKey.get(k);
    if (!w || !FAIL.has(w.status)) anomalies.push(`violating ${k} → ${w?.status ?? 'no row'}`);
    else if (w.phase === 'live' && w.challenged) caughtLive = true;
    else if (w.phase === 'audit') caughtAudit = true;
  }
  for (const w of rows) {
    if (!v.has(`${w.r}:${w.k}`) && w.status !== 'valid')
      anomalies.push(`honest ${w.r}:${w.k} → ${w.status}`);
  }
  const r = mp.r;
  return {
    createdAt: Date.now(),
    matchId: o.matchId,
    environment: o.environment,
    cheat: o.cheat,
    windowTicks: o.windowTicks,
    mNominal: o.mNominal,
    mEffective: v.size,
    windows: mp.windows,
    challenges: mp.challenges,
    challengeRate: r,
    predictedLive: r === null ? null : 1 - (1 - r) ** v.size,
    caughtLive,
    latencyWindows: mp.lw,
    latencyMs: mp.lms,
    caughtAudit,
    finalStatus: m.st,
    cheaterStatus: mp.st,
    deviceLabel: o.deviceLabel,
    notes: anomalies.join('; '),
  };
}

export function insertRun(db: DB, x: DetectionRow): void {
  db.prepare(
    `INSERT INTO detection_runs (created_at, match_id, environment, cheat, window_ticks, m_nominal,
       m_effective, windows, challenges, challenge_rate, predicted_live, caught_live, latency_windows,
       latency_ms, caught_audit, final_status, cheater_status, device_label, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    x.createdAt,
    x.matchId,
    x.environment,
    x.cheat,
    x.windowTicks,
    x.mNominal,
    x.mEffective,
    x.windows,
    x.challenges,
    x.challengeRate,
    x.predictedLive,
    x.caughtLive ? 1 : 0,
    x.latencyWindows,
    x.latencyMs,
    x.caughtAudit ? 1 : 0,
    x.finalStatus,
    x.cheaterStatus,
    x.deviceLabel,
    x.notes,
  );
}

/** bench/out/detection.csv — every row of detection_runs. */
export function exportCsv(db: DB, path: string): number {
  const rows = db.prepare('SELECT * FROM detection_runs ORDER BY id').all() as Record<
    string,
    unknown
  >[];
  const cols = [
    'id',
    'created_at',
    'match_id',
    'environment',
    'cheat',
    'window_ticks',
    'm_nominal',
    'm_effective',
    'windows',
    'challenges',
    'challenge_rate',
    'predicted_live',
    'caught_live',
    'latency_windows',
    'latency_ms',
    'caught_audit',
    'final_status',
    'cheater_status',
    'device_label',
    'notes',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n',
  );
  return rows.length;
}

/** Per (environment, cheat, m) cell: the summary table of the report. */
/**
 * Scheduler-aware prediction of the live catch probability for one run: replays the run's real
 * challenge draw times for the cheater and draws uniformly among the windows that had ended and were
 * not yet drawn (exactly what ProofTracker does), many times. The naive 1 − (1 − r)^m assumes an
 * independent per-window probability r; the real scheduler gives windows that end early in a round
 * many more draws than late ones. Single-round runs only (else null). Window k is taken to be
 * eligible from (first draw + k · window duration); the first draw is the moment window 0 ended.
 */
export function schedulerPrediction(
  db: DB,
  matchId: string,
  p: number,
  windowTicks: number,
  sims = 20_000,
): number | null {
  const rows = db
    .prepare(
      `SELECT round_no AS r, window_index AS k, status, challenged, challenged_at AS c
         FROM proof_windows WHERE match_id = ? AND player_index = ?`,
    )
    .all(matchId, p) as {
    r: number;
    k: number;
    status: string;
    challenged: number;
    c: number | null;
  }[];
  if (!rows.length || rows.some((x) => x.r !== 1)) return null;
  const bad = new Set(rows.filter((x) => FAIL.has(x.status)).map((x) => x.k));
  if (!bad.size) return 0;
  const draws = rows
    .filter((x) => x.challenged && x.c !== null)
    .map((x) => x.c as number)
    .sort((a, b) => a - b);
  if (!draws.length) return 0;
  const t0 = draws[0] as number;
  const wMs = (windowTicks * 1000) / 60;
  const maxK = Math.max(...rows.map((x) => x.k));
  let caught = 0;
  for (let i = 0; i < sims; i++) {
    const drawn = new Set<number>();
    let hit = false;
    for (const t of draws) {
      const pool: number[] = [];
      for (let k = 0; k <= maxK; k++) if (t0 + k * wMs <= t + 1 && !drawn.has(k)) pool.push(k);
      if (!pool.length) continue;
      const k = pool[Math.floor(Math.random() * pool.length)] as number;
      drawn.add(k);
      if (bad.has(k)) {
        hit = true;
        break;
      }
    }
    if (hit) caught++;
  }
  return caught / sims;
}

export function matrix(db: DB): string {
  const rows = db
    .prepare(
      `SELECT environment env, cheat, m_nominal m, COUNT(*) n, AVG(m_effective) meff, AVG(challenge_rate) r,
              AVG(caught_live) live, AVG(predicted_live) pred, AVG(caught_audit) audit,
              SUM(final_status = 'audited_failed') failed, SUM(final_status = 'audited_clean') clean,
              SUM(cheater_status = 'audited_failed') cheaterFailed,
              AVG(latency_windows) lw, AVG(latency_ms) lms, SUM(notes <> '') anomalies
         FROM detection_runs GROUP BY environment, cheat, m_nominal ORDER BY environment, cheat, m_nominal`,
    )
    .all() as Record<string, number | string | null>[];
  // scheduler-aware prediction per cell (mean over the cell's runs)
  const runs = db
    .prepare(
      'SELECT environment env, cheat, m_nominal m, match_id id, window_ticks n FROM detection_runs',
    )
    .all() as { env: string; cheat: string; m: number; id: string; n: number }[];
  const sched = new Map<string, number[]>();
  for (const x of runs) {
    const pIdx = (
      db.prepare('SELECT player_index p FROM cheat_events WHERE match_id = ? LIMIT 1').get(x.id) as
        { p: number } | undefined
    )?.p;
    if (pIdx === undefined) continue;
    const v = schedulerPrediction(db, x.id, pIdx, x.n, 4000);
    if (v === null) continue;
    const k = `${x.env}|${x.cheat}|${x.m}`;
    sched.set(k, [...(sched.get(k) ?? []), v]);
  }
  const mean = (a: number[] | undefined) =>
    a?.length ? a.reduce((s2, y) => s2 + y, 0) / a.length : null;
  const f = (v: unknown, d = 2) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
  const head =
    '| env | cheat | m | runs | m_eff (mean) | r (mean) | caught live | predicted 1−(1−r)^m_eff | scheduler-aware prediction | caught by audit | audited_failed | audited_clean | latency windows / s (mean, caught live) | anomalies |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  return [
    head,
    sep,
    ...rows.map(
      (x) =>
        `| ${x.env} | ${x.cheat} | ${x.m} | ${x.n} | ${f(x.meff, 1)} | ${f(x.r, 3)} | ${f(Number(x.live) * 100, 0)} % | ${f(Number(x.pred) * 100, 0)} % | ${(() => {
          const v = mean(sched.get(`${x.env}|${x.cheat}|${x.m}`));
          return v === null ? '–' : `${(v * 100).toFixed(0)} %`;
        })()} | ${f(Number(x.audit) * 100, 0)} % | ${x.failed}/${x.n} | ${x.clean}/${x.n} | ${f(x.lw, 1)} / ${x.lms === null ? '–' : (Number(x.lms) / 1000).toFixed(1)} | ${x.anomalies} |`,
    ),
  ].join('\n');
}
