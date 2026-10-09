import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type AppHandle } from '../../src/app';
import { loadConfig } from '../../src/config';

export const TEST_ORIGIN = 'http://localhost:5173';

export interface TestServer extends AppHandle {
  baseUrl: string;
  wsUrl: string;
  logDir: string;
  frames: { playerId: string | null; raw: string }[];
  stop(): Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const logDir = mkdtempSync(join(tmpdir(), 'zkduel-logs-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: TEST_ORIGIN,
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    LOG_SNAPSHOTS: 'true',
    ...env,
  });
  cfg.snapshotLogDir = join(logDir, 'server');
  const frames: TestServer['frames'] = [];
  const h = await buildApp(cfg, {
    onClientFrame: (playerId, raw) => frames.push({ playerId, raw }),
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (h.app.server.address() as AddressInfo).port;
  return {
    ...h,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    logDir,
    frames,
    stop: () => h.app.close(),
  };
}
