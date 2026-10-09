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
import {
  HELLO_TIMEOUT_MS,
  MAX_STRIKES,
  MAX_WS_PAYLOAD_BYTES,
  RATE_LIMIT_OTHER_PER_S,
  RATE_LIMIT_PROOFS_PER_S,
  RATE_LIMIT_SNAPSHOTS_PER_S,
} from '@zkduel/shared/constants';
import { clientMessage, helloMsg, type ServerMessage } from '@zkduel/shared/protocol';
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

type Category = 'snapshot' | 'proof' | 'other';
const LIMITS: Record<Category, number> = {
  snapshot: RATE_LIMIT_SNAPSHOTS_PER_S,
  proof: RATE_LIMIT_PROOFS_PER_S,
  other: RATE_LIMIT_OTHER_PER_S,
};

export interface GatewayOptions {
  allowedOrigins: string[];
  devCheats: boolean;
  constantsHash: string;
  serverVersion: string;
  /** Test hook: every raw client→server frame (the "frame inspector"). */
  onClientFrame?: (playerId: string | null, raw: string) => void;
}

class Conn implements PlayerLink {
  playerId: string | null = null;
  strikes = 0;
  closed = false;
  helloTimer: NodeJS.Timeout | null = null;
  private windowStart = 0;
  private counts: Record<Category, number> = { snapshot: 0, proof: 0, other: 0 };

  constructor(readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
  }

  /** Fixed 1-second windows per category. Returns false when over the limit. */
  allow(cat: Category, now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.counts = { snapshot: 0, proof: 0, other: 0 };
    }
    this.counts[cat]++;
    return this.counts[cat] <= LIMITS[cat];
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
    ws.on('close', () => this.onClose(c));
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
          : 'other';
    if (!c.allow(cat, Date.now())) return this.strike(c, 'RATE_LIMITED', `rate limit for ${cat}`);

    if (t === 'window_proof') return; // proof verification arrives in Phase 3
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
      case 'room_join':
        return c.send({
          t: 'error',
          code: 'FORBIDDEN',
          message: 'private rooms are not available yet',
        });
      case 'ready':
        if (room && p !== null) room.onReady(p);
        return;
      case 'input_snapshot': {
        if (!room || p === null) return;
        const v = room.onSnapshot(p, m);
        if (v === 'strike_future')
          this.strike(c, 'INVALID_BODY', 'snapshot tick is ahead of the server');
        else if (v === 'strike_range')
          this.strike(c, 'INVALID_BODY', 'snapshot value out of range');
        return;
      }
      case 'proof_failed':
        return; // Phase 3
      case 'cheat_toggle':
        if (!this.opts.devCheats) return this.strike(c, 'FORBIDDEN', 'cheats are disabled');
        return; // Phase 4
      case 'forfeit':
        if (room && p !== null) room.onForfeit(p);
        return;
    }
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
  }

  close(): void {
    for (const c of this.byPlayer.values()) c.close(1001, 'server shutting down');
    this.wss.close();
  }
}
