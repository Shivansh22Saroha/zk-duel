pragma circom 2.2.0;

include "util.circom";

// ARCHITECTURE §5.3 rule 4: shortest-arc turn between consecutive angles <= MAX_TURN.
// `prev` and `cur` are angles in [0, ANGLES) (cur is range-checked by BoundsCheck; prev is the
// previous tick's checked angle or the public prev snapshot bound by the digest).
template TurnCheck(ANGLES, MAX_TURN) {
    signal input prev;
    signal input cur;

    var B = nbits(ANGLES - 1);

    // Witness helper: wrap indicator. The ONLY non-constraining assignment in this template;
    // it is pinned down by (1) k boolean and (2) turnD = cur − prev + ANGLES·k ∈ [0, ANGLES),
    // which has exactly one solution for k when cur, prev ∈ [0, ANGLES).
    signal k;
    k <-- (cur < prev) ? 1 : 0;
    k * (k - 1) === 0;

    signal turnD <== cur - prev + ANGLES * k;
    component range = InRange(B, 0, ANGLES - 1);
    range.in <== turnD;

    // min(turnD, ANGLES − turnD) <= MAX_TURN  ⇔  turnD <= MAX_TURN  or  turnD >= ANGLES − MAX_TURN
    // (the two cases are mutually exclusive, so exactly one comparator must be 1)
    component small = LessEqThan(B);
    small.in[0] <== turnD;
    small.in[1] <== MAX_TURN;
    component large = GreaterEqThan(B);
    large.in[0] <== turnD;
    large.in[1] <== ANGLES - MAX_TURN;
    small.out + large.out === 1;
}
