import { describe, expect, it } from 'vitest';
import { SALT_BITS } from './constants';
import { BN254_P } from './field';
import { initialCommit } from './poseidon';
import {
  initialCommitOf,
  namePublicSignals,
  randomSalt,
  sliceLogWindows,
  testSalt,
  toField,
} from './zkInput';

describe('zkInput', () => {
  it('random salts are always < 2^SALT_BITS < p (1000 samples)', () => {
    for (let i = 0; i < 1000; i++) {
      const s = BigInt(randomSalt());
      expect(s < 1n << BigInt(SALT_BITS)).toBe(true);
      expect(s < BN254_P).toBe(true);
    }
  });
  it('toField maps negative integers to p − |v|', () => {
    expect(toField(-1)).toBe((BN254_P - 1n).toString());
    expect(toField(5)).toBe('5');
    expect(toField(BN254_P)).toBe('0');
  });
  it('initialCommitOf equals the server initialCommit', async () => {
    expect(await initialCommitOf()).toBe(await initialCommit());
  });
  it('namePublicSignals follows the given order and rejects length mismatches', () => {
    expect(
      namePublicSignals(['commitOut', 'bind', 'digest', 'commitIn'], ['1', '2', '3', '4']),
    ).toEqual({
      commitOut: '1',
      bind: '2',
      digest: '3',
      commitIn: '4',
    });
    expect(() => namePublicSignals(['bind'], ['1', '2'])).toThrow();
  });
  it('sliceLogWindows rejects server logs and logs with missing ticks', () => {
    expect(() =>
      sliceLogWindows(
        [
          {
            type: 'header',
            version: 1,
            source: 'server',
            matchId: 'm',
            matchField: '1',
            windowTicks: 4,
            constantsHash: '',
            createdAt: 0,
          },
        ],
        4,
        testSalt(1),
      ),
    ).toThrow();
    const lines = [
      {
        type: 'header',
        version: 1,
        source: 'client',
        matchId: 'm',
        matchField: '1',
        playerIndex: 0,
        windowTicks: 4,
        constantsHash: '',
        createdAt: 0,
      },
      { type: 'round_start', roundNo: 1, prevSnapshot: [150, 300, 0, 0], initialCommit: 'x' },
      {
        type: 'tick',
        roundNo: 1,
        tick: 0,
        x: 150,
        y: 300,
        angle: 0,
        fired: 0,
        reloadPress: 0,
        ammo: 10,
        cooldown: 0,
        reloadTimer: 0,
      },
      {
        type: 'tick',
        roundNo: 1,
        tick: 2,
        x: 150,
        y: 300,
        angle: 0,
        fired: 0,
        reloadPress: 0,
        ammo: 10,
        cooldown: 0,
        reloadTimer: 0,
      },
      { type: 'round_end', roundNo: 1, endTick: 2, winnerIndex: 0 },
    ] as Parameters<typeof sliceLogWindows>[0];
    expect(() => sliceLogWindows(lines, 4, testSalt(1))).toThrow(/missing tick 1/);
  });
});
