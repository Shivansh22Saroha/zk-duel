/** REST routes (API_SPEC §3). Error format: { error: { code, message } }. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONSTANTS } from '@zkduel/shared/constants';
import { createRoomBody, guestAuthBody } from '@zkduel/shared/protocol';
import { AuthError, type Auth, type Session } from '../auth/jwt';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { MatchManager } from '../match/manager';
import { listVariants, publicVariant } from '../zk/variant';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export interface RouteDeps {
  cfg: Config;
  repo: Repo;
  auth: Auth;
  manager: MatchManager;
  constantsHash: string;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  /** Bearer-token auth for protected routes; replies 401 itself and returns null on failure. */
  const requireAuth = (req: FastifyRequest, reply: FastifyReply): Session | null => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) {
      void sendError(reply, 401, 'UNAUTHORIZED', 'Missing bearer token.');
      return null;
    }
    try {
      return d.auth.verify(token);
    } catch (e) {
      const code = e instanceof AuthError ? e.code : 'UNAUTHORIZED';
      void sendError(
        reply,
        401,
        code,
        code === 'TOKEN_EXPIRED' ? 'Session expired.' : 'Invalid token.',
      );
      return null;
    }
  };

  app.get('/api/health', async () => ({
    status: 'ok',
    uptimeS: Math.floor((Date.now() - d.startedAt) / 1000),
    activeMatches: d.manager.liveCount,
    circuits: listVariants(d.cfg.artefactDir).map((v) => v.id),
  }));

  app.post(
    '/api/auth/guest',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const r = guestAuthBody.safeParse(req.body);
      if (!r.success) {
        return sendError(
          reply,
          400,
          'INVALID_NAME',
          'Display name must be 3–16 characters [A-Za-z0-9_].',
        );
      }
      const s = d.auth.issueGuest(r.data.displayName);
      return reply.code(201).send({
        token: s.token,
        player: { id: s.playerId, displayName: r.data.displayName },
        expiresAt: s.expiresAt,
      });
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const s = requireAuth(req, reply);
    if (!s) return reply;
    d.auth.revoke(s.jti);
    return reply.code(204).send();
  });

  app.post(
    '/api/rooms',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const s = requireAuth(req, reply);
      if (!s) return reply;
      const r = createRoomBody.safeParse(req.body ?? {});
      if (!r.success)
        return sendError(reply, 400, 'INVALID_BODY', 'enforcement must be observe or strict.');
      const room = d.manager.createPrivateRoom(s.playerId, r.data.enforcement ?? 'observe');
      if (!room) return sendError(reply, 409, 'ALREADY_IN_MATCH', 'Already in a match.');
      return reply.code(201).send(room);
    },
  );

  app.get('/api/circuit/info', async () => ({
    active: d.cfg.ACTIVE_VARIANT,
    variants: listVariants(d.cfg.artefactDir).map(publicVariant),
    constants: CONSTANTS,
    constantsHash: d.constantsHash,
  }));

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req, reply) => {
    const s = requireAuth(req, reply);
    if (!s) return reply;
    const m = d.repo.getMatchSummary(req.params.id);
    if (!m) return sendError(reply, 404, 'NOT_FOUND', 'Match not found.');
    const participant = m.players.some((p) => p.playerId === s.playerId);
    if (!participant && !d.cfg.PUBLIC_MATCHES)
      return sendError(reply, 403, 'FORBIDDEN', 'Not a participant.');
    return {
      ...m,
      players: m.players.map(({ playerId: _omit, ...p }) => p),
      you: m.players.find((p) => p.playerId === s.playerId)?.playerIndex ?? null,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { player?: string } }>(
    '/api/matches/:id/windows',
    async (req, reply) => {
      const s = requireAuth(req, reply);
      if (!s) return reply;
      const m = d.repo.getMatchSummary(req.params.id);
      if (!m) return sendError(reply, 404, 'NOT_FOUND', 'Match not found.');
      if (!m.players.some((p) => p.playerId === s.playerId) && !d.cfg.PUBLIC_MATCHES)
        return sendError(reply, 403, 'FORBIDDEN', 'Not a participant.');
      const q = req.query.player;
      if (q !== undefined && q !== '0' && q !== '1')
        return sendError(reply, 400, 'INVALID_BODY', 'player must be 0 or 1.');
      return { windows: d.repo.getWindows(req.params.id, q === undefined ? undefined : Number(q)) };
    },
  );
}
