pragma circom 2.2.0;

include "util.circom";

// ARCHITECTURE §5.3 rule 2: arena bounds, angle range, boolean inputs — for one tick.
template BoundsCheck(ARENA_W, ARENA_H, R, ANGLES) {
    signal input x;
    signal input y;
    signal input angle;
    signal input fired;
    signal input reloadPress;

    component bx = InRange(nbits(ARENA_W), R, ARENA_W - R);
    bx.in <== x;
    component by = InRange(nbits(ARENA_H), R, ARENA_H - R);
    by.in <== y;
    component ba = InRange(nbits(ANGLES - 1), 0, ANGLES - 1);
    ba.in <== angle;

    fired * (fired - 1) === 0;
    reloadPress * (reloadPress - 1) === 0;
}
