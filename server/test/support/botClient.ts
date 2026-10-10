/**
 * Headless player: real WebSocket + the real client GameSession + BotInput, and optionally the
 * real ProofClient (commits, challenges, audit) with a Node worker_threads prover.
 * Keeps every raw frame it sends (frame inspector) and, optionally, a client tick log.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { constantsHash } from '@zkduel/shared/canonical';
import { serverMessage, type ClientFrame, type ServerMessage } from '@zkduel/shared/protocol';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { BotInput } from '../../../client/src/game/bot';
import {
  GameSession,
  type InputSource,
  type StateTamper,
  type TickLogSink,
} from '../../../client/src/game/session';
import { ProofClient, type ProofClientHooks } from '../../../client/src/zk/proofClient';
import { NodeProver } from './nodeProver';

export async function guestToken(baseUrl: string, name: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  if (r.status !== 201) throw new Error(`guest auth failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

/** The active variant's zkey hash, from /api/circuit/info (what `ready` must carry). */
export async function activeZkeySha256(baseUrl: string): Promise<string> {
  const info = (await (await fetch(`${baseUrl}/api/circuit/info`)).json()) as {
    active: string;
    variants: { id: string; zkeySha256: string }[];
  };
  const v = info.variants.find((x) => x.id === info.active);
  if (!v) throw new Error(`active variant ${info.active} is not built`);
  return v.zkeySha256;
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
  /** Aim jitter for BotInput (± angle units; larger → longer rounds). */
  accuracy?: number;
  /** Commit every window and prove challenges + the audit with this built variant. */
  prove?: { variantDir: string; threads?: number; hooks?: ProofClientHooks };
  tamper?: StateTamper;
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
  readonly proof: ProofClient | null;
  readonly log: MemoryAndFileLog;
  closeCode: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ws: WebSocket;

  private constructor(
    ws: WebSocket,
    private readonly opts: BotOptions,
    private readonly token: string,
    private readonly hash: string,
    zkeySha256: string,
  ) {
    this.ws = ws;
    this.log = new MemoryAndFileLog(opts.logDir, opts.name);
    this.session = new GameSession(
      { send: (m) => this.send(m) },
      opts.input ?? new BotInput(opts.seed, opts.accuracy),
      {
        now: () => performance.now(),
        constantsHash: hash,
        log: this.log,
        readySha256: zkeySha256,
        tamper: opts.tamper,
      },
    );
    this.proof = opts.prove
      ? new ProofClient(this.session, {
          send: (m) => this.send(m),
          prover: new NodeProver(opts.prove.variantDir, opts.prove.threads),
          scheme: 'groth16',
          now: () => performance.now(),
          log: this.log,
          hooks: opts.prove.hooks,
        })
      : null;
    this.attach(ws);
  }

  private attach(ws: WebSocket): void {
    ws.on('message', (data) => {
      const parsed = serverMessage.safeParse(JSON.parse(data.toString()));
      if (!parsed.success)
        throw new Error(`server sent an invalid message: ${data.toString().slice(0, 200)}`);
      this.received.push(parsed.data);
      this.session.handle(parsed.data);
    });
    ws.on('close', (code) => {
      if (ws !== this.ws) return;
      this.closeCode = code;
    });
  }

  static async connect(opts: BotOptions): Promise<BotClient> {
    const token = opts.token ?? (await guestToken(opts.baseUrl, opts.name));
    const [hash, sha] = await Promise.all([constantsHash(), activeZkeySha256(opts.baseUrl)]);
    const ws = await BotClient.open(opts);
    const bot = new BotClient(ws, opts, token, hash, sha);
    bot.send({ t: 'hello', token, clientVersion: '0.1.0', constantsHash: hash });
    await bot.waitFor((m) => m.t === 'welcome', 5000);
    return bot;
  }

  private static async open(opts: BotOptions): Promise<WebSocket> {
    const ws = new WebSocket(opts.wsUrl, { origin: opts.origin });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return ws;
  }

  /** Simulate a network drop: the socket closes; the local sim keeps running. */
  dropSocket(): void {
    this.ws.terminate();
  }

  /** Reconnect with the same token (Flow 5); resolves on the server's `welcome`. */
  async reconnect(): Promise<void> {
    const ws = await BotClient.open(this.opts);
    this.ws = ws;
    this.closeCode = null;
    this.attach(ws);
    const n = this.received.length;
    this.send({ t: 'hello', token: this.token, clientVersion: '0.1.0', constantsHash: this.hash });
    await this.waitFor((m) => m.t === 'welcome' && this.received.indexOf(m) >= n, 5000);
    this.proof?.onReconnected();
  }

  /** Raw send — every frame is recorded for the frame inspector. */
  sendRaw(raw: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return; // dropped while disconnected
    this.sentFrames.push(raw);
    this.ws.send(raw);
  }

  send(m: ClientFrame): void {
    this.sendRaw(JSON.stringify(m));
  }

  /** Drive the session (and commits) from a timer (≈ every 2 ms; OS timer granularity applies). */
  startLoop(): void {
    const run = (): void => {
      this.session.update(performance.now());
      this.proof?.poll();
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
    this.proof?.dispose();
    await this.log.close();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}
