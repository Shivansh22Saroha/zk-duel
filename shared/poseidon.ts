/**
 * Poseidon (circomlib parameters) via circomlibjs, so JS hashes match the circuit's
 * `Poseidon(n)` templates. All results are decimal strings (field elements on the wire).
 */
import { buildPoseidon } from 'circomlibjs';
import { MAG_SIZE } from './constants';

type PoseidonFn = Awaited<ReturnType<typeof buildPoseidon>>;
let instance: Promise<PoseidonFn> | null = null;

function get(): Promise<PoseidonFn> {
  instance ??= buildPoseidon();
  return instance;
}

/** Poseidon over 1–16 field elements; returns a decimal string. */
export async function poseidon(inputs: readonly (bigint | number | string)[]): Promise<string> {
  const p = await get();
  return p.F.toObject(p([...inputs])).toString();
}

/**
 * Public commitment to the known start-of-round hidden state:
 * Poseidon4(MAG_SIZE, cooldown 0, reloadTimer 0, salt 0) (ARCHITECTURE §5.4).
 */
export function initialCommit(): Promise<string> {
  return poseidon([MAG_SIZE, 0, 0, 0]);
}
