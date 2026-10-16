/** MatchManager failure paths (no sockets): match creation and snapshot-log errors must not crash the server. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { poseidonReady } from '@zkduel/shared/poseidon';
import type { ServerMessage } from '@zkduel/shared/protocol';
import { openDb } from '../db/index';
import { Repo } from '../db/repo';
import type { VariantInfo } from '../zk/variant';
import { MatchManager } from './manager';
import type { PlayerLink } from './matchRoom';

const SHA = 'ab'.repeat(32);
const FAKE_VARIANT: VariantInfo = {
  id: 'groth16_60',
  scheme: 'groth16',
  windowTicks: 60,
  constraints: 1,
  publicSignalOrder: ['commitOut', 'bind', 'digest', 'commitIn'],
  zkeySha256: SHA,
  zkeyBytes: 1,
  wasmSha256: SHA,
  vkeySha256: SHA,
  ptauPower: 15,
  builtAt: '',
};

/** A repo whose match insert fails (e.g. disk full / locked DB). */
class FailingRepo extends Repo {
  override createMatch(): void {
    throw new Error('disk I/O error');
  }
}

function setup(o: { repo?: Repo; snapshotLogDir?: string } = {}) {
  const repo = o.repo ?? new FailingRepo(openDb(':memory:'));
  const ids = ['a', 'b', 'c', 'd'];
  for (const id of ids) repo.createPlayer(id, `${id}_player`);
  const inbox = new Map<string, ServerMessage[]>(ids.map((id) => [id, []]));
  const links = new Map<string, PlayerLink>(
    [...inbox].map(([id, box]) => [id, { send: (m: ServerMessage) => box.push(m) }]),
  );
  const errors: { obj: Record<string, unknown>; msg: string }[] = [];
  const manager = new MatchManager(repo, (pid) => links.get(pid) ?? null, {
    scheme: 'groth16',
    windowTicks: 60,
    defaultEnforcement: 'observe',
    logSnapshots: o.snapshotLogDir !== undefined,
    errorLog: { error: (obj, msg) => errors.push({ obj, msg }) },
    snapshotLogDir: o.snapshotLogDir ?? '',
    constantsHash: 'h',
    proofGraceWindows: 2,
    variant: FAKE_VARIANT,
    verifier: { verify: async () => ({ ok: true, ms: 1, timedOut: false, error: null }) },
    proofDeadlineMs: 10_000,
    auditTimeoutMs: 60_000,
    storeProofs: false,
    now: () => 0,
  });
  return { manager, inbox, errors };
}

/** Lets the async createRoom (Poseidon + DB) settle. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(() => poseidonReady(), 60_000);

describe('match creation failure (audit E3)', () => {
  it('queue pairing: the error is caught and logged, both players get INTERNAL and are free again', async () => {
    const { manager, inbox, errors } = setup();
    manager.joinQueue('a');
    manager.joinQueue('b');
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe('match creation failed');
    expect(errors[0]?.obj).toMatchObject({ players: ['a', 'b'], err: 'Error: disk I/O error' });
    for (const id of ['a', 'b']) {
      expect(inbox.get(id)?.at(-1)).toMatchObject({ t: 'error', code: 'INTERNAL' });
      expect(manager.isBusy(id)).toBe(false);
    }
    expect(manager.rooms.size).toBe(0);
  });

  it('private room: the error is caught and logged, both players get INTERNAL and are free again', async () => {
    const { manager, inbox, errors } = setup();
    const room = manager.createPrivateRoom('a', 'strict');
    expect(room).not.toBeNull();
    expect(manager.joinPrivateRoom('a', room?.roomCode as string)).toBe('ok');
    expect(manager.joinPrivateRoom('b', room?.roomCode as string)).toBe('ok');
    await settle();
    expect(errors).toHaveLength(1);
    for (const id of ['a', 'b']) {
      expect(inbox.get(id)?.at(-1)).toMatchObject({ t: 'error', code: 'INTERNAL' });
      expect(manager.isBusy(id)).toBe(false);
    }
  });
});

describe('snapshot log failure (audit E4)', () => {
  it('a log that cannot be opened is logged once, disables LOG_SNAPSHOTS, and the matches still start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zkd-mgr-'));
    const notADir = join(dir, 'logs');
    writeFileSync(notADir, ''); // a file where the log directory should be → mkdirSync fails
    try {
      const { manager, errors } = setup({
        repo: new Repo(openDb(':memory:')),
        snapshotLogDir: notADir,
      });
      for (const id of ['a', 'b', 'c', 'd']) manager.joinQueue(id);
      await settle();
      expect(manager.rooms.size).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.msg).toBe('snapshot log write failed; LOG_SNAPSHOTS disabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
