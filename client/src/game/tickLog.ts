/**
 * Dev-only local tick log (VITE_LOG_TICKS=true): the player's own public + private per-tick
 * state, kept in memory and offered as a file download. It never goes over the network.
 */
import type { TickLogLine } from '@zkduel/shared/ticklog';
import type { TickLogSink } from './session';

export class MemoryTickLog implements TickLogSink {
  lines: TickLogLine[] = [];

  write(line: TickLogLine): void {
    if (line.type === 'header') this.lines = [];
    this.lines.push(line);
  }

  download(): void {
    const header = this.lines.find((l) => l.type === 'header');
    const name =
      header && 'matchId' in header
        ? `${header.matchId}-p${header.playerIndex}.jsonl`
        : 'ticklog.jsonl';
    const blob = new Blob([this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n'], {
      type: 'application/x-ndjson',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
