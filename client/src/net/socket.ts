/** WebSocket connection: hello handshake, validated server messages, RTT pings. */
import { serverMessage, type ClientFrame, type ServerMessage } from '@zkduel/shared/protocol';
import { ENV } from '../env';

const PING_EVERY_MS = 2000;

export class Net {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  rttMs = 0;
  onMessage: (m: ServerMessage) => void = () => undefined;
  onClose: (code: number) => void = () => undefined;

  connect(token: string, constantsHash: string): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ENV.WS_URL);
      this.ws = ws;
      ws.onopen = () => this.send({ t: 'hello', token, clientVersion: '0.1.0', constantsHash });
      ws.onmessage = (ev) => {
        let m: ServerMessage;
        try {
          m = serverMessage.parse(JSON.parse(String(ev.data)));
        } catch {
          return; // ignore anything the schema rejects
        }
        if (m.t === 'welcome') {
          this.startPing();
          resolve(m);
        } else if (
          m.t === 'error' &&
          (m.code === 'UNAUTHORIZED' || m.code === 'VERSION_MISMATCH')
        ) {
          reject(new Error(m.code));
        }
        if (m.t === 'pong') this.rttMs = performance.now() - m.ts;
        this.onMessage(m);
      };
      ws.onclose = (ev) => {
        this.stopPing();
        reject(new Error(`closed ${ev.code}`));
        this.onClose(ev.code);
      };
    });
  }

  send(m: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  private startPing(): void {
    this.pingTimer = window.setInterval(
      () => this.send({ t: 'ping', ts: performance.now() }),
      PING_EVERY_MS,
    );
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
