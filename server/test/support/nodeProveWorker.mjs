// Node prover worker for bots (the Node twin of client/src/zk/proofWorker.ts): snarkjs witness +
// Groth16 prove in a worker_thread. `threads` caps ffjavascript's pool (it sizes it from os.cpus())
// so test provers leave CPU for the server running in the same process.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import threads, { parentPort, workerData } from 'node:worker_threads';

// see server/src/zk/verifyWorker.mjs: let ffjavascript's `web-worker` spawn nested threads
Object.defineProperty(threads, 'isMainThread', { value: true });

if (workerData.threads) {
  const cpus = os.cpus();
  os.cpus = () => cpus.slice(0, workerData.threads);
}
const snarkjs = await import('snarkjs');
// read the artefacts once (snarkjs would otherwise re-read both files on every proof)
const wasm = new Uint8Array(readFileSync(workerData.wasmPath));
const zkey = new Uint8Array(readFileSync(workerData.zkeyPath));

parentPort.on('message', async ({ id, input }) => {
  const t0 = performance.now();
  const wtns = { type: 'mem' };
  try {
    await snarkjs.wtns.calculate(input, wasm, wtns);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, reason: `witness: ${String(e).slice(0, 180)}` });
    return;
  }
  const t1 = performance.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, wtns);
    parentPort.postMessage({
      id,
      ok: true,
      proof,
      publicSignals,
      witnessMs: t1 - t0,
      proveMs: performance.now() - t1,
    });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, reason: `prove: ${String(e).slice(0, 180)}` });
  }
});
parentPort.postMessage({ ready: true });
