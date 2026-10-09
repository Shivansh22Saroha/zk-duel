/** TESTING §4/§6 items that apply in Phase 1 (real sockets, in-memory DB). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HELLO_TIMEOUT_MS, MAX_STRIKES } from '@zkduel/shared/constants';
import { constantsHash } from '@zkduel/shared/canonical';
import { BotClient } from '../support/botClient';
import { startTestServer, TEST_ORIGIN, type TestServer } from '../support/testServer';

let srv: TestServer;
let hash: string;
const open: BotClient[] = [];

beforeAll(async () => {
  srv = await startTestServer();
  hash = await constantsHash();
});
afterAll(async () => {
  await Promise.all(open.map((b) => b.close()));
  await srv.stop();
});

let n = 0;
async function bot(): Promise<BotClient> {
  const name = `sec_${n++}`;
  const b = await BotClient.connect({
    baseUrl: srv.baseUrl,
    wsUrl: srv.wsUrl,
    origin: TEST_ORIGIN,
    name,
    seed: n,
    token: srv.auth.issueGuest(name).token,
  });
  open.push(b);
  return b;
}

/** `origin: null` sends no Origin header at all. */
function rawSocket(url = srv.wsUrl, origin: string | null = TEST_ORIGIN): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once('open', () => res(ws));
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });
}
const closeCode = (ws: WebSocket, ms = HELLO_TIMEOUT_MS + 2000): Promise<number> =>
  new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('no close')), ms);
    ws.once('close', (c) => {
      clearTimeout(to);
      res(c);
    });
  });

describe('WebSocket handshake & auth', () => {
  it('rejects an Origin not in ALLOWED_ORIGINS', async () => {
    await expect(rawSocket(srv.wsUrl, 'http://evil.example')).rejects.toThrow('HTTP 403');
    await expect(rawSocket(srv.wsUrl, null)).rejects.toThrow('HTTP 403');
  });

  it('first message other than hello → 4401', async () => {
    const ws = await rawSocket();
    ws.send(JSON.stringify({ t: 'queue_join' }));
    expect(await closeCode(ws)).toBe(4401);
  });

  it('no hello within HELLO_TIMEOUT_MS → 4401; a token in the query string is ignored', async () => {
    const token = srv.auth.issueGuest('qs_user').token;
    const ws = await rawSocket(`${srv.wsUrl}?token=${token}`);
    const t0 = Date.now();
    expect(await closeCode(ws)).toBe(4401);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HELLO_TIMEOUT_MS - 100);
  }, 15_000);

  it('invalid token → 4401; constants mismatch → VERSION_MISMATCH', async () => {
    const ws = await rawSocket();
    ws.send(
      JSON.stringify({ t: 'hello', token: 'nope', clientVersion: '0.1.0', constantsHash: hash }),
    );
    expect(await closeCode(ws)).toBe(4401);

    const ws2 = await rawSocket();
    const msgs: string[] = [];
    ws2.on('message', (d) => msgs.push(d.toString()));
    ws2.send(
      JSON.stringify({
        t: 'hello',
        token: srv.auth.issueGuest('vm_user').token,
        clientVersion: '0.1.0',
        constantsHash: 'f'.repeat(64),
      }),
    );
    expect(await closeCode(ws2)).toBe(4400);
    expect(msgs.some((m) => m.includes('VERSION_MISMATCH'))).toBe(true);
  });

  it('a second hello for the same player closes the older socket with 4409', async () => {
    const token = srv.auth.issueGuest('dup_user').token;
    const a = await rawSocket();
    a.send(JSON.stringify({ t: 'hello', token, clientVersion: '0.1.0', constantsHash: hash }));
    await new Promise((r) => a.once('message', r));
    const closed = closeCode(a);
    const b = await rawSocket();
    b.send(JSON.stringify({ t: 'hello', token, clientVersion: '0.1.0', constantsHash: hash }));
    expect(await closed).toBe(4409);
    b.close();
  });
});

