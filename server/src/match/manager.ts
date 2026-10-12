/** FIFO queue (FEATURES F2), private rooms by code (F3) and the registry of running matches. */
import { randomInt, randomUUID } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EXPIRY_MS,
  type Scheme,
} from '@zkduel/shared/constants';
import { matchField } from '@zkduel/shared/matchField';
import { initialCommit } from '@zkduel/shared/poseidon';
import type { Repo } from '../db/repo';
import { NULL_LOG, openSnapshotLog } from '../log/snapshotLog';
import type { GapFillLogger } from './matchRoom';
import type { VariantInfo } from '../zk/variant';
import type { Verifier } from '../zk/verifierPool';
import { MatchRoom, type PlayerLink } from './matchRoom';

export interface ManagerOptions {
  scheme: Scheme;
  windowTicks: number;
  defaultEnforcement: 'observe' | 'strict';
  logSnapshots: boolean;
  /** Server log for digest gap-fills (public tick numbers only). */
  logger?: GapFillLogger;
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

/** A private room waiting for its two players (the creator joins with room_join too). */
interface PrivateRoom {
  code: string;
  creator: string;
  enforcement: 'observe' | 'strict';
  createdAt: number;
  expiresAt: number;
  /** Players who sent room_join (creator first or second). */
  joined: string[];
}

export type RoomJoinResult = 'ok' | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ALREADY_IN_MATCH';

export class MatchManager {
  private readonly queue: string[] = [];
  private readonly privateRooms = new Map<string, PrivateRoom>();
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
    const now = Date.now();
    for (const [code, r] of this.privateRooms)
      if (now >= r.expiresAt) this.privateRooms.delete(code);
  }

  /** POST /api/rooms: a fresh 6-character code (no 0/O/1/I), unused rooms expire after 10 min. */
  createPrivateRoom(
    creator: string,
    enforcement: 'observe' | 'strict',
  ): { roomCode: string; expiresAt: number } | null {
    if (this.isBusy(creator)) return null;
    let code = '';
    do {
      code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
      ).join('');
    } while (this.privateRooms.has(code));
    const now = Date.now();
    this.privateRooms.set(code, {
      code,
      creator,
      enforcement,
      createdAt: now,
      expiresAt: now + ROOM_EXPIRY_MS,
      joined: [],
    });
    return { roomCode: code, expiresAt: now + ROOM_EXPIRY_MS };
  }

  /**
   * WS room_join (both players). One seat is reserved for the creator, so two other players can
   * never take the room over. When both are in, the private match starts with the room's enforcement.
   */
  joinPrivateRoom(playerId: string, code: string): RoomJoinResult {
    const r = this.privateRooms.get(code);
    if (!r || Date.now() >= r.expiresAt) return 'ROOM_NOT_FOUND';
    if (r.joined.includes(playerId)) return 'ok';
    if (this.isBusy(playerId)) return 'ALREADY_IN_MATCH';
    const others = r.joined.filter((p) => p !== r.creator).length;
    if (r.joined.length >= 2 || (playerId !== r.creator && others >= 1)) return 'ROOM_FULL';
    this.leaveQueue(playerId);
    r.joined.push(playerId);
    if (r.joined.length === 2) {
      this.privateRooms.delete(code);
      const players = [r.creator, r.joined.find((p) => p !== r.creator) as string] as [
        string,
        string,
      ];
      for (const p of players) this.pairing.add(p);
      void this.createRoom(players, {
        mode: 'private',
        enforcement: r.enforcement,
        roomCode: code,
      }).finally(() => players.forEach((p) => this.pairing.delete(p)));
    }
    return 'ok';
  }

  private async tryPair(): Promise<void> {
    while (this.queue.length >= 2) {
      const a = this.queue.shift() as string;
      const b = this.queue.shift() as string;
      this.pairing.add(a);
      this.pairing.add(b);
      try {
        await this.createRoom([a, b], {
          mode: 'queue',
          enforcement: this.opts.defaultEnforcement,
          roomCode: null,
        });
      } finally {
        this.pairing.delete(a);
        this.pairing.delete(b);
      }
    }
  }

  private async createRoom(
    players: [string, string],
    how: { mode: 'queue' | 'private'; enforcement: 'observe' | 'strict'; roomCode: string | null },
  ): Promise<MatchRoom> {
    const id = randomUUID();
    const [mf, commit] = await Promise.all([matchField(id), initialCommit()]);
    const names = players.map((p) => this.repo.getPlayer(p)?.displayName ?? '???') as [
      string,
      string,
    ];
    this.repo.createMatch({
      id,
      matchField: mf,
      mode: how.mode,
      enforcement: how.enforcement,
      scheme: this.opts.scheme,
      windowTicks: this.opts.windowTicks,
      circuitHash: this.opts.variant.zkeySha256,
      roomCode: how.roomCode,
      players,
    });
    const room = new MatchRoom(
      {
        id,
        matchField: mf,
        initialCommit: commit,
        mode: how.mode,
        enforcement: how.enforcement,
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
        ...(this.opts.logger ? { logger: this.opts.logger } : {}),
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
