import { CONSTANTS } from './constants';

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays kept in order.
 * Only plain JSON values (no undefined, functions, bigint) are allowed.
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** Lowercase hex SHA-256 of a UTF-8 string (WebCrypto; works in Node 22 and browsers). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** constantsHash = hex SHA-256 of the canonical JSON of every constant (API_SPEC §3). */
export function constantsHash(): Promise<string> {
  return sha256Hex(canonicalJson(CONSTANTS));
}
