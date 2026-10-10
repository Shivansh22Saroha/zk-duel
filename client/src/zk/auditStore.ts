/**
 * Local persistence of unproven windows (Phase 3 follow-up): every window's private circuit
 * input is written to IndexedDB as soon as the window is frozen and deleted as soon as the server
 * decided it, so a page reload during the post-match audit loses nothing — the audit resumes on
 * the next page load (AuditResumer).
 *
 * This data never leaves the browser (it is the same private input the Proof Worker gets).
 * Every call is best-effort: when IndexedDB is unavailable (private mode, blocked storage) the
 * game still works, it just cannot resume an audit after a reload.
 */
import type { JobStore, StoredMatch } from './jobStore';
import type { WindowJob } from './recorder';

export type { JobStore, StoredMatch } from './jobStore';

interface StoredJob {
  key: string;
  matchId: string;
  job: WindowJob;
}

const DB_NAME = 'zkduel-audit';
const DB_VERSION = 1;
const jobKey = (matchId: string, r: number, k: number): string => `${matchId}:${r}:${k}`;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbAuditStore implements JobStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IndexedDbAuditStore | null> {
    try {
      if (typeof indexedDB === 'undefined') return null;
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('matches'))
          db.createObjectStore('matches', { keyPath: 'matchId' });
        if (!db.objectStoreNames.contains('jobs')) {
          db.createObjectStore('jobs', { keyPath: 'key' }).createIndex('matchId', 'matchId');
        }
      };
      return new IndexedDbAuditStore(await req(r));
    } catch {
      return null;
    }
  }

  private run(stores: string[], fn: (t: IDBTransaction) => void): Promise<void> {
    return new Promise((resolve) => {
      try {
        const t = this.db.transaction(stores, 'readwrite');
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
        t.onabort = () => resolve();
        fn(t);
      } catch {
        resolve();
      }
    });
  }

  putMatch(m: StoredMatch): void {
    void this.run(['matches'], (t) => t.objectStore('matches').put(m));
  }

  setAuditUntil(matchId: string, epochMs: number): void {
    void this.run(['matches'], (t) => {
      const s = t.objectStore('matches');
      const g = s.get(matchId);
      g.onsuccess = () => {
        const m = g.result as StoredMatch | undefined;
        if (m) s.put({ ...m, auditUntil: epochMs });
      };
    });
  }

  putJob(matchId: string, job: WindowJob): void {
    const row: StoredJob = { key: jobKey(matchId, job.roundNo, job.windowIndex), matchId, job };
    void this.run(['jobs'], (t) => t.objectStore('jobs').put(row));
  }

  deleteJob(matchId: string, roundNo: number, windowIndex: number): void {
    void this.run(['jobs'], (t) =>
      t.objectStore('jobs').delete(jobKey(matchId, roundNo, windowIndex)),
    );
  }

  deleteMatch(matchId: string): void {
    void this.run(['matches', 'jobs'], (t) => {
      t.objectStore('matches').delete(matchId);
      const idx = t.objectStore('jobs').index('matchId').openCursor(IDBKeyRange.only(matchId));
      idx.onsuccess = () => {
        const c = idx.result;
        if (c) {
          c.delete();
          c.continue();
        }
      };
    });
  }

  /** Writes are fire-and-forget; this resolves once everything queued so far is on disk. */
  flush(): Promise<void> {
    return this.run(['matches'], () => undefined);
  }

  /** The most recent match whose audit is still open and that still has stored windows. */
  async unfinishedAudit(
    nowEpoch: number,
  ): Promise<{ match: StoredMatch; jobs: WindowJob[] } | null> {
    try {
      const t = this.db.transaction(['matches', 'jobs'], 'readonly');
      const matches = (await req(t.objectStore('matches').getAll())) as StoredMatch[];
      const open = matches
        .filter((m) => m.auditUntil !== null && m.auditUntil > nowEpoch)
        .sort((a, b) => (b.auditUntil ?? 0) - (a.auditUntil ?? 0));
      // expired or never-ended matches are dead weight: drop them
      for (const m of matches) if (!open.includes(m)) this.deleteMatch(m.matchId);
      const m = open[0];
      if (!m) return null;
      const t2 = this.db.transaction(['jobs'], 'readonly');
      const rows = (await req(
        t2.objectStore('jobs').index('matchId').getAll(IDBKeyRange.only(m.matchId)),
      )) as StoredJob[];
      if (!rows.length) {
        this.deleteMatch(m.matchId);
        return null;
      }
      return { match: m, jobs: rows.map((r) => r.job) };
    } catch {
      return null;
    }
  }
}
