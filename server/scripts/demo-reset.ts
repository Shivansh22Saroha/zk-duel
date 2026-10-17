/**
 * `npm run demo:reset` — fresh database for the demo, so old test matches do not clutter it.
 *  1. refuses while the server is running (port 8080 in use: the DB would be open);
 *  2. backs the DB up to server/data/backup-<date>-<time>.db with VACUUM INTO (a consistent copy
 *     that includes the WAL) and checks the copy (integrity_check + same row counts);
 *  3. removes only the live DB files (zkduel.db, -wal, -shm), creates a fresh one with all
 *     migrations, and copies the benchmark runs back (benchmark_runs / benchmark_results are
 *     measurements, not matches — /bench needs them).
 * Never deletes or overwrites a backup, and never touches bench/out/.
 */
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { loadConfig, SERVER_ROOT } from '../src/config';
import { openDb } from '../src/db/index';

dotenv.config({ path: join(SERVER_ROOT, '.env'), quiet: true });

const KEEP_TABLES = ['benchmark_runs', 'benchmark_results'] as const;
const COUNTED = ['matches', 'players', 'proof_windows', 'detection_runs', ...KEEP_TABLES];

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major !== 22)
  die(
    `Node ${process.version} — needs Node 22.x (better-sqlite3 is built for it). Fix: fnm use 22`,
  );

const cfg = loadConfig();
const dbPath = cfg.dbPath;
if (dbPath === ':memory:') die('DB_PATH is :memory: — nothing to reset.');

const portFree = await new Promise<boolean>((ok) => {
  const s = createServer()
    .once('error', () => ok(false))
    .once('listening', () => s.close(() => ok(true)))
    .listen(cfg.PORT, '0.0.0.0');
});
if (!portFree)
  die(
    `Port ${cfg.PORT} is in use — stop the server first (Ctrl+C in the demo terminal), then run demo:reset again.`,
  );

if (!existsSync(dbPath)) {
  openDb(dbPath).close();
  console.log(`No DB at ${dbPath} — created a fresh one. Nothing to back up.`);
  process.exit(0);
}

const counts = (db: Database.Database) =>
  Object.fromEntries(
    COUNTED.map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

// ---------------------------------------------------------------- 1. backup
const d = new Date();
const p2 = (n: number) => String(n).padStart(2, '0');
// Local time, so the name matches the clock in the viva room.
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const backup = join(dirname(dbPath), `backup-${stamp}.db`);
if (existsSync(backup))
  die(`${backup} already exists — not overwriting a backup. Try again in a second.`);
const live = new Database(dbPath);
const before = counts(live);
live.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
live.close();

const copy = new Database(backup, { readonly: true });
const ok = (copy.pragma('integrity_check', { simple: true }) as string) === 'ok';
const after = counts(copy);
copy.close();
if (!ok || JSON.stringify(before) !== JSON.stringify(after))
  die(
    `Backup check failed (integrity ${ok ? 'ok' : 'FAILED'}); the live DB was NOT touched. Backup: ${backup}`,
  );

// ---------------------------------------------------------------- 2. fresh DB + benchmark runs
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f);
const fresh = openDb(dbPath);
fresh.exec(`ATTACH DATABASE '${backup.replace(/'/g, "''")}' AS old`);
fresh.transaction(() => {
  for (const t of KEEP_TABLES) fresh.exec(`INSERT INTO main.${t} SELECT * FROM old.${t}`);
})();
fresh.exec('DETACH DATABASE old');
const now = counts(fresh);
fresh.close();

console.log(`Backup:  ${backup}
         ${before.matches} matches, ${before.players} players, ${before.benchmark_runs} benchmark runs (integrity ok)
Fresh DB: ${basename(dbPath)} — ${now.matches} matches, ${now.benchmark_runs} benchmark runs / ${now.benchmark_results} samples kept for /bench.
To go back: stop the server, then  copy ${backup} ${dbPath}`);
