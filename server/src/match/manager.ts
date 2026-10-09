/** FIFO queue + room registry (FEATURES F2). Private rooms arrive in Phase 4. */
import { randomUUID } from 'node:crypto';
import type { Scheme } from '@zkduel/shared/constants';
import { matchField } from '@zkduel/shared/matchField';
import { initialCommit } from '@zkduel/shared/poseidon';
import type { Repo } from '../db/repo';
import { NULL_LOG, openSnapshotLog } from '../log/snapshotLog';
import { MatchRoom, type PlayerLink } from './matchRoom';

export interface ManagerOptions {
  scheme: Scheme;
  windowTicks: number;
  defaultEnforcement: 'observe' | 'strict';
  logSnapshots: boolean;
  snapshotLogDir: string;
  constantsHash: string;
  now: () => number;
}

/** Phase 1: no proving key exists yet, so matches record this placeholder circuit hash. */
export const NO_CIRCUIT_HASH = 'none';

export class MatchManager {
  private readonly queue: string[] = [];
  readonly rooms = new Map<string, MatchRoom>();
  private readonly byPlayer = new Map<string, MatchRoom>();
  private readonly pairing = new Set<string>();

  constructor(
    private readonly repo: Repo,
    private readonly linkOf: (playerId: string) => PlayerLink | null,
    private readonly opts: ManagerOptions,
  ) {}

  roomOf(playerId: string): MatchRoom | undefined {
    return this.byPlayer.get(playerId);
  }

  isBusy(playerId: string): boolean {
    return this.byPlayer.has(playerId) || this.pairing.has(playerId);
  }

  /** Returns false if the player is already in a match (→ ALREADY_IN_MATCH). */
  joinQueue(playerId: string): boolean {
    if (this.isBusy(playerId)) return false;
    if (!this.queue.includes(playerId)) this.queue.push(playerId);
    this.linkOf(playerId)?.send({ t: 'queued', position: this.queue.indexOf(playerId) + 1 });
    void this.tryPair();
    return true;
  }

  leaveQueue(playerId: string): void {
    const i = this.queue.indexOf(playerId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  onDisconnect(playerId: string): void {
    this.leaveQueue(playerId);
    const room = this.byPlayer.get(playerId);
    const p = room?.indexOf(playerId);
    if (room && p !== null && p !== undefined) room.onDisconnect(p);
  }

  /** Called at 60 Hz by the fixed-step loop. */
  tick(): void {
    for (const room of this.rooms.values()) room.onWall();
  }

  private async tryPair(): Promise<void> {
    while (this.queue.length >= 2) {
      const a = this.queue.shift() as string;
      const b = this.queue.shift() as string;
      this.pairing.add(a);
      this.pairing.add(b);
      try {
        await this.createRoom([a, b]);
      } finally {
        this.pairing.delete(a);
        this.pairing.delete(b);
      }
    }
  }

  private async createRoom(players: [string, string]): Promise<MatchRoom> {
    const id = randomUUID();
    const [mf, commit] = await Promise.all([matchField(id), initialCommit()]);
    const names = players.map((p) => this.repo.getPlayer(p)?.displayName ?? '???') as [
      string,
      string,
    ];
    this.repo.createMatch({
      id,
      matchField: mf,
      mode: 'queue',
      enforcement: this.opts.defaultEnforcement,
      scheme: this.opts.scheme,
      windowTicks: this.opts.windowTicks,
      circuitHash: NO_CIRCUIT_HASH,
      roomCode: null,
      players,
    });
    const room = new MatchRoom(
      {
        id,
        matchField: mf,
        initialCommit: commit,
        mode: 'queue',
        enforcement: this.opts.defaultEnforcement,
        scheme: this.opts.scheme,
        windowTicks: this.opts.windowTicks,
        constantsHash: this.opts.constantsHash,
      },
      [0, 1].map((i) => {
        const pid = players[i] as string;
        const link = this.linkOf(pid);
        return {
          playerId: pid,
          displayName: names[i] as string,
          link,
          ready: false,
          disconnectedAt: link ? null : this.opts.now(),
        };
      }) as MatchRoom['seats'],
      {
        repo: this.repo,
        log: this.opts.logSnapshots ? openSnapshotLog(this.opts.snapshotLogDir, id) : NULL_LOG,
        now: this.opts.now,
        onFinished: (r) => this.removeRoom(r),
      },
    );
    this.rooms.set(id, room);
    for (const p of players) this.byPlayer.set(p, room);
    room.start();
    return room;
  }

  private removeRoom(room: MatchRoom): void {
    this.rooms.delete(room.id);
    for (const s of room.seats) {
      if (this.byPlayer.get(s.playerId) === room) this.byPlayer.delete(s.playerId);
    }
  }
}
