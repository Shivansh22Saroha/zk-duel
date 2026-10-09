pragma circom 2.2.0;

include "circomlib/circuits/comparators.circom";

// ARCHITECTURE §3 weapon transition table W1–W5 (and shared/sim.ts `stepWeapon`), exactly.
//   (ammo, cooldown, reloadT)          state after the previous tick
//   fired, reloadPress                 this tick's inputs (booleans, enforced by BoundsCheck)
//   (ammoNext, cooldownNext, reloadTNext) claimed state after this tick — constrained here
//
//   W1 fired=1 (needs ammo>0, cooldown=0, reloadT=0): ammo−1, COOLDOWN−1, 0      (press ignored)
//   W2 fired=0, reloadT>1:                             ammo,   max(cd−1,0), reloadT−1
//   W3 fired=0, reloadT=1:                             MAG,    max(cd−1,0), 0
//   W4 fired=0, reloadT=0, press, ammo<MAG:            ammo,   max(cd−1,0), RELOAD
//   W5 otherwise:                                      ammo,   max(cd−1,0), 0
//
// "ammo < MAG" is implemented as "ammo != MAG": identical on reachable states, because ammo
// starts at MAG (public initialCommit) and every row keeps it in [0, MAG].
template WeaponStep(MAG, COOLDOWN, RELOAD) {
    signal input ammo;
    signal input cooldown;
    signal input reloadT;
    signal input fired;
    signal input reloadPress;
    signal input ammoNext;
    signal input cooldownNext;
    signal input reloadTNext;

    component ammoZero = IsZero();
    ammoZero.in <== ammo;
    component cdZero = IsZero();
    cdZero.in <== cooldown;
    component rtZero = IsZero();
    rtZero.in <== reloadT;
    component rtOne = IsEqual();
    rtOne.in[0] <== reloadT;
    rtOne.in[1] <== 1;
    component magFull = IsEqual();
    magFull.in[0] <== ammo;
    magFull.in[1] <== MAG;

    // W1 legality
    fired * ammoZero.out === 0;
    fired * (1 - cdZero.out) === 0;
    fired * (1 - rtZero.out) === 0;

    // cooldown' = fired ? COOLDOWN − 1 : max(cooldown − 1, 0)
    signal cdDec <== cooldown - 1 + cdZero.out;
    cooldownNext === cdDec + fired * (COOLDOWN - 1 - cdDec);

    // reloadT' when not fired: W2 → reloadT − 1, W4 → RELOAD, W3/W5 → 0; when fired → 0
    signal rtAbove1 <== 1 - rtZero.out - rtOne.out;
    signal pressNotFull <== reloadPress * (1 - magFull.out);
    signal startReload <== rtZero.out * pressNotFull;
    signal rtIfIdle <== rtAbove1 * (reloadT - 1) + startReload * RELOAD;
    reloadTNext === rtIfIdle - fired * rtIfIdle;

    // ammo' when not fired: W3 → MAG, else unchanged; when fired → ammo − 1
    signal ammoIfIdle <== rtOne.out * (MAG - ammo) + ammo;
    ammoNext === ammoIfIdle + fired * (ammo - 1 - ammoIfIdle);
}
