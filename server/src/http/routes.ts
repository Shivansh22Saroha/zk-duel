/** REST routes (API_SPEC §3). Error format: { error: { code, message } }. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONSTANTS } from '@zkduel/shared/constants';
import { guestAuthBody } from '@zkduel/shared/protocol';
import { AuthError, type Auth, type Session } from '../auth/jwt';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { MatchManager } from '../match/manager';

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
    activeMatches: d.manager.rooms.size,
    circuits: [] as string[], // Phase 2/3: built variants
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

  app.get('/api/circuit/info', async () => ({
    active: d.cfg.ACTIVE_VARIANT,
    variants: [] as unknown[], // Phase 2/3: read from circuits/build/<variant>/info.json
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
}
