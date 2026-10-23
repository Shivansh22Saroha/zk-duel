/**
 * `npm run cheat:demo -- --mode observe|strict --cheat <name>` — live anti-cheat demo in Chrome.
 * Two bot players in a private room: cheater_A (switches a dev cheat on at a window boundary via the
 * F9 drawer) vs honest_B (no cheats), or vs cheater_B with --cheat-b. Records screenshots, the
 * detection time and the server's per-window results. Needs the stack running with DEV_CHEATS=true
 * (`npm run demo` does that).
 *
 * Options:
 *   --mode observe|strict         enforcement of the private room (required)
 *   --cheat <name>                speedhack | rapid_fire | infinite_ammo | snap_aim (required)
 *   --on-window <k>               window the cheat starts in (default 5)
 *   --off-window <k>              window the cheat stops at (default: stays on)
 *   --cheat-b <name>              player B cheats too (cheater_B), same cheat names (default: honest)
 *   --on-window-b <k>             window B's cheat starts in (default 5)
 *   --off-window-b <k>            window B's cheat stops at (default: stays on)
 *   --max-seconds <s>             safety cap: the *cheater* forfeits after this much play (default 150);
 *                                 the bots never hit (miss=300), so an observe match needs an end
 *   --honest-stop-after <s>       make honest_B forfeit after <s> (default off; the 2026-10-23 Run 1
 *                                 used 60, which is why that match ended `forfeit`)
 *   --out <dir>                   output dir (default bench/out/cheat-demo/<timestamp>-<mode>-<cheat>)
 *   --keep-open                   leave Chrome open on the results pages until you close it
 *   --base <url> --api <url>      client / server (default http://localhost:5173/, http://localhost:8080)
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODES = ['observe', 'strict'];
const CHEATS = ['speedhack', 'rapid_fire', 'infinite_ammo', 'snap_aim'];
const BOT_URL = 'manual=1&acc=1800&miss=300';
const SEEDS = [511, 512];

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};
const { values: o } = parseArgs({
  options: {
    mode: { type: 'string' },
    cheat: { type: 'string' },
    'on-window': { type: 'string', default: '5' },
    'off-window': { type: 'string' },
    'cheat-b': { type: 'string' },
    'on-window-b': { type: 'string', default: '5' },
    'off-window-b': { type: 'string' },
    'max-seconds': { type: 'string', default: '150' },
    'honest-stop-after': { type: 'string' },
    out: { type: 'string' },
    'keep-open': { type: 'boolean', default: false },
    base: { type: 'string', default: 'http://localhost:5173/' },
    api: { type: 'string', default: 'http://localhost:8080' },
  },
});
if (!MODES.includes(o.mode ?? '')) die(`--mode must be one of ${MODES.join('|')}`);
if (!CHEATS.includes(o.cheat ?? '')) die(`--cheat must be one of ${CHEATS.join('|')}`);
if (o['cheat-b'] !== undefined && !CHEATS.includes(o['cheat-b'])) die(`--cheat-b must be one of ${CHEATS.join('|')}`);
const posInt = (name, v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer`);
  return n;
};
const CFG = {
  enf: o.mode,
  cheat: o.cheat,
  onWindow: posInt('on-window', o['on-window']),
  offWindow: o['off-window'] === undefined ? null : posInt('off-window', o['off-window']),
  cheatB: o['cheat-b'] ?? null,
  onWindowB: posInt('on-window-b', o['on-window-b']),
  offWindowB: o['off-window-b'] === undefined ? null : posInt('off-window-b', o['off-window-b']),
  maxSeconds: posInt('max-seconds', o['max-seconds']),
  honestStopAfter: o['honest-stop-after'] === undefined ? null : posInt('honest-stop-after', o['honest-stop-after']),
};
if (CFG.offWindow !== null && CFG.offWindow <= CFG.onWindow) die('--off-window must be after --on-window');
if (CFG.offWindowB !== null && CFG.offWindowB <= CFG.onWindowB) die('--off-window-b must be after --on-window-b');
const NAME_B = CFG.cheatB ? 'cheater_B' : 'honest_B';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tag = CFG.cheatB ? `${CFG.cheat}-vs-${CFG.cheatB}` : CFG.cheat;
const OUT = resolve(o.out ?? join(ROOT, 'bench/out/cheat-demo', `${stamp}-${CFG.enf}-${tag}`));
mkdirSync(OUT, { recursive: true });

const { chromium } = createRequire(join(ROOT, 'package.json'))('@playwright/test');
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const runLog = [];
const log = (...a) => {
  const line = [`[${ts()}]`, ...a].join(' ');
  runLog.push(line);
  console.log(line);
};
const shot = async (p, name, sel) => {
  const path = join(OUT, `${name}.png`);
  if (sel) await p.locator(sel).first().screenshot({ path });
  else await p.screenshot({ path });
  log('screenshot', path);
};
const until = (p, src, timeout) =>
  p.waitForFunction((s) => new Function('zk', `return ${s}`)(window.__zkd), src, { timeout, polling: 200 });
const read = (p, src) => p.evaluate((s) => new Function('zk', `return ${s}`)(window.__zkd), src);

const recv = []; // interesting server→client frames, timestamped (public data only)
// public per-tick trace from A's socket: [round, tick, x0, y0, fired0, x1, y1, fired1] — shows
// whether a cheat actually broke a rule in a given window (e.g. rapid fire with no early shot)
const trace = [];
async function open(browser, who, seed, extra = '') {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[${who} pageerror] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && log(`[${who} console.error] ${m.text().slice(0, 200)}`));
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      const s = String(f.payload);
      const t = /"t":"([a-z_]+)"/.exec(s)?.[1];
      if (t && t !== 'state' && t !== 'pong') recv.push({ at: Date.now(), who, t, msg: JSON.parse(s) });
      if (t === 'state' && who === 'cheater_A') {
        const m = JSON.parse(s);
        if (m.phase === 'live') trace.push([m.roundNo, m.tick, ...m.players.flatMap((q) => [q.x, q.y, q.fired])]);
      }
    }),
  );
  await page.goto(`${o.base}?bot=${seed}&${BOT_URL}${extra}`);
  return page;
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--window-size=1100,800', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const A = await open(browser, 'cheater_A', SEEDS[0], `&stopAfter=${CFG.maxSeconds}`);
const B = await open(browser, NAME_B, SEEDS[1], CFG.honestStopAfter ? `&stopAfter=${CFG.honestStopAfter}` : '');

// private room: A creates (UI, chosen enforcement), B joins with the code (UI)
await A.fill('#name', 'cheater_A');
await A.click('#private-room summary');
await A.selectOption('#room-enforcement', CFG.enf);
await A.click('#create-room');
const code = ((await A.locator('span.room-code').textContent({ timeout: 120_000 })) ?? '').trim();
log('room', code, CFG.enf);
await B.fill('#name', NAME_B);
await B.click('#private-room summary');
await B.fill('#room-code', code);
await B.click('#join-room');
await Promise.all([A, B].map((p) => until(p, "zk?.game()?.phase === 'live'", 180_000)));
const matchId = await read(A, 'zk.game().match.matchId');
const enf = await read(A, 'zk.game().match.enforcement');
const wt = await read(A, 'zk.game().match.windowTicks');
const me = await read(A, 'zk.game().playerIndex');
if (!Number.isInteger(wt) || wt <= 0) die(`could not read windowTicks from the match (${wt})`);
const onTick = CFG.onWindow * wt;
const offTick = CFG.offWindow === null ? null : CFG.offWindow * wt;
log('match live', matchId, 'enforcement', enf, 'windowTicks', wt, 'cheater_A = p' + me);

// cheaters: page, file-name prefix and cheat schedule (the second one only with --cheat-b)
const cheaters = [{ p: A, who: 'cheater_A', file: 'cheater', cheat: CFG.cheat, onTick, offTick }];
if (CFG.cheatB)
  cheaters.push({ p: B, who: 'cheater_B', file: 'cheaterB', cheat: CFG.cheatB, onTick: CFG.onWindowB * wt,
    offTick: CFG.offWindowB === null ? null : CFG.offWindowB * wt });

// F9 drawer on each cheater; an in-page watcher clicks the drawer checkbox at exact tick boundaries
for (const c of cheaters) await armCheat(c);
async function armCheat({ p, cheat, onTick, offTick }) {
  await until(p, 'zk.game().tick > 30', 30_000);
  await p.keyboard.press('F9');
  await p.waitForSelector(`#cheat-${cheat}`, { state: 'visible', timeout: 10_000 });
  await p.evaluate(({ cheat, onTick, offTick }) => {
    const zk = window.__zkd;
    const box = document.getElementById(`cheat-${cheat}`);
    const st = (window.__ct = { on: null, off: null, detect: null });
    const iv = setInterval(() => {
      const g = zk.game();
      if (!g) return;
      const nt = g.tick + 1; // toggleCheat applies from game.tick + 1
      if (g.phase === 'live' && !st.on && nt >= onTick) {
        box.click();
        st.on = { at: Date.now(), tick: g.tick, round: g.roundNo, checked: box.checked };
      }
      if (offTick !== null && g.phase === 'live' && st.on && !st.off && nt >= offTick) {
        box.click();
        st.off = { at: Date.now(), tick: g.tick, round: g.roundNo, checked: box.checked };
      }
      const p = zk.proof();
      const s = p?.spot?.[p.me];
      if (st.on && !st.detect && s && s.decided > s.passed)
        st.detect = { at: Date.now(), tick: g.tick, round: g.roundNo, spot: { ...s } };
      if (g.phase === 'ended' && (offTick === null || st.off || !st.on)) clearInterval(iv);
    }, 4);
  }, { cheat, onTick, offTick });
}

// screenshots during the cheat (per cheater; both tabs at the "during" moment when two cheat)
const files = [[A, 'cheater'], [B, CFG.cheatB ? 'cheaterB' : 'honest']];
const state = (p) => read(p, '({ ct: window.__ct, phase: zk.game()?.phase, tick: zk.game()?.tick })');
for (const c of cheaters) Object.assign(c, { shotMid: false, shotDetect: false });
for (;;) {
  let ended = false;
  for (const c of cheaters) {
    const s = await state(c.p);
    if (!c.shotMid && s.ct.on && s.tick >= c.onTick + 4 * wt - 10 && s.phase === 'live') {
      c.shotMid = true;
      await shot(c.p, `${c.file}-hud-during-cheat`);
      await shot(c.p, `${c.file}-proof-strip-during-cheat`, '.strip-wrap');
      const [op, of] = files.find(([q]) => q !== c.p);
      await shot(op, `${of}-view-during-${c.file}-cheat`);
    }
    if (!c.shotDetect && s.ct.detect) {
      c.shotDetect = true;
      await shot(c.p, `${c.file}-hud-first-detection`);
      await shot(c.p, `${c.file}-proof-strip-first-detection`, '.strip-wrap').catch(() => {});
    }
    ended ||= s.phase === 'ended';
  }
  if (ended) break;
  await new Promise((r) => setTimeout(r, 150));
}
await Promise.all([A, B].map((p) => until(p, "zk.game()?.phase === 'ended'", 60_000)));
const result = await read(A, 'zk.game().result');
const ct = await read(A, 'window.__ct');
const ctB = CFG.cheatB ? await read(B, 'window.__ct') : null;
log('match ended', JSON.stringify(result), 'cheat', JSON.stringify(ct));
if (ctB) log('cheat B', JSON.stringify(ctB));
for (const [c, who] of [[ct, 'cheater_A'], [ctB, 'cheater_B']])
  if (c?.on && c.detect) log(`${who} first live detection ${((c.detect.at - c.on.at) / 1000).toFixed(2)} s after cheat on`);
for (const [p, who] of files) {
  const vis = await p.locator('.forfeit-banner:not([hidden])').count();
  if (vis) {
    log(`${who} forfeit banner: ${(await p.locator('.forfeit-banner').textContent())?.trim()}`);
    await shot(p, `${who}-forfeit-banner`);
  }
}
for (const c of cheaters) if (!c.shotDetect || !c.shotMid) await shot(c.p, `${c.file}-hud-at-match-end`);

// audit, then results pages
await Promise.all([A, B].map((p) => until(p, 'zk.proof()?.auditDone === true', 25 * 60_000)));
log('audit done (clients)');
const verdicts = [];
for (const [p, who] of files) {
  try {
    await p.waitForSelector('#results', { timeout: 60_000 });
  } catch {
    await p.evaluate((id) => {
      history.pushState(null, '', `/match/${id}/results${location.search}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, matchId);
    await p.waitForSelector('#results', { timeout: 30_000 });
  }
  await p.waitForTimeout(1500);
  verdicts.push(((await p.locator('#results').textContent()) ?? '').match(/AUDITED CLEAN|AUDIT FAILED|AUDIT INCOMPLETE/)?.[0]);
  await p.screenshot({ path: join(OUT, `results-${who}.png`), fullPage: true });
  log('screenshot results', who, verdicts.at(-1), p.url());
}

// server data (A is a participant, so it may read both players' windows)
const fetchJson = (path) =>
  A.evaluate(async ([api, pth]) => (await fetch(api + pth, {
    headers: { authorization: `Bearer ${sessionStorage.getItem('zkd.token')}` } })).json(), [o.api, path]);
let summary;
for (let i = 0; i < 60; i++) {
  summary = await fetchJson(`/api/matches/${matchId}`);
  if (summary.auditStatus && summary.players.every((p) => p.auditStatus)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const windows = (await fetchJson(`/api/matches/${matchId}/windows`)).windows;
const spots = await read(A, 'zk.proof()?.spot ?? null');
for (const p of summary.players ?? []) log(`p${p.playerIndex} ${p.displayName ?? ''} audit ${p.auditStatus}`);
log('match', matchId, 'endReason', summary.endReason, 'winner p' + summary.winnerIndex,
  'audit', summary.auditStatus, 'verdict', summary.resultVerdict);
const out = { cfg: CFG, windowTicks: wt, code, matchId, enforcement: enf, cheaterIndex: me, result, ct, ctB, verdicts,
  resultsUrl: `${o.base}match/${matchId}/results`, spots, summary, windows, recv, trace };
writeFileSync(join(OUT, 'run.json'), JSON.stringify(out, null, 2));
log('RUN DONE ->', OUT);
writeFileSync(join(OUT, 'run.log'), runLog.join('\n') + '\n');

if (o['keep-open']) {
  log('Chrome stays open on the results pages; close it to exit.');
  await new Promise((r) => browser.on('disconnected', r));
} else {
  await browser.close();
}
