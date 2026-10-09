/** Guest sessions: HS256 JWT with a `jti` stored in `sessions` so it can be revoked (SECURITY §2). */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Repo } from '../db/repo';

export class AuthError extends Error {
  constructor(public readonly code: 'UNAUTHORIZED' | 'TOKEN_EXPIRED') {
    super(code);
  }
}

export interface Session {
  playerId: string;
  jti: string;
}

export class Auth {
  constructor(
    private readonly repo: Repo,
    private readonly secret: string,
    private readonly ttlHours: number,
  ) {}

  /** Create a guest player + session; returns the signed token. */
  issueGuest(
    displayName: string,
    now = Date.now(),
  ): { token: string; playerId: string; expiresAt: number } {
    const playerId = randomUUID();
    const jti = randomUUID();
    const expiresAt = now + this.ttlHours * 3600 * 1000;
    this.repo.createPlayer(playerId, displayName, now);
    this.repo.createSession(jti, playerId, expiresAt, now);
    const token = jwt.sign({ sub: playerId, jti }, this.secret, {
      algorithm: 'HS256',
      expiresIn: Math.floor((expiresAt - now) / 1000),
    });
    return { token, playerId, expiresAt };
  }

  /** Verify signature, expiry and revocation. Throws AuthError. */
  verify(token: string, now = Date.now()): Session {
    let payload: jwt.JwtPayload;
    try {
      const p = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof p === 'string') throw new AuthError('UNAUTHORIZED');
      payload = p;
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) throw new AuthError('TOKEN_EXPIRED');
      throw new AuthError('UNAUTHORIZED');
    }
    const jti = payload.jti;
    const playerId = payload.sub;
    if (!jti || !playerId) throw new AuthError('UNAUTHORIZED');
    const s = this.repo.getSession(jti);
    if (!s || s.playerId !== playerId) throw new AuthError('UNAUTHORIZED');
    if (s.revoked) throw new AuthError('TOKEN_EXPIRED');
    if (s.expiresAt <= now) throw new AuthError('TOKEN_EXPIRED');
    return { playerId, jti };
  }

  revoke(jti: string): void {
    this.repo.revokeSession(jti);
  }
}
