/** VerifierPool startup: a worker that dies before it is ready must fail startup, not hang it. */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { VerifierPool } from './verifierPool';

describe('VerifierPool.ready (audit E5)', () => {
  it('rejects fast with a clear error when a worker dies before reporting ready', async () => {
    const missing = join(tmpdir(), 'zkd-no-such-dir', 'verification_key.json');
    const pool = new VerifierPool(missing, 'groth16', 2, 1000);
    const t0 = Date.now();
    await expect(pool.ready()).rejects.toThrow(/verifier worker failed before it was ready/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    // the pool is closed: nothing keeps respawning, verify answers "closed"
    expect(await pool.verify([], {})).toMatchObject({ ok: false, error: 'closed' });
  }, 20_000);
});
