/**
 * Proving-artefact loader (FEATURES F4): fetch window.wasm + window_final.zkey for a variant,
 * check SHA-256 (crypto.subtle) against the hashes the server publishes, and cache them with the
 * Cache API keyed by hash, so a second match needs no download.
 *
 * The Cache API only exists in secure contexts (https, or http://localhost). On a plain-http LAN
 * address it is missing; artefacts are then downloaded every time (still hash-checked).
 */
import { ENV } from '../env';

export interface VariantMeta {
  id: string;
  scheme: 'groth16' | 'plonk';
  windowTicks: number;
  constraints: number;
  zkeyUrl: string;
  wasmUrl: string;
  zkeySha256: string;
  wasmSha256: string;
  zkeyBytes: number;
  publicSignalOrder: ('bind' | 'digest' | 'commitIn' | 'commitOut')[];
}

export interface Artefacts {
  wasm: ArrayBuffer;
  zkey: ArrayBuffer;
  /** True when both files came from the Cache API (no download). */
  cached: boolean;
}

export class ArtefactIntegrityError extends Error {}

const CACHE_NAME = 'zkduel-artefacts-v1';

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function absolute(url: string): string {
  // artefact URLs from /api/circuit/info are paths below VITE_ZK_BASE ("/zk/…")
  return url.startsWith('/zk/') ? `${ENV.ZK_BASE}${url.slice(3)}` : url;
}

async function download(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download failed: ${url} (${r.status})`);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

async function loadOne(
  url: string,
  sha256: string,
  cache: Cache | null,
  onBytes: (n: number) => void,
): Promise<{ buf: ArrayBuffer; cached: boolean }> {
  const key = `${url}?sha256=${sha256}`;
  const hit = await cache?.match(key);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await sha256Hex(buf)) === sha256) {
      onBytes(buf.byteLength);
      return { buf, cached: true };
    }
    await cache?.delete(key); // corrupted cache entry: fall through to a fresh download
  }
  const buf = await download(url, onBytes);
  const got = await sha256Hex(buf);
  if (got !== sha256) {
    throw new ArtefactIntegrityError(`${url}: sha256 ${got} ≠ published ${sha256}`);
  }
  await cache?.put(
    key,
    new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }),
  );
  return { buf, cached: false };
}

/** Load and verify both artefacts. `onProgress(fraction)` reports download progress 0…1. */
export async function loadArtefacts(
  v: VariantMeta,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<Artefacts> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  const expected = v.zkeyBytes + 3_000_000; // wasm size is not published; ≈ 3 MB
  let seen = 0;
  const onBytes = (n: number): void => {
    seen += n;
    onProgress(Math.min(1, seen / expected));
  };
  const [wasm, zkey] = await Promise.all([
    loadOne(absolute(v.wasmUrl), v.wasmSha256, cache, onBytes),
    loadOne(absolute(v.zkeyUrl), v.zkeySha256, cache, onBytes),
  ]);
  onProgress(1);
  return { wasm: wasm.buf, zkey: zkey.buf, cached: wasm.cached && zkey.cached };
}
