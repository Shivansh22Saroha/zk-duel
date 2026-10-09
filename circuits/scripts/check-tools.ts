/**
 * Verify the ZK toolchain: circom 2.2.x, circomspect, snarkjs 0.7.x, circomlib 2.0.x, Node 22.
 *   npm run circuits:check
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let failed = false;

function check(name: string, fn: () => string, expect: RegExp): void {
  try {
    const v = fn().trim();
    const ok = expect.test(v);
    if (!ok) failed = true;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${v}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8' });
/** Version of an installed package (walks up from its entry point; some packages hide package.json behind "exports"). */
function pkgVersion(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version: string };
      if (pkg.name === name) return pkg.version;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`package.json for ${name} not found`);
    dir = up;
  }
}

check('node', () => process.version, /^v22\./);
check('circom', () => run('circom', ['--version']), /circom compiler 2\.2\.\d+/);
check('circomspect', () => run('circomspect', ['--help']).split('\n')[0] ?? '', /circomspect/i);
check('snarkjs', () => pkgVersion('snarkjs'), /^0\.7\.\d+$/);
check('circomlib', () => pkgVersion('circomlib'), /^2\.0\.\d+$/);

process.exit(failed ? 1 : 0);
