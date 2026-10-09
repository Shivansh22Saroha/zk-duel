/**
 * Build Groth16 circuit variants (ARCHITECTURE §5.5).
 *
 *   npm run circuits:build                 groth16_60 (ACTIVE default) + groth16_4 (tests)
 *   npm run circuits:build -- --n 4        one variant
 *
 * Steps per variant:
 *  1. generate main_<N>.circom from shared/constants.ts
 *  2. circom --O2 → r1cs, wasm, sym
 *  3. ptau power from the REAL constraint count (snarkjs's rule), smallest Hermez file that fits,
 *     downloaded + blake2b-verified if missing
 *  4. Groth16 phase 2 with ONE local contribution; entropy = crypto.randomBytes, never stored or
 *     printed (single-party setup — SECURITY A8 limitation); intermediate _0000.zkey deleted
 *  5. export verification_key.json, copy window.wasm
 *  6. prove + verify one honest window and derive publicSignalOrder by matching the JS values
 *  7. info.json { constraints, publicInputs, publicSignalOrder, ptauPower, zkeySha256, … }
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as snarkjs from 'snarkjs';
import { constantsHash } from '@zkduel/shared/canonical';
import { spawnState, stepPlayer, toRecord, type TickRecord } from '@zkduel/shared/sim';
import {
  buildWindowInput,
  PUBLIC_SIGNAL_NAMES,
  randomSalt,
  type PublicSignalName,
} from '@zkduel/shared/zkInput';
import { CIRCUITS_DIR, genMain, MAIN_PUBLIC_INPUTS } from './gen-main';
import { ensurePtau } from './ptau';

const NODE_MODULES = join(CIRCUITS_DIR, '..', 'node_modules');
export const BUILD_DIR = join(CIRCUITS_DIR, 'build');

export interface VariantInfo {
  id: string;
  scheme: 'groth16';
  windowTicks: number;
  constraints: number;
  publicInputs: number;
  publicOutputs: number;
  privateInputs: number;
  wires: number;
  publicSignalOrder: PublicSignalName[];
  ptauPower: number;
  ptauFile: string;
  ptauSha256: string;
  zkeySha256: string;
  zkeyBytes: number;
  wasmSha256: string;
  vkeySha256: string;
  constantsHash: string;
  circomVersion: string;
  snarkjsVersion: string;
  circomFlags: string;
  setup: string;
  builtAt: string;
}

const sha256File = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

/** snarkjs zkey_new.js: cirPower = floor(log2(nConstraints + nPubInputs + nOutputs)) + 1. */
export function ptauPowerFor(r: {
  nConstraints: number;
  nPubInputs: number;
  nOutputs: number;
}): number {
  const n = r.nConstraints + r.nPubInputs + r.nOutputs;
  return Math.max(8, Math.floor(Math.log2(n)) + 1);
}

