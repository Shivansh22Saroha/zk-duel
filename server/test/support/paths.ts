import { join, resolve } from 'node:path';
import { SERVER_ROOT } from '../../src/config';

export const REPO_ROOT = resolve(SERVER_ROOT, '..');
export const CIRCUITS_BUILD = join(REPO_ROOT, 'circuits', 'build');
/** Test reports (gitignored): server/data/test-reports. */
export const REPORT_DIR = join(SERVER_ROOT, 'data', 'test-reports');