describe('strikes & rate limits', () => {
  it(`${MAX_STRIKES} malformed messages → close 4400`, async () => {
    const b = await bot();
    for (let i = 0; i < MAX_STRIKES; i++)
      b.sendRaw(i % 2 ? '{not json' : JSON.stringify({ t: 'input_snapshot', tick: 1.5 }));
    expect(await b.waitClose(3000)).toBe(4400);
    expect(b.received.filter((m) => m.t === 'error')).toHaveLength(MAX_STRIKES);
  });

  it('200 snapshots in 1 s → rate-limited, strikes counted, closed 4429', async () => {
    const b = await bot();
    for (let i = 0; i < 200; i++)
      b.send({ t: 'input_snapshot', tick: i, x: 150, y: 300, angle: 0, fired: 0 });
    expect(await b.waitClose(3000)).toBe(4429);
    expect(b.received.some((m) => m.t === 'error' && m.code === 'RATE_LIMITED')).toBe(true);
  });

  it('cheat_toggle with DEV_CHEATS=false → FORBIDDEN', async () => {
    const b = await bot();
    b.send({ t: 'cheat_toggle', cheat: 'speedhack', enabled: true, tick: 0 });
    const e = await b.waitFor((m) => m.t === 'error', 2000);
    expect(e).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fuzz: random JSON, huge numbers, nested objects, oversized payload → server stays up', async () => {
    const b = await bot();
    const junk = [
      '[]',
      'null',
      '42',
      '"x"',
      '{"t":"input_snapshot","tick":1e308,"x":1,"y":1,"angle":1,"fired":0}',
      JSON.stringify({ t: 'ping', ts: { a: { b: { c: [1, 2, 3] } } } }),
    ];
    for (const j of junk.slice(0, MAX_STRIKES - 1)) b.sendRaw(j);
    const big = await bot();
    big.sendRaw(JSON.stringify({ t: 'ping', ts: 1, pad: 'x'.repeat(70_000) })); // > maxPayload
    expect(await big.waitClose(3000)).toBe(1009);
    const ok = await fetch(`${srv.baseUrl}/api/health`);
    expect(ok.status).toBe(200);
  });
});

describe('queue', () => {
  it('queue_join twice is idempotent; ALREADY_IN_MATCH while matched; queue_leave works', async () => {
    const a = await bot();
    a.send({ t: 'queue_join' });
    a.send({ t: 'queue_join' });
    await a.waitFor((m) => m.t === 'queued', 2000);
    a.send({ t: 'queue_leave' });
    const b = await bot();
    const c = await bot();
    b.send({ t: 'queue_join' });
    c.send({ t: 'queue_join' });
    await b.waitFor((m) => m.t === 'match_found', 15_000);
    expect(a.received.some((m) => m.t === 'match_found')).toBe(false);
    b.send({ t: 'queue_join' });
    expect(await b.waitFor((m) => m.t === 'error', 2000)).toMatchObject({
      code: 'ALREADY_IN_MATCH',
    });
    b.send({ t: 'forfeit' });
    expect(await c.waitFor((m) => m.t === 'match_end', 2000)).toMatchObject({ reason: 'forfeit' });
  });
});

describe('REST', () => {
  it('guest auth validates names and rate-limits at 10/min per IP', async () => {
    const post = (displayName: unknown) =>
      fetch(`${srv.baseUrl}/api/auth/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
    const bad = await post('<b>');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'INVALID_NAME' } });
    const good = await post('rest_user');
    expect(good.status).toBe(201);
    const body = (await good.json()) as { token: string; player: { displayName: string } };
    expect(body.player.displayName).toBe('rest_user');
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post(`rl_${i}xx`)).status);
    expect(statuses).toContain(429);
    const limited = await post('rl_last');
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('logout revokes the session (→ TOKEN_EXPIRED)', async () => {
    const token = srv.auth.issueGuest('logout_u').token;
    const out = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(204);
    const again = await fetch(`${srv.baseUrl}/api/matches/x`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
  });

  it('match summary is participants-only; 404 for unknown', async () => {
    const a = await bot();
    const b = await bot();
    a.send({ t: 'queue_join' });
    b.send({ t: 'queue_join' });
    const mf = (await a.waitFor((m) => m.t === 'match_found', 15_000)) as { matchId: string };
    const outsider = srv.auth.issueGuest('outsider').token;
    const r403 = await fetch(`${srv.baseUrl}/api/matches/${mf.matchId}`, {
      headers: { authorization: `Bearer ${outsider}` },
    });
    expect(r403.status).toBe(403);
    const r404 = await fetch(`${srv.baseUrl}/api/matches/nope`, {
      headers: { authorization: `Bearer ${outsider}` },
    });
    expect(r404.status).toBe(404);
    a.send({ t: 'forfeit' });
  });

  it('circuit info returns every constant + constantsHash; security headers present', async () => {
    const r = await fetch(`${srv.baseUrl}/api/circuit/info`);
    const j = (await r.json()) as { constantsHash: string; constants: Record<string, unknown> };
    expect(j.constantsHash).toBe(hash);
    expect(Object.keys(j.constants)).toContain('RECONNECT_TIMEOUT_MS');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain('worker-src');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
