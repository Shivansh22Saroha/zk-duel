/**
 * Poseidon (circomlib parameters) via circomlibjs, so JS hashes match the circuit's
 * `Poseidon(n)` templates. All results are decimal strings (field elements on the wire).
 */
import { buildPoseidon } from 'circomlibjs';
import { MAG_SIZE } from './constants';

type PoseidonFn = Awaited<ReturnType<typeof buildPoseidon>>;
let instance: Promise<PoseidonFn> | null = null;
let ready: PoseidonFn | null = null;

function get(): Promise<PoseidonFn> {
  instance ??= buildPoseidon().then((p) => (ready = p));
  return instance;
}

/** Poseidon over 1–16 field elements; returns a decimal string. */
export async function poseidon(inputs: readonly (bigint | number | string)[]): Promise<string> {
  const p = await get();
  return p.F.toObject(p([...inputs])).toString();
}

/** Build the hasher once (seconds when cold); afterwards `poseidonSync` may be used. */
export async function poseidonReady(): Promise<void> {
  await get();
}

/**
 * Synchronous Poseidon for hot paths (the server's per-tick digest). Throws if
 * `poseidonReady()` has not resolved yet. Inputs must already be field elements (or small ints).
 */
export function poseidonSync(inputs: readonly (bigint | number | string)[]): string {
  if (!ready) throw new Error('poseidonSync before poseidonReady()');
  return ready.F.toObject(ready([...inputs])).toString();
}

/**
 * Public commitment to the known start-of-round hidden state:
 * Poseidon4(MAG_SIZE, cooldown 0, reloadTimer 0, salt 0) (ARCHITECTURE §5.4).
 */
export function initialCommit(): Promise<string> {
  return poseidon([MAG_SIZE, 0, 0, 0]);
}
