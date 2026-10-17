/**
 * `npm run demo` — one command for the viva / live demo (docs/DEMO.md).
 *  1. checks Node 22.x, server/.env and the circuit artefacts of ACTIVE_VARIANT, and that ports
 *     8080 / 5173 are free — each with the exact fix if not;
 *  2. rebuilds the client (`--mode perf`, the production build with the `?bot=` automation) only if
 *     client/dist is missing or older than its sources;
 *  3. starts the production server + `vite preview` (same as `npm run perf:serve`) with
 *     DEV_CHEATS=true and DEFAULT_ENFORCEMENT=strict, waits until both answer, prints the URLs.
 * Ctrl+C stops both. Plain Node (no tsx) so the version check runs before anything else loads.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = 8080;
const CLIENT_PORT = 5173;
const READY_TIMEOUT_MS = 120_000;
const BUILD_MARKER = join(ROOT, 'client', 'dist', '.demo-build.json');
const ARTEFACTS = ['info.json', 'window.wasm', 'window_final.zkey', 'verification_key.json'];

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- 1. checks
const major = Number(process.versions.node.split('.')[0]);
if (major !== 22)
  die(
    `Node ${process.version} — ZK-Duel needs Node 22.x.\n  Fix:  fnm use 22   (or install Node 22 LTS), then run npm run demo again.`,
  );

const envFile = join(ROOT, 'server', '.env');
if (!existsSync(envFile))
  die(
    'server/.env is missing.\n  Fix:  copy server\\.env.example server\\.env  and set JWT_SECRET (see docs/ENVIRONMENT.md).',
  );
const variant =
  process.env.ACTIVE_VARIANT ??
  /^ACTIVE_VARIANT=(\S+)/m.exec(readFileSync(envFile, 'utf8'))?.[1] ??
  'groth16_60';
const artefactDir = join(ROOT, 'circuits', 'build', variant);
const missing = ARTEFACTS.filter((f) => !existsSync(join(artefactDir, f)));
if (missing.length)
  die(
    `Circuit artefacts for ${variant} are missing in circuits/build/${variant}/: ${missing.join(', ')}.\n  Fix:  npm run circuits:build   (needs the internet once for the ptau download)`,
  );

const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '0.0.0.0');
  });
for (const port of [SERVER_PORT, CLIENT_PORT])
  if (!(await portFree(port)))
    die(
      `Port ${port} is already in use (an earlier demo/dev server still running?).\n  Fix (PowerShell):  Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    );

// ---------------------------------------------------------------- 2. build if stale
/** Newest mtime under the given paths (files or directories), skipping node_modules and dist. */
function newest(paths) {
  let t = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (!st.isDirectory()) return void (t = Math.max(t, st.mtimeMs));
    for (const e of readdirSync(p)) if (e !== 'node_modules' && e !== 'dist') walk(join(p, e));
  };
  paths.forEach((p) => walk(join(ROOT, p)));
  return t;
}
const sources = newest([
  'client/src',
  'client/public',
  'client/index.html',
  'client/vite.config.ts',
  'client/package.json',
  'client/.env',
  'shared',
  'package-lock.json',
]);
const built = existsSync(BUILD_MARKER) ? statSync(BUILD_MARKER).mtimeMs : 0;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (built < sources) {
  console.log(
    built ? '▶ client/dist is older than its sources — rebuilding…' : '▶ Building the client…',
  );
  const r = spawnSync(npm, ['run', 'build:perf', '-w', 'client'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) die('Client build failed (output above).');
  writeFileSync(BUILD_MARKER, JSON.stringify({ mode: 'perf', builtAt: new Date().toISOString() }));
} else console.log('▶ client/dist is up to date — no rebuild.');

// ---------------------------------------------------------------- 3. start
const env = { ...process.env, DEV_CHEATS: 'true', DEFAULT_ENFORCEMENT: 'strict' };
const children = [
  ['server', ['run', 'start', '-w', 'server']],
  ['client', ['run', 'preview', '-w', 'client']],
].map(([name, args]) => {
  const c = spawn(npm, args, { cwd: ROOT, env, shell: true });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((l) => console.log(`[${name}] ${l}`));
  c.stdout.on('data', prefix);
  c.stderr.on('data', prefix);
  c.on('exit', (code) => {
    if (!stopping) {
      console.error(`[${name}] exited (${code}) — stopping the demo.`);
      stop(1);
    }
  });
  return c;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // npm → node: kill the whole tree, or the servers outlive the demo on Windows.
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
const t0 = Date.now();
while (
  !(await up(`http://localhost:${SERVER_PORT}/api/health`)) ||
  !(await up(`http://localhost:${CLIENT_PORT}/`))
) {
  if (Date.now() - t0 > READY_TIMEOUT_MS) {
    console.error('✖ Server or client did not come up within 2 min (output above).');
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}

const B = `http://localhost:${CLIENT_PORT}`;
console.log(`
════════════════════════════════════════════════════════════════════
 ZK-Duel demo is running  (${variant}, quick match = strict, dev cheats on)

 Player (you) ........... ${B}/
 Bot opponent ........... ${B}/?bot=7
     open in a second window; it joins Quick Match by itself
 Cheat demo (private) ... ${B}/?bot=8&manual=1&acc=1800&miss=300
     you create a private room (strict) in the player window; type its
     code into this window and click Join; the bot then plays (never hits)
 Benchmarks ............. ${B}/bench

 Runbook: docs/DEMO.md        Stop: Ctrl+C
════════════════════════════════════════════════════════════════════
`);
