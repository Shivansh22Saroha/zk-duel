/**
 * Play N bot-vs-bot matches against a RUNNING server and keep the logs for Phase 2.
 *
 *   npm run dev                         (server must be up; set LOG_SNAPSHOTS=true for server logs)
 *   npm run bots -- --matches 3
 *
 * Client tick logs (public + private, written locally by the bot processes, never sent):
 *   server/data/logs/clients/<matchId>-p<i>-<name>.jsonl
 * Server logs (public only, LOG_SNAPSHOTS=true): server/data/logs/<matchId>.jsonl
 * Guest auth is rate-limited to 10/min per IP, so at most 5 matches per minute.
 */
import { join } from 'node:path';
import { SERVER_ROOT } from '../src/config';
import { BotClient } from '../test/support/botClient';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const matches = Number(arg('matches', '3'));
const base = arg('url', 'http://127.0.0.1:8080');
const origin = arg('origin', 'http://localhost:5173');
const logDir = join(SERVER_ROOT, 'data', 'logs', 'clients');

async function main(): Promise<void> {
  if (matches > 5)
    throw new Error('max 5 matches per run (guest auth is limited to 10/min per IP)');
  const bots: BotClient[] = [];
  for (let i = 0; i < matches * 2; i++) {
    bots.push(
      await BotClient.connect({
        baseUrl: base,
        wsUrl: base.replace(/^http/, 'ws') + '/ws',
        origin,
        name: `bot_${Date.now() % 100000}_${i}`.slice(0, 16),
        seed: Date.now() + i,
        logDir,
      }),
    );
  }
  for (const b of bots) {
    b.startLoop();
    b.send({ t: 'queue_join' });
  }
  await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'match_end', 600_000)));
  for (const b of bots) await b.close();
  const seen = new Set<string>();
  for (const b of bots) {
    const id = b.session.match?.matchId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    console.log(
      `match ${id}: ${b.session.result?.reason} score ${b.session.result?.score.join('-')}`,
    );
  }
  console.log(`client logs → ${logDir}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
