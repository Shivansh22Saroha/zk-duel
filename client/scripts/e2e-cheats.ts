/**
 * Phase 4 browser E2E (TESTING §5) in two real Chrome windows, production `--mode perf` build with
 * VITE_DEV_CHEATS=true, server DEV_CHEATS=true:
 *  - private room: A creates it (strict) through the UI, B joins with the code through the UI;
 *  - E2E-2: A switches on speedhack → the first challenged cheating window fails → strict forfeit
 *    (`forfeit_proof`, forfeit banner), both see the CHEAT tag;
 *  - E2E-3: new strict room, A switches on smooth-aim → every spot-check valid, no forfeit, the
 *    audit ends `audited_clean`;
 *  - frame inspector over every frame both pages sent: no hidden-state key.
 *
 *   npm run perf:serve        (other terminal)
 *   npm run e2e:cheats
 * Writes server/data/test-reports/phase4-e2e.txt; exits 1 on failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { HIDDEN_KEYS } from '@zkduel/shared/ticklog';

const BASE = process.env.PERF_URL ?? 'http://localhost:5173/';
const API = process.env.PERF_API ?? 'http://localhost:8080';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/data/test-reports');
const BOT = 'acc=1800&miss=300&manual=1';
const WIRE = new Set([
  't',
  'token',
  'clientVersion',
  'constantsHash',
  'artefactSha256',
  'tick',
  'x',
  'y',
  'angle',
  'fired',
  'roundNo',
  'windowIndex',
  'commitOut',
  'matchId',
  'scheme',
  'proof',
  'publicSignals',
  'proveMs',
  'pi_a',
  'pi_b',
  'pi_c',
  'protocol',
  'curve',
  'reason',
  'roomCode',
  'cheat',
  'enabled',
  'ts',
]);

type Zkd = {
  game(): {
    phase: string;
    tick: number;
    playerIndex: number;
    match: { matchId: string } | null;
    result: { reason: string; winnerIndex: number | null } | null;
  } | null;
  proof(): {
    auditDone: boolean;
    auditStatus: string | null;
    spot: { passed: number; decided: number }[];
  } | null;
  cheat(c: string, on: boolean): void;
};
const z = <T>(p: Page, fn: (zk: Zkd) => T): Promise<T> =>
  p.evaluate(
    (src) => new Function('zk', `return (${src})(zk)`)((window as unknown as { __zkd: Zkd }).__zkd),
    fn.toString(),
  ) as Promise<T>;
const until = (p: Page, src: string, timeout: number) =>
  p.waitForFunction(
    (s) => new Function('zk', `return ${s}`)((window as unknown as { __zkd?: Zkd }).__zkd),
    src,
    { timeout, polling: 200 },
  );

const frames: string[] = [];
const lines: string[] = [];
const fail: string[] = [];
const check = (ok: boolean, what: string) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) fail.push(what);
};

async function open(browser: Browser, seed: number, extra = ''): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page ${seed}] ${e.message}`));
  page.on('websocket', (ws) => ws.on('framesent', (f) => frames.push(String(f.payload))));
  await page.goto(`${BASE}?bot=${seed}&${BOT}${extra}`);
  return page;
}

/** A creates a private room (UI), B joins it with the code (UI). Returns the code. */
async function privateRoom(a: Page, b: Page, enforcement: 'strict' | 'observe'): Promise<string> {
  await a.fill('#name', `e2e_a${Date.now() % 1000}`);
  await a.click('#private-room summary');
  await a.selectOption('#room-enforcement', enforcement);
  await a.click('#create-room');
  const code = ((await a.locator('span.room-code').textContent({ timeout: 10_000 })) ?? '').trim();
  await b.fill('#name', `e2e_b${Date.now() % 1000}`);
  await b.click('#private-room summary');
  await b.fill('#room-code', code.toLowerCase());
  await b.click('#join-room');
  await Promise.all([a, b].map((p) => until(p, "zk?.game()?.phase === 'live'", 120_000)));
  return code;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-size=1100,800',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  // ---------------------------------------------------------------- E2E-2: strict + speedhack
  {
    const a = await open(browser, 201);
    const b = await open(browser, 202);
    const code = await privateRoom(a, b, 'strict');
    check(
      /^[A-HJ-NP-Z2-9]{6}$/.test(code),
      `private room created via UI (code ${code}) and joined by code in a second window`,
    );
    const enf = await a.evaluate(
      () =>
        (
          window as unknown as { __zkd: { game(): { match: { enforcement: string } } } }
        ).__zkd.game().match.enforcement,
    );
    check(enf === 'strict', `room enforcement chosen by the creator: ${enf}`);
    await until(a, 'zk.game().tick > 120', 30_000);
    const t0 = Date.now();
    await z(a, (zk) => zk.cheat('speedhack', true));
    await until(
      b,
      "document.querySelector('.cheat-tag:not([hidden])')?.textContent?.includes('speedhack') === true",
      10_000,
    ).then(
      () => check(true, 'opponent sees the CHEAT: speedhack tag'),
      () => check(false, 'opponent sees the CHEAT: speedhack tag'),
    );
    await Promise.all([a, b].map((p) => until(p, "zk.game()?.phase === 'ended'", 180_000)));
    const ra = await z(a, (zk) => zk.game()?.result);
    const me = await z(a, (zk) => zk.game()?.playerIndex);
    const banner = await a.locator('.forfeit-banner').textContent();
    check(
      ra?.reason === 'forfeit_proof' && ra.winnerIndex !== me,
      `E2E-2: strict + speedhack → match_end ${ra?.reason}, winner p${ra?.winnerIndex} (cheater p${me}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    check((banner ?? '').includes('Spot-check failed'), `E2E-2: forfeit banner "${banner}"`);
    await a.context().close();
    await b.context().close();
  }

  // ---------------------------------------------------------------- E2E-3: strict + smooth-aim
  {
    const a = await open(browser, 301);
    const b = await open(browser, 302, '&stopAfter=40');
    await privateRoom(a, b, 'strict');
    await until(a, 'zk.game().tick > 60', 30_000);
    await z(a, (zk) => zk.cheat('smooth_aim', true));
    await until(
      b,
      "document.querySelector('.cheat-tag:not([hidden])')?.textContent?.includes('smooth_aim') === true",
      10_000,
    ).then(
      () => check(true, 'opponent sees the CHEAT: smooth_aim tag'),
      () => check(false, 'opponent sees the CHEAT: smooth_aim tag'),
    );
    await Promise.all([a, b].map((p) => until(p, "zk.game()?.phase === 'ended'", 180_000)));
    const ra = await z(a, (zk) => zk.game()?.result);
    await Promise.all([a, b].map((p) => until(p, 'zk.proof()?.auditDone === true', 20 * 60_000)));
    const pa = await z(a, (zk) => zk.proof());
    const me = (await z(a, (zk) => zk.game()?.playerIndex)) ?? 0;
    const id = await z(a, (zk) => zk.game()?.match?.matchId);
    const sum = (await a.evaluate(
      async ([api, mid]) =>
        (
          await fetch(`${api}/api/matches/${mid}`, {
            headers: { authorization: `Bearer ${sessionStorage.getItem('zkd.token')}` },
          })
        ).json(),
      [API, id] as const,
    )) as {
      auditStatus: string;
      players: { playerIndex: number; proofs: { byStatus: Record<string, number> } }[];
    };
    const spot = pa?.spot[me];
    check(
      ra?.reason === 'forfeit',
      `E2E-3: smooth-aim never forfeited in strict mode (ended by ${ra?.reason})`,
    );
    check(
      !!spot && spot.decided > 0 && spot.passed === spot.decided,
      `E2E-3: smooth-aim spot-checks ${spot?.passed}/${spot?.decided} passed`,
    );
    check(
      sum.auditStatus === 'audited_clean',
      `E2E-3: audit ${sum.auditStatus}; cheater windows ${JSON.stringify(sum.players[me]?.proofs.byStatus)}`,
    );
    await a.context().close();
    await b.context().close();
  }
  await browser.close();

  // ---------------------------------------------------------------- frame inspector
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
  };
  for (const f of frames) walk(JSON.parse(f));
  const hidden = HIDDEN_KEYS.filter((k) => keys.has(k));
  const unknown = [...keys].filter((k) => !WIRE.has(k));
  check(
    hidden.length === 0 && unknown.length === 0,
    `frame inspector: ${frames.length} frames sent by the pages, keys ${[...keys].sort().join(',')}; hidden ${hidden.join(',') || 'none'}; unexpected ${unknown.join(',') || 'none'}`,
  );

  mkdirSync(OUT, { recursive: true });
  const text = `${new Date().toISOString()} Phase 4 browser E2E (production perf build, cheats compiled in)\n${lines.join('\n')}\n${fail.length ? 'FAIL' : 'PASS'}\n`;
  writeFileSync(join(OUT, 'phase4-e2e.txt'), text);
  console.log(text);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
