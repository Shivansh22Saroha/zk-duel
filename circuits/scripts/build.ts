/**
 * Build circuit variants (ARCHITECTURE §5.5): Groth16 (live play + benchmarks) and PLONK
 * (benchmark comparison only, Phase 5).
 *
 *   npm run circuits:build                              groth16_60 (ACTIVE default) + groth16_4 (tests)
 *   npm run circuits:build -- --n 4                     one Groth16 variant
 *   npm run circuits:build -- --n 120 --scheme plonk    one PLONK variant
 *   npm run circuits:build -- --all                     the 6 variants of build.config.json
 *
 * Steps per variant:
 *  1. generate main_<N>.circom from shared/constants.ts
 *  2. circom --O2 → r1cs, wasm, sym
 *  3. ptau power from the REAL constraint count (snarkjs's rule), smallest Hermez file that fits,
 *     downloaded + blake2b-verified if missing
 *  4. Groth16 phase 2 with ONE local contribution; entropy = crypto.randomBytes, never stored or
 *     printed (single-party setup — SECURITY A8 limitation); intermediate _0000.zkey deleted.
 *     PLONK: universal setup from the ptau alone (no circuit-specific contribution). Its gate count
 *     ("PLONK constraints" = R1CS constraints + linear-combination additions) decides the ptau
 *     power, so it is read from a first setup against the largest local ptau, then the setup is
 *     redone against the smallest Hermez file that fits.
 *  5. export verification_key.json, copy window.wasm
 *  6. prove + verify one honest window and derive publicSignalOrder by matching the JS values
 *  7. info.json { constraints, publicInputs, publicSignalOrder, ptauPower, zkeySha256, … }
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
import { sha256File } from './bigFile';
import { ensurePtau, PTAU_DIR } from './ptau';

const NODE_MODULES = join(CIRCUITS_DIR, '..', 'node_modules');
export const BUILD_DIR = join(CIRCUITS_DIR, 'build');

export type Scheme = 'groth16' | 'plonk';

export interface VariantInfo {
  id: string;
  scheme: Scheme;
  windowTicks: number;
  /** R1CS constraints (the same circuit for both schemes). */
  constraints: number;
  /** PLONK only: gates after snarkjs's R1CS → PLONK conversion (this sets the ptau power). */
  plonkConstraints?: number;
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
  wasmBytes?: number;
  vkeySha256: string;
  vkeyBytes?: number;
  /** Wall time of the setup step (zkey generation), ms. */
  setupMs?: number;
  constantsHash: string;
  circomVersion: string;
  snarkjsVersion: string;
  circomFlags: string;
  setup: string;
  builtAt: string;
}

/** snarkjs zkey_new.js: cirPower = floor(log2(nConstraints + nPubInputs + nOutputs)) + 1. */
export function ptauPowerFor(r: {
  nConstraints: number;
  nPubInputs: number;
  nOutputs: number;
}): number {
  const n = r.nConstraints + r.nPubInputs + r.nOutputs;
  return Math.max(8, Math.floor(Math.log2(n)) + 1);
}

/** snarkjs plonk_setup.js: cirPower = log2(nPlonk − 1) + 1 (bit length), at least 3. */
export function plonkPowerFor(nPlonk: number): number {
  return Math.max(3, Math.floor(Math.log2(nPlonk - 1)) + 1);
}

/**
 * PLONK setup against `ptauPath`. Returns the PLONK gate count; negative when the ptau was too
 * small (no zkey written).
 */
async function plonkSetup(r1cs: string, ptauPath: string, zkey: string): Promise<number> {
  let nPlonk = 0;
  let tooBig = false;
  const logger = {
    info: (m: string) => {
      const x = /^Plonk constraints: (\d+)/.exec(m);
      if (x) nPlonk = Number(x[1]);
    },
    error: (m: string) => {
      if (m.includes('too big')) tooBig = true;
    },
    warn: () => undefined,
    debug: () => undefined,
  };
  const r = (await snarkjs.plonk.setup(r1cs, ptauPath, zkey, logger)) as unknown;
  if (!nPlonk) throw new Error('plonk setup did not report its constraint count');
  if (tooBig || r === -1) {
    rmSync(zkey, { force: true });
    return -nPlonk;
  }
  return nPlonk;
}

