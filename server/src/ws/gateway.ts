/**
 * WebSocket gateway (API_SPEC §4, SECURITY §2–§6):
 *  - Origin must be in ALLOWED_ORIGINS; path must be /ws (query string ignored — never a token).
 *  - First message must be `hello` within HELLO_TIMEOUT_MS, else close 4401.
 *  - Every message validated with zod; invalid → `error` + strike; MAX_STRIKES → close 4400
 *    (4429 when the last strike was a rate-limit hit).
 *  - One live socket per player: a new `hello` closes the older socket with 4409.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { HELLO_TIMEOUT_MS, MAX_STRIKES, MAX_WS_PAYLOAD_BYTES } from '@zkduel/shared/constants';
import { RateLimiter, type Category } from './rateLimit';
import {
  clientMessage,
  helloMsg,
  windowProofHeader,
  windowProofMsg,
  type ServerMessage,
} from '@zkduel/shared/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { AuthError, type Auth } from '../auth/jwt';
import type { MatchManager } from '../match/manager';
import type { PlayerLink } from '../match/matchRoom';

export const CLOSE = {
  INVALID: 4400,
  AUTH: 4401,
  REPLACED: 4409,
  RATE: 4429,
  SERVER: 4500,
} as const;

export interface GatewayOptions {
  allowedOrigins: string[];
  devCheats: boolean;
  constantsHash: string;
  serverVersion: string;
  /** Strikes and socket closes (player id, fixed reason strings and close codes only). */
  log?: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** Test hook: every raw client→server frame (the "frame inspector"). */
  onClientFrame?: (playerId: string | null, raw: string) => void;
}

class Conn implements PlayerLink {
  playerId: string | null = null;
  strikes = 0;
  closed = false;
  helloTimer: NodeJS.Timeout | null = null;
  private readonly limiter = new RateLimiter(Date.now());

  constructor(readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
  }

  /** Token buckets per category (rateLimit.ts). Returns false when over the limit. */
  allow(cat: Category, now: number): boolean {
    return this.limiter.allow(cat, now);
  }
}

export class Gateway {
  readonly wss: WebSocketServer;
  private readonly byPlayer = new Map<string, Conn>();

  constructor(
    private readonly auth: Auth,
    private readonly manager: () => MatchManager,
    private readonly opts: GatewayOptions,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  }

  linkOf(playerId: string): PlayerLink | null {
    return this.byPlayer.get(playerId) ?? null;
  }

