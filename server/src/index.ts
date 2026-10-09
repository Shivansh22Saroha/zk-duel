import { join } from 'node:path';
import dotenv from 'dotenv';
import { buildApp } from './app';
import { loadConfig, SERVER_ROOT } from './config';

dotenv.config({ path: join(SERVER_ROOT, '.env'), quiet: true });

try {
  const cfg = loadConfig();
  const { app } = await buildApp(cfg);
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  if (cfg.LOG_SNAPSHOTS) app.log.info(`LOG_SNAPSHOTS on → ${cfg.snapshotLogDir}`);
  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
