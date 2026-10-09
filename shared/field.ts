/** BN254 (snarkjs "bn128") scalar field modulus p. Every circuit signal is an element of F_p. */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * BN254 base field modulus q. Curve point coordinates inside proofs (pi_a, pi_b, pi_c, PLONK
 * commitments) are elements of F_q, which is slightly larger than F_p — so proof coordinates
 * are range-checked against q, while public signals / scalars are checked against p.
 */
export const BN254_Q =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Field elements travel as decimal strings: 1–78 digits, no sign, no leading "+". */
export const FIELD_ELEMENT_RE = /^[0-9]{1,78}$/;

/** True iff `s` is a decimal string for a value in [0, p) (scalar field). */
export function isFieldElement(s: string): boolean {
  if (!FIELD_ELEMENT_RE.test(s)) return false;
  return BigInt(s) < BN254_P;
}

/** True iff `s` is a decimal string for a value in [0, q) (base field, proof coordinates). */
export function isBaseFieldElement(s: string): boolean {
  if (!FIELD_ELEMENT_RE.test(s)) return false;
  return BigInt(s) < BN254_Q;
}
