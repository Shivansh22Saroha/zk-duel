import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, constantsHash, sha256Hex } from './canonical';
import { CONSTANTS } from './constants';

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('rejects non-JSON values', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('constantsHash', () => {
  it('equals SHA-256 of the canonical JSON of CONSTANTS (WebCrypto matches node:crypto)', async () => {
    const expected = createHash('sha256').update(canonicalJson(CONSTANTS), 'utf8').digest('hex');
    expect(await constantsHash()).toBe(expected);
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
