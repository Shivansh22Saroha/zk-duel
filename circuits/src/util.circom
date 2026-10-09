pragma circom 2.2.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// nbits(v) (from circomlib bitify.circom) = smallest b with 2^b > v: the bit width that holds
// every integer in [0, v].

// LO <= in <= HI. `in` is first range-checked to BITS bits with Num2Bits, so the comparators
// below can never be fooled by a field element that "wraps" (e.g. a negative number mod p).
// Requires HI + 1 < 2^BITS (true whenever BITS = nbits(HI)).
template InRange(BITS, LO, HI) {
    signal input in;

    component bits = Num2Bits(BITS);
    bits.in <== in;

    component ge = GreaterEqThan(BITS);
    ge.in[0] <== in;
    ge.in[1] <== LO;
    ge.out === 1;

    component le = LessEqThan(BITS);
    le.in[0] <== in;
    le.in[1] <== HI;
    le.out === 1;
}
