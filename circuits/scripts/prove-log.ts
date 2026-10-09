/**
 * Offline end-to-end check (B6): prove and verify every window of a client tick log.
 *
 *   npm run circuits:prove-log -- --log <client tick log .jsonl> --n 60
 *
 * For each window: build the input with shared/zkInput.ts, compute the witness, prove with
 * snarkjs Groth16 (Node), verify with verification_key.json, and check that the circuit's public
 * signals (named via info.json.publicSignalOrder) equal the JS reference values.
 * Exit code 1 if any window fails. Real random salts are used, as in live play.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import {
  buildWindowInput,
  namePublicSignals,
  PUBLIC_SIGNAL_NAMES,
  randomSalt,
  sliceLogWindows,
} from '@zkduel/shared/zkInput';
import type { VariantInfo } from './build';
import { CIRCUITS_DIR } from './gen-main';

export interface WindowResult {
  round: number;
  window: number;
  padded: boolean;
  witnessMs: number | null;
  proveMs: number | null;
  verifyMs: number | null;
  proofBytes: number | null;
  valid: boolean;
  jsMatches: boolean | null;
  error?: string;
}

export async function proveLog(
  logPath: string,
  n: number,
): Promise<{ info: VariantInfo; results: WindowResult[] }> {
  const dir = join(CIRCUITS_DIR, 'build', `groth16_${n}`);
  const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as VariantInfo;
  const vkey = JSON.parse(readFileSync(join(dir, 'verification_key.json'), 'utf8')) as unknown;
  const wasm = new Uint8Array(readFileSync(join(dir, 'window.wasm')));
  const zkey = { type: 'mem', data: new Uint8Array(readFileSync(join(dir, 'window_final.zkey'))) };
  const lines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TickLogLine);
  const results: WindowResult[] = [];
  for (const w of sliceLogWindows(lines, n, () => randomSalt())) {
    const r: WindowResult = {
      round: w.ctx.roundNo,
      window: w.ctx.windowIndex,
      padded: w.padded,
      witnessMs: null,
      proveMs: null,
      verifyMs: null,
      proofBytes: null,
      valid: false,
      jsMatches: null,
    };
    const { input, expected } = await buildWindowInput(w.ctx, w.records);
    const wtns = { type: 'mem' } as { type: 'mem'; data?: Uint8Array };
    let t = performance.now();
    try {
      await snarkjs.wtns.calculate(input, wasm, wtns);
    } catch (e) {
      r.error = (e instanceof Error ? e.message : String(e))
        .split('\n')
        .slice(0, 2)
        .join(' ')
        .slice(0, 120);
      results.push(r);
      continue;
    }
    r.witnessMs = performance.now() - t;
    t = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(
      zkey as unknown as Uint8Array,
      wtns as unknown as Uint8Array,
    );
    r.proveMs = performance.now() - t;
    t = performance.now();
    r.valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    r.verifyMs = performance.now() - t;
    r.proofBytes = JSON.stringify(proof).length;
    const named = namePublicSignals(info.publicSignalOrder, publicSignals);
    r.jsMatches = PUBLIC_SIGNAL_NAMES.every((k) => named[k] === expected[k]);
    results.push(r);
  }
  return { info, results };
}

export function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number) : NaN;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string): string | undefined => {
    const j = process.argv.indexOf(`--${k}`);
    return j >= 0 ? process.argv[j + 1] : undefined;
  };
  const log = arg('log');
  const n = Number(arg('n') ?? 60);
  if (!log) {
    console.error('usage: npm run circuits:prove-log -- --log <client tick log> --n 60');
    process.exit(2);
  }
  // npm runs workspace scripts inside circuits/; resolve paths against where npm was invoked
  proveLog(resolve(process.env.INIT_CWD ?? process.cwd(), log), n)
    .then(({ info, results }) => {
      const f = (v: number | null, d = 1) => (v === null ? '-' : v.toFixed(d));
      console.log(
        `${basename(log)} — ${info.id}, ${info.constraints} constraints, zkey ${(info.zkeyBytes / 2 ** 20).toFixed(1)} MiB`,
      );
      console.log(
        'round window padded | witness ms | prove ms | verify ms | proof B | valid | JS=circuit',
      );
      for (const r of results) {
        console.log(
          `${String(r.round).padStart(5)} ${String(r.window).padStart(6)} ${r.padded ? '   yes' : '    no'} | ${f(r.witnessMs).padStart(10)} | ${f(r.proveMs).padStart(8)} | ${f(r.verifyMs).padStart(9)} | ${String(r.proofBytes ?? '-').padStart(7)} | ${r.valid ? '  yes' : '   NO'} | ${r.jsMatches === null ? '-' : r.jsMatches ? 'yes' : 'NO'}${r.error ? `   ✕ no witness: ${r.error}` : ''}`,
        );
      }
      const ok = results.filter((r) => r.valid && r.jsMatches);
      const prove = ok.map((r) => r.proveMs as number);
      const wit = ok.map((r) => r.witnessMs as number);
      const ver = ok.map((r) => r.verifyMs as number);
      console.log(
        `\nwindows ${results.length}: valid ${ok.length}, failed ${results.length - ok.length}` +
          (ok.length
            ? ` | witness p50 ${pct(wit, 0.5).toFixed(1)} ms | prove p50 ${pct(prove, 0.5).toFixed(0)} ms p95 ${pct(prove, 0.95).toFixed(0)} ms | verify p50 ${pct(ver, 0.5).toFixed(1)} ms | proof ${ok[0]?.proofBytes} B`
            : ''),
      );
      process.exit(ok.length === results.length ? 0 : 1);
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
