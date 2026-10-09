/**
 * Headless player: real WebSocket + the real client GameSession + BotInput.
 * Keeps every raw frame it sends (frame inspector) and, optionally, a client tick log.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { constantsHash } from '@zkduel/shared/canonical';
import { serverMessage, type ClientMessage, type ServerMessage } from '@zkduel/shared/protocol';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { BotInput } from '../../../client/src/game/bot';
import { GameSession, type InputSource, type TickLogSink } from '../../../client/src/game/session';

export async function guestToken(baseUrl: string, name: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  if (r.status !== 201) throw new Error(`guest auth failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

export interface BotOptions {
  baseUrl: string;
  wsUrl: string;
  origin: string;
  name: string;
  seed: number;
  /** Pre-issued token (tests issue directly to stay under the 10/min guest-auth limit). */
  token?: string;
  /** Write the client tick log (public + private) here. */
  logDir?: string;
  input?: InputSource;
}

class MemoryAndFileLog implements TickLogSink {
  readonly lines: TickLogLine[] = [];
  private stream: WriteStream | null = null;
  constructor(
    private readonly dir: string | undefined,
    private readonly name: string,
  ) {}
  write(line: TickLogLine): void {
    this.lines.push(line);
    if (line.type === 'header' && this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.stream?.end();
      this.stream = createWriteStream(
        join(this.dir, `${line.matchId}-p${line.playerIndex}-${this.name}.jsonl`),
      );
    }
    this.stream?.write(JSON.stringify(line) + '\n');
  }
  close(): Promise<void> {
    return new Promise((res) => (this.stream ? this.stream.end(res) : res()));
  }
}

export class BotClient {
  readonly sentFrames: string[] = [];
  readonly received: ServerMessage[] = [];
  readonly session: GameSession;
  readonly log: MemoryAndFileLog;
  closeCode: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    readonly ws: WebSocket,
    opts: BotOptions,
    hash: string,
  ) {
    this.log = new MemoryAndFileLog(opts.logDir, opts.name);
    this.session = new GameSession(
      { send: (m) => this.send(m) },
      opts.input ?? new BotInput(opts.seed),
      { now: () => performance.now(), constantsHash: hash, log: this.log },
    );
    ws.on('message', (data) => {
      const parsed = serverMessage.safeParse(JSON.parse(data.toString()));
      if (!parsed.success)
        throw new Error(`server sent an invalid message: ${data.toString().slice(0, 200)}`);
      this.received.push(parsed.data);
      this.session.handle(parsed.data);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.stopLoop();
    });
  }

  static async connect(opts: BotOptions): Promise<BotClient> {
    const token = opts.token ?? (await guestToken(opts.baseUrl, opts.name));
    const hash = await constantsHash();
    const ws = new WebSocket(opts.wsUrl, { origin: opts.origin });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const bot = new BotClient(ws, opts, hash);
    bot.send({ t: 'hello', token, clientVersion: '0.1.0', constantsHash: hash });
    await bot.waitFor((m) => m.t === 'welcome', 5000);
    return bot;
  }

  /** Raw send — every frame is recorded for the frame inspector. */
  sendRaw(raw: string): void {
    this.sentFrames.push(raw);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
  }

  send(m: ClientMessage): void {
    this.sendRaw(JSON.stringify(m));
  }

  /** Drive the session from a timer (≈ every 2 ms; OS timer granularity applies). */
  startLoop(): void {
    const run = (): void => {
      this.session.update(performance.now());
      this.timer = setTimeout(run, 2);
    };
    run();
  }

  stopLoop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs: number): Promise<ServerMessage> {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => {
        off();
        rej(new Error(`timeout waiting for message (${timeoutMs} ms)`));
      }, timeoutMs);
      const off = this.session.onMessage((m) => {
        if (pred(m)) {
          clearTimeout(to);
          off();
          res(m);
        }
      });
    });
  }

  waitClose(timeoutMs: number): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout waiting for close')), timeoutMs);
      this.ws.once('close', (code) => {
        clearTimeout(to);
        res(code);
      });
    });
  }

  async close(): Promise<void> {
    this.stopLoop();
    await this.log.close();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}
