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

export function openSnapshotLog(dir: string, matchId: string): SnapshotLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${matchId}.jsonl`);
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });
  return {
    path,
    write: (line) => {
      stream.write(JSON.stringify(line) + '\n');
    },
    close: () => new Promise((res) => stream.end(res)),
  };
}
