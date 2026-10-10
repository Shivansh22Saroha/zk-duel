/**
 * Phase 4 detection experiment (Node bots, real groth16_60 circuit, provers in worker_threads).
 *
 *   npm run exp:detect -- --reps 10 --m 1,5,20 --cheats speedhack,rapid_fire,infinite_ammo,snap_aim --control 10
 *
 * Per match: the cheater (player 0) switches one cheat on at window ACTIVATE (a real cheat_toggle →
 * cheat_events, cheat_flag, latency anchor), keeps it on for m windows, play goes on for TAIL more
 * windows, then the opponent forfeits and both clients audit. Bots fire but always miss (aim error
 * ≥ 30°), so the whole match is one round and the challenge pool is never reset by a round end.
 * While cheating, the cheater's input makes the cheat bite: speedhack keeps moving, rapid-fire and
 * infinite ammo hold the trigger, snap-aim snaps every SNAP_EVERY ticks without shooting (a hit-scan
 * snap would end the round within a second). Both provers share the CPU (6 threads each).
 *
 * Rows → detection_runs (server/data/zkduel.db); CSV → bench/out/detection.csv; report →
 * server/data/test-reports/phase4-detection.txt.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TICK_RATE, WINDOW_TICKS, type PlayerIndex } from '@zkduel/shared/constants';
import type { CheatName } from '@zkduel/shared/protocol';
import { BotInput } from '../../client/src/game/bot';
import { Cheats } from '../../client/src/game/cheats';
import type { InputContext, InputSource } from '../../client/src/game/session';
import { BotClient } from '../test/support/botClient';
import { CIRCUITS_BUILD, REPO_ROOT, REPORT_DIR } from '../test/support/paths';
import { startTestServer, TEST_ORIGIN, type TestServer } from '../test/support/testServer';
import { SERVER_ROOT } from '../src/config';
import { analyzeRun, exportCsv, insertRun, matrix } from './detection';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const REPS = Number(arg('reps', '10'));
const MS = arg('m', '1,5,20').split(',').map(Number);
const CHEATS_RUN = arg('cheats', 'speedhack,rapid_fire,infinite_ammo,snap_aim')
  .split(',')
  .filter(Boolean) as CheatName[];
const CONTROL = Number(arg('control', '10'));
const CONTROL_M = 20;
const THREADS = Number(arg('threads', '6'));
const ACTIVATE = 3; // window
const TAIL = 10; // windows after the cheat ends
const SNAP_EVERY = 10; // ticks
const N = WINDOW_TICKS;
const MISS = 300; // angle units: bots fire but never hit
const LABEL = `${cpus()[0]?.model.trim()} (${cpus().length} threads), Node ${process.version}, AC`;
const LOG = join(REPORT_DIR, 'phase4-detection.txt');

/** Bot input that makes an active cheat actually break its rule each window. */
class CheaterInput implements InputSource {
  constructor(
    private readonly base: InputSource,
    private readonly cheats: Cheats,
  ) {}
  sample(ctx: InputContext) {
    const i = this.base.sample(ctx);
    const a = this.cheats.active;
    if (a.has('speedhack')) {
      // keep moving toward the middle so every tick moves (an idle tick has nothing to speed up)
      i.moveX = ctx.self.pub.x < 500 ? 1 : -1;
      i.moveY = ctx.self.pub.y < 300 ? 1 : -1;
    }
    if (a.has('rapid_fire') || a.has('infinite_ammo')) i.fire = true;
    if (a.has('snap_aim')) i.fire = false;
    return i;
  }
}

