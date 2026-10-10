/**
 * Re-print the detection matrix (incl. the scheduler-aware prediction) and re-export the CSV from
 * detection_runs, without running anything.   npx tsx server/scripts/detection-report.ts
 */
import { join } from 'node:path';
import { openDb } from '../src/db/index';
import { SERVER_ROOT } from '../src/config';
import { REPO_ROOT } from '../test/support/paths';
import { exportCsv, matrix } from './detection';

const db = openDb(process.argv[2] ?? join(SERVER_ROOT, 'data', 'zkduel.db'));
const n = exportCsv(db, join(REPO_ROOT, 'bench', 'out', 'detection.csv'));
console.log(`${n} rows → bench/out/detection.csv\n\n${matrix(db)}`);
db.close();
