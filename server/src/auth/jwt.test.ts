import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index';
import { Repo } from '../db/repo';
import { Auth, AuthError } from './jwt';

const SECRET = 'unit-secret-unit-secret-unit-secret-01';
const setup = () => {
  const repo = new Repo(openDb(':memory:'));
  return { repo, auth: new Auth(repo, SECRET, 24) };
};
const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof AuthError ? e.code : 'other';
  }
};

describe('JWT guest sessions', () => {
  it('issues and verifies', () => {
    const { auth } = setup();
    const s = auth.issueGuest('shiva_01');
    expect(auth.verify(s.token).playerId).toBe(s.playerId);
  });
  it('revoked token → TOKEN_EXPIRED', () => {
    const { auth } = setup();
    const s = auth.issueGuest('shiva_01');
    auth.revoke(auth.verify(s.token).jti);
    expect(code(() => auth.verify(s.token))).toBe('TOKEN_EXPIRED');
  });
  it('expired token → TOKEN_EXPIRED', () => {
    const { auth } = setup();
    const s = auth.issueGuest('shiva_01');
    expect(code(() => auth.verify(s.token, s.expiresAt + 1))).toBe('TOKEN_EXPIRED');
    const old = jwt.sign(
      { sub: s.playerId, jti: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
    );
    expect(code(() => auth.verify(old))).toBe('TOKEN_EXPIRED');
  });
  it('wrong secret, unknown jti, alg none → UNAUTHORIZED', () => {
    const { auth } = setup();
    const s = auth.issueGuest('shiva_01');
    const payload = jwt.decode(s.token) as { sub: string; jti: string };
    expect(code(() => auth.verify(jwt.sign(payload, 'another-secret-another-secret-0000')))).toBe(
      'UNAUTHORIZED',
    );
    expect(code(() => auth.verify(jwt.sign({ sub: payload.sub, jti: 'nope' }, SECRET)))).toBe(
      'UNAUTHORIZED',
    );
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
    expect(code(() => auth.verify(none))).toBe('UNAUTHORIZED');
    expect(code(() => auth.verify('garbage'))).toBe('UNAUTHORIZED');
  });
});
