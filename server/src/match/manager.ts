/** FIFO queue + room registry (FEATURES F2). Private rooms arrive in Phase 4. */
import { randomUUID } from 'node:crypto';
import type { Scheme } from '@zkduel/shared/constants';
import { matchField } from '@zkduel/shared/matchField';
import { initialCommit } from '@zkduel/shared/poseidon';
import type { Repo } from '../db/repo';
import { NULL_LOG, openSnapshotLog } from '../log/snapshotLog';
import type { VariantInfo } from '../zk/variant';
import type { Verifier } from '../zk/verifierPool';
import { MatchRoom, type PlayerLink } from './matchRoom';

export interface ManagerOptions {
  scheme: Scheme;
  windowTicks: number;
  defaultEnforcement: 'observe' | 'strict';
  logSnapshots: boolean;
  snapshotLogDir: string;
  constantsHash: string;
  proofGraceWindows: number;
  variant: VariantInfo;
  verifier: Verifier;
  proofDeadlineMs: number;
  auditTimeoutMs: number;
  storeProofs: boolean;
  now: () => number;
}

export class MatchManager {
  private readonly queue: string[] = [];
  /** Every room until its audit closes (live rooms and finished rooms still auditing). */
  readonly rooms = new Map<string, MatchRoom>();
  /** Player → the room they are playing in (removed at match_end). */
  private readonly byPlayer = new Map<string, MatchRoom>();
  private readonly pairing = new Set<string>();

  constructor(
    private readonly repo: Repo,
    private readonly linkOf: (playerId: string) => PlayerLink | null,
    private readonly opts: ManagerOptions,
  ) {}

  /** Matches being played (not counting finished matches whose audit is still open). */
  get liveCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.phase !== 'finished') n++;
    return n;
  }

  roomOf(playerId: string): MatchRoom | undefined {
    return this.byPlayer.get(playerId);
  }

  /** The player's room for match `matchId` — live, or finished with its audit still open. */
  roomFor(playerId: string, matchId: string): MatchRoom | undefined {
    const r = this.rooms.get(matchId);
    return r && r.indexOf(playerId) !== null ? r : undefined;
  }

  /**
   * Where a `window_commit` (which carries no matchId) goes: the live room, else the player's most
   * recent room still auditing (the final window is committed after round_end = match_end).
   */
  commitRoomOf(playerId: string): MatchRoom | undefined {
    const live = this.byPlayer.get(playerId);
    if (live) return live;
    let latest: MatchRoom | undefined;
    for (const r of this.rooms.values()) if (r.indexOf(playerId) !== null) latest = r;
    return latest;
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
    for (const room of this.rooms.values()) {
      const p = room.indexOf(playerId);
      if (p !== null) room.onDisconnect(p);
    }
  }

  /** A `hello` from a player: re-attach their socket to every room they are seated in. */
  onReconnect(playerId: string, link: PlayerLink): void {
    for (const room of this.rooms.values()) {
      const p = room.indexOf(playerId);
      if (p !== null) room.onReconnect(p, link);
    }
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
      circuitHash: this.opts.variant.zkeySha256,
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
        proofGraceWindows: this.opts.proofGraceWindows,
        variant: this.opts.variant,
        proofDeadlineMs: this.opts.proofDeadlineMs,
        auditTimeoutMs: this.opts.auditTimeoutMs,
        storeProofs: this.opts.storeProofs,
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
        verifier: this.opts.verifier,
        now: this.opts.now,
        onMatchEnded: (r) => this.freePlayers(r),
        onFinished: (r) => this.removeRoom(r),
      },
    );
    this.rooms.set(id, room);
    for (const p of players) this.byPlayer.set(p, room);
    room.start();
    return room;
  }

  private freePlayers(room: MatchRoom): void {
    for (const s of room.seats) {
      if (this.byPlayer.get(s.playerId) === room) this.byPlayer.delete(s.playerId);
    }
  }

  private removeRoom(room: MatchRoom): void {
    this.freePlayers(room);
    this.rooms.delete(room.id);
  }
}
