/**
 * LOG_SNAPSHOTS=true → server/data/logs/<matchId>.jsonl with what the server actually received.
 * Public data only: the server never has hidden state. Client logs (public + private) are
 * written on the client side (see shared/ticklog.ts).
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { TickLogLine } from '@zkduel/shared/ticklog';

export interface SnapshotLog {
  write(line: TickLogLine): void;
  close(): Promise<void>;
}

export const NULL_LOG: SnapshotLog = {
  write: () => undefined,
  close: () => Promise.resolve(),
};

/**
 * A write error (disk full, permissions…) must not crash the server: `onError` is called once,
 * and from then on this log drops its lines (the match itself is unaffected).
 */
export function openSnapshotLog(
  dir: string,
  matchId: string,
  onError: (e: Error) => void,
): SnapshotLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${matchId}.jsonl`);
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });
  let failed = false;
  stream.on('error', (e) => {
    if (failed) return;
    failed = true;
    onError(e);
  });
  return {
    path,
    write: (line) => {
      if (!failed) stream.write(JSON.stringify(line) + '\n');
    },
    close: () => (failed ? Promise.resolve() : new Promise((res) => stream.end(res))),
  };
}
