pragma circom 2.2.0;

include "src/bind.circom";
include "src/bounds.circom";
include "src/commit.circom";
include "src/digest.circom";
include "src/speed.circom";
include "src/turn.circom";
include "src/weapon.circom";

// One proof window of N ticks (ARCHITECTURE §5). All numbers are template parameters,
// injected from shared/constants.ts by circuits/scripts/gen-main.ts (main_<N>.circom).
//
// Public inputs:  bind, digest, commitIn        Public output: commitOut
// Everything else is private.
template Window(N, ARENA_W, ARENA_H, R, MAX_SPEED, ANGLES, MAX_TURN, MAG, COOLDOWN, RELOAD) {
    // ---- public
    signal input bind;
    signal input digest;
    signal input commitIn;
    signal output commitOut;

    // ---- private: identity (re-hashed into bind)
    signal input matchField;
    signal input playerIndex;
    signal input roundNo;
    signal input windowIndex;

    // ---- private: public snapshots (bound by digest) and per-tick reload input
    signal input prev[4];          // last public snapshot before the window {x, y, angle, fired}
    signal input x[N];
    signal input y[N];
    signal input angle[N];
    signal input fired[N];
    signal input reloadPress[N];

    // ---- private: hidden state (entering the window, then after each tick) and salts
    signal input ammo0;
    signal input cooldown0;
    signal input reload0;
    signal input saltIn;
    signal input ammo[N];
    signal input cooldown[N];
    signal input reloadT[N];
    signal input saltOut;

    // 1. bind
    component b = Bind();
    b.matchField <== matchField;
    b.playerIndex <== playerIndex;
    b.roundNo <== roundNo;
    b.windowIndex <== windowIndex;
    b.out === bind;

    // 2. digest over the public snapshots
    component d = DigestChain(N);
    d.prev <== prev;
    d.x <== x;
    d.y <== y;
    d.angle <== angle;
    d.fired <== fired;
    d.digest === digest;

    // 3. hidden state entering the window matches the previous commitment
    component cin = Commit();
    cin.ammo <== ammo0;
    cin.cooldown <== cooldown0;
    cin.reloadT <== reload0;
    cin.salt <== saltIn;
    cin.out === commitIn;

    // 4. per-tick rules
    component bounds[N];
    component speedX[N];
    component speedY[N];
    component turn[N];
    component weapon[N];
    for (var i = 0; i < N; i++) {
        bounds[i] = BoundsCheck(ARENA_W, ARENA_H, R, ANGLES);
        bounds[i].x <== x[i];
        bounds[i].y <== y[i];
        bounds[i].angle <== angle[i];
        bounds[i].fired <== fired[i];
        bounds[i].reloadPress <== reloadPress[i];

        speedX[i] = SpeedCheck(MAX_SPEED);
        speedX[i].prev <== i == 0 ? prev[0] : x[i - 1];
        speedX[i].cur <== x[i];
        speedY[i] = SpeedCheck(MAX_SPEED);
        speedY[i].prev <== i == 0 ? prev[1] : y[i - 1];
        speedY[i].cur <== y[i];

        turn[i] = TurnCheck(ANGLES, MAX_TURN);
        turn[i].prev <== i == 0 ? prev[2] : angle[i - 1];
        turn[i].cur <== angle[i];

        weapon[i] = WeaponStep(MAG, COOLDOWN, RELOAD);
        weapon[i].ammo <== i == 0 ? ammo0 : ammo[i - 1];
        weapon[i].cooldown <== i == 0 ? cooldown0 : cooldown[i - 1];
        weapon[i].reloadT <== i == 0 ? reload0 : reloadT[i - 1];
        weapon[i].fired <== fired[i];
        weapon[i].reloadPress <== reloadPress[i];
        weapon[i].ammoNext <== ammo[i];
        weapon[i].cooldownNext <== cooldown[i];
        weapon[i].reloadTNext <== reloadT[i];
    }

    // 5. commitment to the hidden state leaving the window
    component cout = Commit();
    cout.ammo <== ammo[N - 1];
    cout.cooldown <== cooldown[N - 1];
    cout.reloadT <== reloadT[N - 1];
    cout.salt <== saltOut;
    commitOut <== cout.out;
}
