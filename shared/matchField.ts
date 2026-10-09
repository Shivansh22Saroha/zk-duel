/**
 * matchField = first 31 bytes of SHA-256(matchId UUID string, UTF-8) read as a big-endian
 * integer. 31 bytes = 248 bits < 254, so the value is always < p (ARCHITECTURE §5.2).
 */
export async function matchField(matchId: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(matchId)),
  );
  let v = 0n;
  for (let i = 0; i < 31; i++) v = (v << 8n) | BigInt(digest[i] as number);
  return v.toString();
}
