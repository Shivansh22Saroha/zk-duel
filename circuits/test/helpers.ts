/** Shared helpers for circuit tests (circom_tester, wasm backend). */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import circomTester, { type WasmTester } from 'circom_tester';
import type { TickLogLine } from '@zkduel/shared/ticklog';
import { windowParams } from '../scripts/gen-main';

export const CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(CIRCUITS_DIR, '..');
export const NODE_MODULES = join(ROOT, 'node_modules');
export const FIXTURES = join(CIRCUITS_DIR, 'test', 'fixtures');

/** Compile one template from circuits/src/<file> as main with the given parameters. */
export function template(file: string, name: string, params: number[] = []): Promise<WasmTester> {
  return circomTester.wasm(join(CIRCUITS_DIR, 'src', file), {
    templateName: name,
    templateParams: params,
    include: [NODE_MODULES, join(CIRCUITS_DIR, 'src')],
    O: 2,
  });
}

/** The composed Window(N, …) with the real constants and public inputs. */
export function windowCircuit(n: number): Promise<WasmTester> {
  return circomTester.wasm(join(CIRCUITS_DIR, 'window.circom'), {
    templateName: 'Window',
    templateParams: windowParams(n),
    templatePublicSignals: ['bind', 'digest', 'commitIn'],
    include: [NODE_MODULES, CIRCUITS_DIR],
    O: 2,
  });
}

/** True iff a witness exists and satisfies every constraint. */
export async function satisfiable(c: WasmTester, input: Record<string, unknown>): Promise<boolean> {
  try {
    const w = await c.calculateWitness(input, true);
    await c.checkConstraints(w);
    return true;
  } catch {
    return false;
  }
}

/** Witness index of a signal by its full symbol name (e.g. "main.k"). */
export async function signalIndex(c: WasmTester, name: string): Promise<number> {
  await c.loadSymbols();
  const s = c.symbols[name];
  if (!s) throw new Error(`no symbol ${name}`);
  return s.varIdx;
}

/** All committed Phase 1 match logs (client side: public + private state). */
export function fixtureLogs(): { name: string; lines: TickLogLine[] }[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => ({
      name: f,
      lines: readFileSync(join(FIXTURES, f), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TickLogLine),
    }));
}