let seq = 0;
async function runMatch(srv: TestServer, cheat: CheatName, m: number): Promise<void> {
  const seed = 7000 + seq * 7;
  const names = [`ex_a_${seq}`, `ex_b_${seq}`].map((s) => s.slice(0, 16));
  seq++;
  const cheats = new Cheats(0);
  cheats.snapEveryTicks = SNAP_EVERY;
  const start = ACTIVATE * N;
  const stop = (ACTIVATE + m) * N;
  let toggledOn = false;
  let toggledOff = false;
  let cheater: BotClient | null = null;
  const tamper = (
    ctx: { roundNo: number; tick: number; opponent: InputContext['opponent'] },
    s: Parameters<Cheats['apply']>[1],
    prev: Parameters<Cheats['apply']>[2],
    input: Parameters<Cheats['apply']>[3],
  ) => {
    if (ctx.roundNo === 1 && !toggledOn && ctx.tick >= start) {
      toggledOn = true;
      cheats.set(cheat, true);
      cheater?.send({ t: 'cheat_toggle', cheat, enabled: true, tick: ctx.tick });
    }
    if (toggledOn && !toggledOff && (ctx.roundNo > 1 || ctx.tick >= stop)) {
      toggledOff = true;
      cheats.set(cheat, false);
      cheater?.send({ t: 'cheat_toggle', cheat, enabled: false, tick: ctx.tick });
    }
    return cheats.apply(ctx, s, prev, input);
  };
  const mk = (i: number) =>
    BotClient.connect({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      origin: TEST_ORIGIN,
      name: names[i] as string,
      token: srv.auth.issueGuest(names[i] as string).token,
      seed: seed + i,
      input:
        i === 0
          ? new CheaterInput(new BotInput(seed, 1800, MISS), cheats)
          : new BotInput(seed + 1, 1800, MISS),
      tamper: i === 0 ? tamper : undefined,
      prove: { variantDir: join(CIRCUITS_BUILD, `groth16_${N}`), threads: THREADS },
    });
  const a = await mk(0);
  const b = await mk(1);
  cheater = a;
  for (const x of [a, b]) x.startLoop();
  a.send({ t: 'queue_join' });
  await a.waitFor((x) => x.t === 'queued', 5000);
  b.send({ t: 'queue_join' });
  await Promise.all([a, b].map((x) => x.waitFor((y) => y.t === 'start', 30_000)));
  const t0 = performance.now();
  const playMs = ((ACTIVATE + m + TAIL) * N * 1000) / TICK_RATE;
  // end of the scripted match: the opponent forfeits (or the match ended by itself)
  await Promise.race([
    new Promise((r) => setTimeout(r, playMs)),
    a.waitFor((x) => x.t === 'match_end', playMs + 5000).catch(() => undefined),
  ]);
  if (a.session.phase !== 'ended') b.send({ t: 'forfeit' });
  await a.waitFor((x) => x.t === 'match_end', 30_000);
  const t1 = performance.now();
  await Promise.all([a, b].map((x) => x.waitFor((y) => y.t === 'audit_end', 30 * 60_000)));
  const t2 = performance.now();
  for (const x of [a, b]) x.stopLoop();
  const matchId = a.session.match?.matchId as string;
  const row = analyzeRun({
    db: srv.db,
    matchId,
    cheaterIndex: a.session.playerIndex as PlayerIndex,
    cheat,
    mNominal: m,
    windowTicks: N,
    cheaterLog: a.log.lines,
    environment: 'node',
    deviceLabel: LABEL,
  });
  insertRun(srv.db, row);
  const line = `${new Date().toISOString()} ${cheat} m=${m} → m_eff ${row.mEffective}, r ${row.challengeRate?.toFixed(3)}, live ${row.caughtLive ? 'YES' : 'no'} (pred ${((row.predictedLive ?? 0) * 100).toFixed(0)} %), latency ${row.latencyWindows ?? '–'} w / ${row.latencyMs ?? '–'} ms, audit ${row.caughtAudit ? 'YES' : 'no'}, final ${row.finalStatus} (cheater ${row.cheaterStatus}); play ${((t1 - t0) / 1000).toFixed(0)} s, audit ${((t2 - t1) / 1000).toFixed(0)} s${row.notes ? ` ANOMALIES: ${row.notes}` : ''}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
  await Promise.all([a, b].map((x) => x.close()));
}

async function main(): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const srv = await startTestServer({
    ACTIVE_VARIANT: `groth16_${N}`,
    DB_PATH: arg('db', join(SERVER_ROOT, 'data', 'zkduel.db')),
    DEV_CHEATS: 'true',
    LOG_SNAPSHOTS: 'false',
    VERIFIER_THREADS: '2',
  });
  appendFileSync(
    LOG,
    `\n=== ${new Date().toISOString()} detection experiment: ${LABEL}; reps ${REPS}, m ${MS.join('/')}, cheats ${CHEATS_RUN.join(',')}, control ${CONTROL}; provers ${THREADS} threads each\n`,
  );
  const t0 = performance.now();
  for (const cheat of CHEATS_RUN) {
    for (const m of MS) for (let i = 0; i < REPS; i++) await runMatch(srv, cheat, m);
  }
  for (let i = 0; i < CONTROL; i++) await runMatch(srv, 'smooth_aim', CONTROL_M);
  const csv = arg('csv', join(REPO_ROOT, 'bench', 'out', 'detection.csv'));
  const n = exportCsv(srv.db, csv);
  const table = matrix(srv.db);
  const tail = `\nexperiment wall time ${((performance.now() - t0) / 60_000).toFixed(1)} min; ${n} rows in detection_runs → ${csv}\n\n${table}\n`;
  console.log(tail);
  appendFileSync(LOG, tail);
  await srv.stop();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
