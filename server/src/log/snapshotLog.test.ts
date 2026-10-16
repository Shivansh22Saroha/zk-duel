/** Snapshot JSONL log (LOG_SNAPSHOTS): a write-stream error must never crash the server. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { openSnapshotLog } from './snapshotLog';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'zkd-snaplog-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LINE = { type: 'header', matchId: 'm1' } as unknown as TickLogLine;

describe('openSnapshotLog (audit E4)', () => {
  it('writes one JSON line per write', async () => {
    const dir = tempDir();
    const log = openSnapshotLog(dir, 'm1', () => undefined);
    log.write(LINE);
    await log.close();
    expect(readFileSync(join(dir, 'm1.jsonl'), 'utf8')).toBe(JSON.stringify(LINE) + '\n');
  });

  it('a stream error is reported once, then the log is disabled (no crash, close still resolves)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'm2.jsonl')); // the log path is a directory → the stream fails (EISDIR)
    const errors: unknown[] = [];
    const log = openSnapshotLog(dir, 'm2', (e) => errors.push(e));
    log.write(LINE);
    await new Promise((r) => setTimeout(r, 100));
    log.write(LINE);
    log.write(LINE);
    await log.close();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/EISDIR|EPERM|EACCES/);
  });
});
