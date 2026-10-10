// VerifierPool worker (ARCHITECTURE §6): snarkjs verify in a worker_thread, so a slow verify never
// blocks the match tick loop. Plain JS on purpose — it only needs snarkjs and runs without a TS loader.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import threads, { parentPort, workerData } from 'node:worker_threads';

// ffjavascript creates its thread pool with the `web-worker` package, which assumes that any
// worker_thread it is loaded in is one of its own children (and crashes on our workerData).
// Present this thread as a main thread so it spawns its nested threads normally. (The pool is
// left at its default size: capping it to one thread doubled verify time — p50 26 → 65 ms.)
Object.defineProperty(threads, 'isMainThread', { value: true });
const snarkjs = await import('snarkjs');

const vkey = JSON.parse(readFileSync(workerData.vkeyPath, 'utf8'));
const verifier = workerData.scheme === 'plonk' ? snarkjs.plonk : snarkjs.groth16;

// Warm-up: the first verify builds the curve (WASM + thread pool). Do it before reporting ready so
// measured verify times are steady-state. vk points are on the curve, so this simply returns false.
if (workerData.scheme === 'groth16') {
  await verifier.verify(vkey, vkey.IC.map(() => '1').slice(1), {
    pi_a: vkey.vk_alpha_1,
    pi_b: vkey.vk_beta_2,
    pi_c: vkey.vk_alpha_1,
    protocol: 'groth16',
    curve: 'bn128',
  });
}

parentPort.on('message', async ({ id, publicSignals, proof }) => {
  const t0 = performance.now();
  let ok = false;
  let error = null;
  try {
    ok = (await verifier.verify(vkey, publicSignals, proof)) === true;
  } catch (e) {
    error = String(e).slice(0, 200);
  }
  parentPort.postMessage({ id, ok, ms: performance.now() - t0, error });
});
parentPort.postMessage({ ready: true });
