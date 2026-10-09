import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BN254_P } from './field';
import { matchField } from './matchField';
import { initialCommit, poseidon } from './poseidon';

describe('poseidon (circomlibjs)', () => {
  it('matches the circomlib reference vector Poseidon([1,2])', async () => {
    expect(await poseidon([1, 2])).toBe(
      '7853200120776062878684798364095072458815029376092732009249414926327459813530',
    );
  });
  it('initialCommit is a stable field element', async () => {
    const c = await initialCommit();
    expect(BigInt(c) < BN254_P).toBe(true);
    expect(await initialCommit()).toBe(c);
  });
});

describe('matchField', () => {
  it('is the first 31 bytes of SHA-256(uuid) big-endian, < p', async () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    const expected = BigInt('0x' + createHash('sha256').update(id).digest('hex').slice(0, 62));
    const f = await matchField(id);
    expect(f).toBe(expected.toString());
    expect(BigInt(f) < BN254_P).toBe(true);
  });
});
