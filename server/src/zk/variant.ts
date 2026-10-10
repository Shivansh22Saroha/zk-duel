/**
 * Circuit variants built by `npm run circuits:build` (ARCHITECTURE §5.5). The server reads only
 * `info.json` (hashes, publicSignalOrder) and `verification_key.json`; the client downloads
 * window.wasm + window_final.zkey from /zk/<id>/ and checks them against these hashes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scheme } from '@zkduel/shared/constants';
import { PUBLIC_SIGNAL_NAMES, type PublicSignalName } from '@zkduel/shared/zkInput';

export interface VariantInfo {
  id: string;
  scheme: Scheme;
  windowTicks: number;
  constraints: number;
  publicSignalOrder: PublicSignalName[];
  zkeySha256: string;
  zkeyBytes: number;
  wasmSha256: string;
  vkeySha256: string;
  ptauPower: number;
  builtAt: string;
}

export interface LoadedVariant {
  info: VariantInfo;
  vkeyPath: string;
}

export function loadVariant(artefactDir: string, id: string): LoadedVariant {
  const dir = join(artefactDir, id);
  const infoPath = join(dir, 'info.json');
  const vkeyPath = join(dir, 'verification_key.json');
  if (!existsSync(infoPath) || !existsSync(vkeyPath)) {
    throw new Error(
      `Circuit variant ${id} is not built (${dir}). Run: npm run circuits:build -- --n ${id.split('_')[1]}`,
    );
  }
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as VariantInfo;
  const order = info.publicSignalOrder;
  if (
    order.length !== PUBLIC_SIGNAL_NAMES.length ||
    !PUBLIC_SIGNAL_NAMES.every((n) => order.includes(n))
  ) {
    throw new Error(
      `${infoPath}: publicSignalOrder must be a permutation of ${PUBLIC_SIGNAL_NAMES}`,
    );
  }
  return { info, vkeyPath };
}

/** Every built variant (for /api/circuit/info and /api/health). */
export function listVariants(artefactDir: string): VariantInfo[] {
  if (!existsSync(artefactDir)) return [];
  return readdirSync(artefactDir)
    .filter((d) => /^(groth16|plonk)_\d+$/.test(d) && existsSync(join(artefactDir, d, 'info.json')))
    .map((d) => JSON.parse(readFileSync(join(artefactDir, d, 'info.json'), 'utf8')) as VariantInfo)
    .sort((a, b) => a.scheme.localeCompare(b.scheme) || a.windowTicks - b.windowTicks);
}

/** /api/circuit/info `variants[]` entry (API_SPEC §3). */
export function publicVariant(v: VariantInfo) {
  return {
    id: v.id,
    scheme: v.scheme,
    windowTicks: v.windowTicks,
    constraints: v.constraints,
    publicInputs: 4,
    zkeyUrl: `/zk/${v.id}/window_final.zkey`,
    wasmUrl: `/zk/${v.id}/window.wasm`,
    zkeySha256: v.zkeySha256,
    zkeyBytes: v.zkeyBytes,
    wasmSha256: v.wasmSha256,
    publicSignalOrder: v.publicSignalOrder,
  };
}