function pkgVersion(name: string): string {
  return (
    JSON.parse(readFileSync(join(NODE_MODULES, name, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
}

/** N honest ticks from P0's spawn: move, turn, fire — used to detect the public signal order. */
function sampleWindow(n: number): TickRecord[] {
  let s = spawnState(0);
  const out: TickRecord[] = [];
  for (let t = 0; t < n; t++) {
    const r = stepPlayer(s, { moveX: 1, moveY: t % 2, aimTarget: 300, fire: true, reload: false });
    s = r.state;
    out.push(toRecord(t, r.state, r.reloadPress));
  }
  return out;
}

export async function buildVariant(n: number): Promise<VariantInfo> {
  const id = `groth16_${n}`;
  const dir = join(BUILD_DIR, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${id}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

  // 1–2. compile
  const main = genMain(n);
  const circomFlags = '--r1cs --wasm --sym --O2';
  execFileSync('circom', [main, ...circomFlags.split(' '), '-l', NODE_MODULES, '-o', dir], {
    stdio: 'pipe',
  });
  const circomVersion = execFileSync('circom', ['--version'], { encoding: 'utf8' }).trim();
  const r1csPath = join(dir, `main_${n}.r1cs`);
  const info = await snarkjs.r1cs.info(r1csPath);
  log(
    `compiled: ${info.nConstraints} constraints, ${info.nPubInputs} public inputs, ${info.nOutputs} outputs`,
  );

  // 3. ptau
  const power = ptauPowerFor(info);
  const ptau = await ensurePtau(power);
  log(`ptau power ${power} (${ptau.file})`);

  // 4. Groth16 setup: one local phase-2 contribution
  const zkey0 = join(dir, 'window_0000.zkey');
  const zkey = join(dir, 'window_final.zkey');
  await snarkjs.zKey.newZKey(r1csPath, ptau.path, zkey0);
  await snarkjs.zKey.contribute(
    zkey0,
    zkey,
    'zk-duel local phase-2 contribution',
    randomBytes(64).toString('hex'),
  );
  rmSync(zkey0);
  log('zkey ready (single local contribution; entropy discarded)');

  // 5. artefacts
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const vkeyPath = join(dir, 'verification_key.json');
  writeFileSync(vkeyPath, JSON.stringify(vkey, null, 1));
  const wasm = join(dir, 'window.wasm');
  copyFileSync(join(dir, `main_${n}_js`, `main_${n}.wasm`), wasm);

  // 6. public signal order, from a real proof
  const recs = sampleWindow(n);
  const s0 = spawnState(0);
  const { input, expected } = await buildWindowInput(
    {
      matchField: '1234567',
      playerIndex: 0,
      roundNo: 1,
      windowIndex: 0,
      prev: [s0.pub.x, s0.pub.y, s0.pub.angle, 0],
      hiddenIn: s0.hidden,
      saltIn: '0',
      saltOut: randomSalt(),
    },
    recs,
  );
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof)))
    throw new Error('sample proof did not verify');
  const order = publicSignals.map((v) => {
    const names = PUBLIC_SIGNAL_NAMES.filter((k) => expected[k] === v);
    if (names.length !== 1) throw new Error(`cannot identify public signal ${v}`);
    return names[0] as PublicSignalName;
  });
  if (new Set(order).size !== PUBLIC_SIGNAL_NAMES.length)
    throw new Error('publicSignalOrder is not a permutation');
  log(`sample proof verified; publicSignalOrder = [${order.join(', ')}]`);

  // 7. info.json
  const v: VariantInfo = {
    id,
    scheme: 'groth16',
    windowTicks: n,
    constraints: info.nConstraints,
    publicInputs: info.nPubInputs,
    publicOutputs: info.nOutputs,
    privateInputs: info.nPrvInputs,
    wires: info.nVars,
    publicSignalOrder: order,
    ptauPower: power,
    ptauFile: ptau.file,
    ptauSha256: ptau.sha256,
    zkeySha256: sha256File(zkey),
    zkeyBytes: statSync(zkey).size,
    wasmSha256: sha256File(wasm),
    vkeySha256: sha256File(vkeyPath),
    constantsHash: await constantsHash(),
    circomVersion,
    snarkjsVersion: pkgVersion('snarkjs'),
    circomFlags,
    setup: `groth16 phase 2: single local contribution (SECURITY A8); public inputs [${MAIN_PUBLIC_INPUTS.join(', ')}], output commitOut`,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'info.json'), JSON.stringify(v, null, 2) + '\n');
  log(`done: zkey ${(v.zkeyBytes / 2 ** 20).toFixed(2)} MiB sha256 ${v.zkeySha256}`);
  return v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--n');
  const ns = i >= 0 ? [Number(process.argv[i + 1])] : [60, 4];
  (async () => {
    for (const n of ns) await buildVariant(n);
    process.exit(0); // snarkjs keeps worker threads alive
  })().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
