pragma circom 2.2.0;

include "util.circom";

// ARCHITECTURE §5.3 rule 3: |cur − prev| <= MAX_SPEED on one axis.
// shifted = cur − prev + MAX_SPEED must be an integer in [0, 2·MAX_SPEED]. Num2Bits first:
// a too-negative step (e.g. −(MAX_SPEED+1)) makes `shifted` wrap to ≈ p and fails the bit check.
template SpeedCheck(MAX_SPEED) {
    signal input prev;
    signal input cur;

    signal shifted <== cur - prev + MAX_SPEED;
    component ok = InRange(nbits(2 * MAX_SPEED), 0, 2 * MAX_SPEED);
    ok.in <== shifted;
}