  /** `upgrade` handler for the HTTP server. */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0];
    const origin = req.headers.origin;
    if (path !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (!origin || !this.opts.allowedOrigins.includes(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  };

  private onConnection(ws: WebSocket): void {
    const c = new Conn(ws);
    c.helloTimer = setTimeout(() => c.close(CLOSE.AUTH, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(c, data, isBinary));
    ws.on('close', (code: number, reason: Buffer) => {
      this.opts.log?.info(
        { playerId: c.playerId, code, reason: reason.toString('utf8'), strikes: c.strikes },
        'ws closed',
      );
      this.onClose(c);
    });
    ws.on('error', () => c.close(CLOSE.INVALID, 'socket error'));
  }

  private onClose(c: Conn): void {
    c.closed = true;
    if (c.helloTimer) clearTimeout(c.helloTimer);
    if (c.playerId && this.byPlayer.get(c.playerId) === c) {
      this.byPlayer.delete(c.playerId);
      this.manager().onDisconnect(c.playerId);
    }
  }

  private strike(
    c: Conn,
    code: 'INVALID_BODY' | 'RATE_LIMITED' | 'FORBIDDEN',
    message: string,
  ): void {
    c.strikes++;
    this.opts.log?.warn({ playerId: c.playerId, code, message, strikes: c.strikes }, 'ws strike');
    c.send({ t: 'error', code, message });
    if (c.strikes >= MAX_STRIKES) {
      c.close(code === 'RATE_LIMITED' ? CLOSE.RATE : CLOSE.INVALID, 'too many invalid messages');
    }
  }

  private onMessage(c: Conn, data: RawData, isBinary: boolean): void {
    if (c.closed) return;
    const raw = isBinary
      ? ''
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.concat(data as Buffer[]).toString('utf8');
    this.opts.onClientFrame?.(c.playerId, raw);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      if (!c.playerId) return c.close(CLOSE.AUTH, 'hello required');
      return this.strike(c, 'INVALID_BODY', 'not JSON');
    }
    const t = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;

    if (!c.playerId) {
      this.onHello(c, json);
      return;
    }

    const cat: Category =
      t === 'input_snapshot'
        ? 'snapshot'
        : t === 'window_proof' || t === 'proof_failed'
          ? 'proof'
          : t === 'window_commit'
            ? 'commit'
            : 'other';
    if (!c.allow(cat, Date.now())) return this.strike(c, 'RATE_LIMITED', `rate limit for ${cat}`);

    if (t === 'window_proof') return this.onWindowProof(c, c.playerId, json);
    const r = clientMessage.safeParse(json);
    if (!r.success)
      return this.strike(c, 'INVALID_BODY', r.error.issues[0]?.message ?? 'invalid message');
    const m = r.data;
    const pid = c.playerId;
    const mgr = this.manager();
    const room = mgr.roomOf(pid);
    const p = room?.indexOf(pid) ?? null;

    switch (m.t) {
      case 'hello':
        return this.strike(c, 'INVALID_BODY', 'already authenticated');
      case 'ping':
        return c.send({ t: 'pong', ts: m.ts, serverTime: Date.now() });
      case 'queue_join':
        if (!mgr.joinQueue(pid))
          c.send({ t: 'error', code: 'ALREADY_IN_MATCH', message: 'already in a match' });
        return;
      case 'queue_leave':
        return mgr.leaveQueue(pid);
      case 'room_join': {
        const res = mgr.joinPrivateRoom(pid, m.roomCode);
        if (res === 'ok') return;
        const msg = {
          ROOM_NOT_FOUND: 'Room not found or expired.',
          ROOM_FULL: 'Room already has two players.',
          ALREADY_IN_MATCH: 'already in a match',
        }[res];
        return c.send({ t: 'error', code: res, message: msg });
      }
      case 'ready':
        if (room && p !== null && !room.onReady(p, m.artefactSha256)) {
          c.send({
            t: 'error',
            code: 'FORBIDDEN',
            message: 'artefactSha256 does not match the active proving key',
          });
        }
        return;
      case 'input_snapshot': {
        if (!room || p === null) return;
        const v = room.onSnapshot(p, m);
        if (v === 'strike_future')
          this.strike(c, 'INVALID_BODY', 'snapshot tick is ahead of the server');
        else if (v === 'strike_late')
          this.strike(c, 'INVALID_BODY', 'snapshot tick is older than the proof grace period');
        else if (v === 'strike_range')
          this.strike(c, 'INVALID_BODY', 'snapshot value out of range');
        return;
      }
      case 'window_commit': {
        const r2 = mgr.commitRoomOf(pid);
        const p2 = r2?.indexOf(pid) ?? null;
        if (r2 && p2 !== null) r2.onCommit(p2, m.roundNo, m.windowIndex, m.commitOut);
        return;
      }
      case 'proof_failed': {
        const r2 = mgr.roomFor(pid, m.matchId);
        const p2 = r2?.indexOf(pid) ?? null;
        if (r2 && p2 !== null) r2.onProofFailed(p2, m);
        return;
      }
      case 'cheat_toggle':
        if (!this.opts.devCheats) return this.strike(c, 'FORBIDDEN', 'cheats are disabled');
        if (room && p !== null) room.onCheatToggle(p, m.cheat, m.enabled, m.tick);
        return;
      case 'forfeit':
        if (room && p !== null) room.onForfeit(p);
        return;
    }
  }

  /**
   * window_proof: header first (so a malformed body is still attributed to its window →
   * `malformed`), then the full schema. Routed by matchId (live match or its audit).
   */
  private onWindowProof(c: Conn, pid: string, json: unknown): void {
    const h = windowProofHeader.safeParse(json);
    if (!h.success) return this.strike(c, 'INVALID_BODY', 'window_proof header invalid');
    const room = this.manager().roomFor(pid, h.data.matchId);
    const p = room?.indexOf(pid) ?? null;
    if (!room || p === null) return; // not this player's match: dropped
    const full = windowProofMsg.safeParse(json);
    if (!full.success) {
      const reason = full.error.issues[0]?.message ?? 'malformed proof';
      room.onProofMalformed(p, h.data.roundNo, h.data.windowIndex, reason);
      return this.strike(c, 'INVALID_BODY', reason);
    }
    room.onProof(p, full.data);
  }

  private onHello(c: Conn, json: unknown): void {
    const r = helloMsg.safeParse(json);
    if (!r.success) return c.close(CLOSE.AUTH, 'hello required');
    let playerId: string;
    try {
      playerId = this.auth.verify(r.data.token).playerId;
    } catch (e) {
      c.send({
        t: 'error',
        code: 'UNAUTHORIZED',
        message: e instanceof AuthError ? e.code : 'invalid token',
      });
      return c.close(CLOSE.AUTH, 'invalid token');
    }
    if (r.data.constantsHash !== this.opts.constantsHash) {
      c.send({
        t: 'error',
        code: 'VERSION_MISMATCH',
        message: 'Client and server versions differ. Refresh.',
      });
      return c.close(CLOSE.INVALID, 'version mismatch');
    }
    if (c.helloTimer) clearTimeout(c.helloTimer);
    const older = this.byPlayer.get(playerId);
    if (older && older !== c) {
      this.byPlayer.delete(playerId);
      older.close(CLOSE.REPLACED, 'connected elsewhere');
    }
    c.playerId = playerId;
    this.byPlayer.set(playerId, c);
    c.send({ t: 'welcome', playerId, serverVersion: this.opts.serverVersion });
    // back into a running match (or its audit): resume (API_SPEC §4)
    this.manager().onReconnect(playerId, c);
  }

  close(): void {
    for (const c of this.byPlayer.values()) c.close(1001, 'server shutting down');
    this.wss.close();
  }
}
