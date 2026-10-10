/**
 * Phase 4 integration: private rooms (F3), dev cheat events (F13), and the audit policy gap —
 * the winner closing the tab during the audit leaves the result `unverified`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { BotClient } from '../support/botClient';
import { VARIANT, VARIANT_DIR } from '../support/proofMatch';
import { startTestServer, TEST_ORIGIN, type TestServer } from '../support/testServer';

let srv: TestServer;
let seq = 0;
beforeAll(async () => {
  srv = await startTestServer({
    ACTIVE_VARIANT: VARIANT,
    LOG_SNAPSHOTS: 'false',
    DEV_CHEATS: 'true',
    AUDIT_TIMEOUT_MIN: '0.25', // 15 s
  });
}, 60_000);
afterAll(() => srv?.stop(), 60_000);

async function bot(prove = false): Promise<BotClient> {
  const name = `p4_${process.pid % 1000}_${seq++}`.slice(0, 16);
  return BotClient.connect({
    baseUrl: srv.baseUrl,
    wsUrl: srv.wsUrl,
    origin: TEST_ORIGIN,
    name,
    token: srv.auth.issueGuest(name).token,
    seed: 900 + seq,
    accuracy: 1800,
    ...(prove ? { prove: { variantDir: VARIANT_DIR, threads: 4 } } : {}),
  });
}

async function createRoom(token: string, enforcement: 'observe' | 'strict') {
  const r = await fetch(`${srv.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ enforcement }),
  });
  return { status: r.status, body: (await r.json()) as { roomCode: string; expiresAt: number } };
}

const tokenOf = (b: BotClient): string => (b as unknown as { token: string }).token;

describe('private rooms (F3)', () => {
  it("create (strict) → creator and joiner send room_join → private match with the creator's enforcement", async () => {
    const [a, b] = [await bot(), await bot()];
    const { status, body } = await createRoom(tokenOf(a), 'strict');
    expect(status).toBe(201);
    expect(body.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    a.send({ t: 'room_join', roomCode: body.roomCode.toLowerCase() }); // case-insensitive on entry
    b.send({ t: 'room_join', roomCode: body.roomCode });
    const [ma, mb] = (await Promise.all(
      [a, b].map((x) => x.waitFor((m) => m.t === 'match_found', 10_000)),
    )) as Extract<ServerMessage, { t: 'match_found' }>[];
    expect(ma?.enforcement).toBe('strict');
    expect(mb?.matchId).toBe(ma?.matchId);
    const row = srv.db
      .prepare('SELECT mode, room_code, enforcement FROM matches WHERE id = ?')
      .get(ma?.matchId) as Record<string, string>;
    expect(row).toEqual({ mode: 'private', room_code: body.roomCode, enforcement: 'strict' });
    // the room is used up: joining again is "not found"
    const c = await bot();
    c.send({ t: 'room_join', roomCode: body.roomCode });
    expect(await c.waitFor((m) => m.t === 'error', 5000)).toMatchObject({ code: 'ROOM_NOT_FOUND' });
    for (const x of [a, b]) x.send({ t: 'forfeit' });
    await Promise.all([a, b, c].map((x) => x.close()));
  }, 60_000);

  it("unknown code → ROOM_NOT_FOUND; the creator's seat is reserved → a second outsider gets ROOM_FULL", async () => {
    const [a, b, c] = [await bot(), await bot(), await bot()];
    a.send({ t: 'room_join', roomCode: 'ZZZZZZ' });
    expect(await a.waitFor((m) => m.t === 'error', 5000)).toMatchObject({ code: 'ROOM_NOT_FOUND' });
    const { body } = await createRoom(tokenOf(a), 'observe');
    b.send({ t: 'room_join', roomCode: body.roomCode });
    c.send({ t: 'room_join', roomCode: body.roomCode });
    expect(await c.waitFor((m) => m.t === 'error', 5000)).toMatchObject({
      code: 'ROOM_FULL',
      message: 'Room already has two players.',
    });
    expect(b.received.some((m) => m.t === 'match_found')).toBe(false);
    await Promise.all([a, b, c].map((x) => x.close()));
  }, 60_000);
});

describe('dev cheats (F13) with DEV_CHEATS=true', () => {
  it('cheat_toggle → cheat_events row with its window + cheat_flag broadcast to both players', async () => {
    const [a, b] = [await bot(), await bot()];
    for (const x of [a, b]) x.startLoop();
    a.send({ t: 'queue_join' });
    await a.waitFor((m) => m.t === 'queued', 5000);
    b.send({ t: 'queue_join' });
    await Promise.all([a, b].map((x) => x.waitFor((m) => m.t === 'start', 20_000)));
    await new Promise((r) => setTimeout(r, 300));
    const tick = a.session.tick;
    a.send({ t: 'cheat_toggle', cheat: 'speedhack', enabled: true, tick });
    for (const x of [a, b]) {
      expect(await x.waitFor((m) => m.t === 'cheat_flag', 5000)).toMatchObject({
        playerIndex: a.session.playerIndex,
        cheat: 'speedhack',
        enabled: true,
      });
    }
    expect([...b.session.cheatFlags[a.session.playerIndex]]).toEqual(['speedhack']);
    const ev = srv.repo.getCheatEvents(a.session.match?.matchId as string);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      cheat: 'speedhack',
      enabled: true,
      roundNo: 1,
      windowIndex: Math.floor((ev[0]?.tick ?? -1) / 4),
    });
    a.send({ t: 'forfeit' });
    await Promise.all([a, b].map((x) => x.close()));
  }, 60_000);
});

describe('audit policy gap', () => {
  it('the winner closes the tab during the audit → result "unverified" (not overturned); the loser\'s audit is clean', async () => {
    const [a, b] = [await bot(true), await bot(true)];
    for (const x of [a, b]) x.startLoop();
    a.send({ t: 'queue_join' });
    await a.waitFor((m) => m.t === 'queued', 5000);
    b.send({ t: 'queue_join' });
    await Promise.all([a, b].map((x) => x.waitFor((m) => m.t === 'start', 20_000)));
    await new Promise((r) => setTimeout(r, 3000)); // ~45 windows each
    b.send({ t: 'forfeit' }); // a wins
    await a.waitFor((m) => m.t === 'match_end', 10_000);
    const id = a.session.match?.matchId as string;
    // "during the audit": the live challenge is answered and a few audit windows are done. (Closing
    // while a live challenge is still outstanding lets it time out → a failure → overturned, by design.)
    const t0 = Date.now();
    while (true) {
      const st = a.proof?.debugState() as {
        challenge: string | null;
        auditProven: number;
        auditTotal: number;
      };
      if (st.challenge === null && st.auditProven >= 2 && st.auditProven < st.auditTotal) break;
      if (Date.now() - t0 > 60_000) throw new Error(`audit never got going: ${JSON.stringify(st)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await a.close(); // the winner closes the tab: its remaining windows are never proven
    const end = (await b.waitFor((m) => m.t === 'audit_end', 60_000)) as Extract<
      ServerMessage,
      { t: 'audit_end' }
    >;
    const winner = a.session.playerIndex;
    expect(end).toMatchObject({
      auditStatus: 'audit_incomplete',
      overturned: false,
      resultVerdict: 'unverified',
    });
    expect(end.players[winner]?.auditStatus).toBe('audit_incomplete');
    expect(end.players[b.session.playerIndex]?.auditStatus).toBe('audited_clean');
    const s = srv.repo.getMatchSummary(id);
    expect(s).toMatchObject({
      resultVerdict: 'unverified',
      overturned: false,
      winnerIndex: winner,
      endReason: 'forfeit',
    });
    await b.close();
  }, 120_000);
});
