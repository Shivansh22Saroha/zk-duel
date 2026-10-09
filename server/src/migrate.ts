/** `npm run db:migrate` — apply pending SQL migrations to DB_PATH. */
import { join } from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, SERVER_ROOT } from './config';
import { migrate, openDb } from './db/index';

dotenv.config({ path: join(SERVER_ROOT, '.env'), quiet: true });

try {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath); // openDb applies migrations
  const versions = (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[]
  ).map((r) => r.version);
  console.log(
    `DB ${cfg.dbPath}: schema versions [${versions.join(', ')}]; pending now: [${migrate(db).join(', ')}]`,
  );
  db.close();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
