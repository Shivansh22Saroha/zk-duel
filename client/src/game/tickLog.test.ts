/** MemoryTickLog (VITE_LOG_TICKS): one match per log; a new header starts a new log. */
import { describe, expect, it } from 'vitest';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { MemoryTickLog } from './tickLog';

const header = (matchId: string) =>
  ({ type: 'header', matchId, playerIndex: 0 }) as unknown as TickLogLine;
const line = { type: 'round_start', roundNo: 1 } as unknown as TickLogLine;

describe('MemoryTickLog', () => {
  it('appends lines in order', () => {
    const log = new MemoryTickLog();
    log.write(header('m1'));
    log.write(line);
    log.write(line);
    expect(log.lines).toEqual([header('m1'), line, line]);
  });

  it('a header starts a fresh log (only the latest match is kept in memory)', () => {
    const log = new MemoryTickLog();
    log.write(header('m1'));
    log.write(line);
    log.write(header('m2'));
    expect(log.lines).toEqual([header('m2')]);
  });
});
