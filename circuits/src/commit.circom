pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

// ARCHITECTURE §5.3 rule 6: hidden-state commitment Poseidon4(ammo, cooldown, reloadT, salt).
template Commit() {
    signal input ammo;
    signal input cooldown;
    signal input reloadT;
    signal input salt;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== ammo;
    h.inputs[1] <== cooldown;
    h.inputs[2] <== reloadT;
    h.inputs[3] <== salt;
    out <== h.out;
}
