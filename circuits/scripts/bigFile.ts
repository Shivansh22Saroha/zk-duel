/**
 * Files larger than 2 GiB (PLONK N=120 zkey: 4.2 GB). `readFileSync` refuses them (Node's
 * kIoMaxLength), so read and hash in chunks.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const CHUNK = 64 * 2 ** 20;

/** Whole file into one Uint8Array (allocations above 2 GiB are fine; single reads are not). */
export function readLarge(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const out = new Uint8Array(size);
    for (let off = 0; off < size;) {
      const n = readSync(fd, out, off, Math.min(CHUNK, size - off), off);
      if (n <= 0) throw new Error(`${path}: short read at ${off}`);
      off += n;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export function sha256File(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const h = createHash('sha256');
    const buf = new Uint8Array(CHUNK);
    for (let off = 0; ;) {
      const n = readSync(fd, buf, 0, CHUNK, off);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      off += n;
    }
    return h.digest('hex');
  } finally {
    closeSync(fd);
  }
}
