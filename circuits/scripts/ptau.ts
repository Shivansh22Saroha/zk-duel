/**
 * Download + verify a Hermez Powers-of-Tau file.
 *
 *   npm run circuits:ptau -- --power 16
 *
 * The file is verified against the blake2b-512 hash published in the snarkjs README
 * (copied into circuits/build.config.json). On success its SHA-256 is recorded next to it,
 * so info.json can cite `ptauSha256` (SECURITY.md §9). A file that fails verification is deleted.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';

const CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(CIRCUITS_DIR, 'build.config.json');
export const PTAU_DIR = join(CIRCUITS_DIR, 'ptau');

interface PtauEntry {
  file: string;
  url: string;
  blake2b512: string;
  sha256?: string;
}
interface BuildConfig {
  ptau: { files: Record<string, PtauEntry> };
}

function loadConfig(): BuildConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as BuildConfig;
}

async function hashFile(path: string): Promise<{ blake2b512: string; sha256: string }> {
  const b2 = createHash('blake2b512');
  const s256 = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    b2.update(chunk as Buffer);
    s256.update(chunk as Buffer);
  }
  return { blake2b512: b2.digest('hex'), sha256: s256.digest('hex') };
}

/** Ensure ptau of the given power is present and verified; returns its path and hashes. */
export async function ensurePtau(
  power: number,
): Promise<{ path: string; file: string; sha256: string }> {
  const config = loadConfig();
  const entry = config.ptau.files[String(power)];
  if (!entry) throw new Error(`No ptau entry for power ${power} in build.config.json`);
  mkdirSync(PTAU_DIR, { recursive: true });
  const path = join(PTAU_DIR, entry.file);

  if (!existsSync(path)) {
    const tmp = `${path}.part`;
    console.log(`Downloading ${entry.url} …`);
    const res = await fetch(entry.url);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let got = 0;
    let lastPct = -10;
    const body = Readable.fromWeb(res.body as WebReadableStream);
    body.on('data', (c: Buffer) => {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct >= lastPct + 10) {
        lastPct = pct;
        console.log(`  ${pct}% (${(got / 2 ** 20).toFixed(1)} MiB)`);
      }
    });
    await pipeline(body, createWriteStream(tmp));
    renameSync(tmp, path);
  }

  const { blake2b512, sha256 } = await hashFile(path);
  if (blake2b512 !== entry.blake2b512) {
    rmSync(path);
    throw new Error(
      `blake2b mismatch for ${entry.file} — file deleted.\n expected ${entry.blake2b512}\n got      ${blake2b512}`,
    );
  }
  if (entry.sha256 && entry.sha256 !== sha256) {
    throw new Error(`sha256 differs from the recorded value for ${entry.file}`);
  }
  if (!entry.sha256) {
    entry.sha256 = sha256;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  }
  console.log(
    `OK ${entry.file}\n  blake2b512 ${blake2b512} (matches snarkjs README)\n  sha256     ${sha256}`,
  );
  return { path, file: entry.file, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--power');
  const power = Number(i >= 0 ? process.argv[i + 1] : NaN);
  if (!Number.isInteger(power)) {
    console.error('usage: npm run circuits:ptau -- --power <8..20>');
    process.exit(2);
  }
  ensurePtau(power).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
