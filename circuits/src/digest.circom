pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

// ARCHITECTURE §5.3 rule 1: Poseidon chain over the window's public snapshots, seeded with the
// last public snapshot before the window:  h[-1] = Poseidon4(prev),
// h[i] = Poseidon5(h[i−1], x[i], y[i], angle[i], fired[i]),  digest = h[N−1].
template DigestChain(N) {
    signal input prev[4];
    signal input x[N];
    signal input y[N];
    signal input angle[N];
    signal input fired[N];
    signal output digest;

    component seed = Poseidon(4);
    seed.inputs <== prev;

    component step[N];
    signal acc[N + 1];
    acc[0] <== seed.out;
    for (var i = 0; i < N; i++) {
        step[i] = Poseidon(5);
        step[i].inputs[0] <== acc[i];
        step[i].inputs[1] <== x[i];
        step[i].inputs[2] <== y[i];
        step[i].inputs[3] <== angle[i];
        step[i].inputs[4] <== fired[i];
        acc[i + 1] <== step[i].out;
    }
    digest <== acc[N];
}