function largestLocalPtau(): number {
  const powers = readdirSync(PTAU_DIR)
    .map((f) => /final_(\d+)\.ptau$/.exec(f)?.[1])
    .filter((p): p is string => p !== undefined)
    .map(Number);
  if (!powers.length) throw new Error('no local ptau file');
  return Math.max(...powers);
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

export async function buildVariant(n: number, scheme: Scheme = 'groth16'): Promise<VariantInfo> {
  const id = `${scheme}_${n}`;
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

  const zkey = join(dir, 'window_final.zkey');
  let power: number;
  let ptau: Awaited<ReturnType<typeof ensurePtau>>;
  let plonkConstraints: number | undefined;
  const ts = Date.now();
  if (scheme === 'groth16') {
    // 3. ptau
    power = ptauPowerFor(info);
    ptau = await ensurePtau(power);
    log(`ptau power ${power} (${ptau.file})`);

    // 4. Groth16 setup: one local phase-2 contribution
    const zkey0 = join(dir, 'window_0000.zkey');
    await snarkjs.zKey.newZKey(r1csPath, ptau.path, zkey0);
    await snarkjs.zKey.contribute(
      zkey0,
      zkey,
      'zk-duel local phase-2 contribution',
      randomBytes(64).toString('hex'),
    );
    rmSync(zkey0);
    log('zkey ready (single local contribution; entropy discarded)');
  } else {
    // 3–4. PLONK: gate count from a setup against the largest local ptau, then the smallest fit
    const local = await ensurePtau(largestLocalPtau());
    const first = await plonkSetup(r1csPath, local.path, zkey);
    plonkConstraints = Math.abs(first);
    power = plonkPowerFor(plonkConstraints);
    log(`${plonkConstraints} PLONK constraints → ptau power ${power}`);
    ptau = await ensurePtau(power);
    if (first < 0 || ptau.path !== local.path) {
      if ((await plonkSetup(r1csPath, ptau.path, zkey)) < 0)
        throw new Error(`plonk setup still too big for ptau power ${power}`);
    }
    log(`zkey ready (PLONK universal setup on ${ptau.file})`);
  }
  const setupMs = Date.now() - ts;

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
  const prover = scheme === 'groth16' ? snarkjs.groth16 : snarkjs.plonk;
  const { proof, publicSignals } = await prover.fullProve(input, wasm, zkey);
  if (!(await prover.verify(vkey, publicSignals, proof as never)))
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
    scheme,
    windowTicks: n,
    constraints: info.nConstraints,
    ...(plonkConstraints ? { plonkConstraints } : {}),
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
    wasmBytes: statSync(wasm).size,
    vkeySha256: sha256File(vkeyPath),
    vkeyBytes: statSync(vkeyPath).size,
    setupMs,
    constantsHash: await constantsHash(),
    circomVersion,
    snarkjsVersion: pkgVersion('snarkjs'),
    circomFlags,
    setup:
      scheme === 'groth16'
        ? `groth16 phase 2: single local contribution (SECURITY A8); public inputs [${MAIN_PUBLIC_INPUTS.join(', ')}], output commitOut`
        : `plonk universal setup (no circuit-specific contribution); public inputs [${MAIN_PUBLIC_INPUTS.join(', ')}], output commitOut`,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'info.json'), JSON.stringify(v, null, 2) + '\n');
  log(`done: zkey ${(v.zkeyBytes / 2 ** 20).toFixed(2)} MiB sha256 ${v.zkeySha256}`);
  return v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--n');
  const si = process.argv.indexOf('--scheme');
  const scheme: Scheme = si >= 0 && process.argv[si + 1] === 'plonk' ? 'plonk' : 'groth16';
  const config = JSON.parse(readFileSync(join(CIRCUITS_DIR, 'build.config.json'), 'utf8')) as {
    variants: { scheme: Scheme; windowTicks: number }[];
  };
  const list: { n: number; scheme: Scheme }[] = process.argv.includes('--all')
    ? config.variants.map((v) => ({ n: v.windowTicks, scheme: v.scheme }))
    : i >= 0
      ? [{ n: Number(process.argv[i + 1]), scheme }]
      : [
          { n: 60, scheme: 'groth16' },
          { n: 4, scheme: 'groth16' },
        ];
  (async () => {
    for (const v of list) await buildVariant(v.n, v.scheme);
    process.exit(0); // snarkjs keeps worker threads alive
  })().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
