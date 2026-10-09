pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

// ARCHITECTURE §5.2: bind = Poseidon4(matchField, playerIndex, roundNo, windowIndex).
// Ties a proof to one match, player slot, round and window (replay protection, SECURITY A2).
template Bind() {
    signal input matchField;
    signal input playerIndex;
    signal input roundNo;
    signal input windowIndex;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== matchField;
    h.inputs[1] <== playerIndex;
    h.inputs[2] <== roundNo;
    h.inputs[3] <== windowIndex;
    out <== h.out;
}
