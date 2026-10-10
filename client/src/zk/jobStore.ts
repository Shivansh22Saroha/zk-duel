/** DOM-free persistence interface for unproven windows (implemented by IndexedDbAuditStore). */
import type { WindowJob } from './recorder';

/** What ProofClient needs (DOM-free interface; the browser passes IndexedDbAuditStore). */
export interface JobStore {
  putMatch(m: StoredMatch): void;
  setAuditUntil(matchId: string, epochMs: number): void;
  putJob(matchId: string, job: WindowJob): void;
  deleteJob(matchId: string, roundNo: number, windowIndex: number): void;
  deleteMatch(matchId: string): void;
}

export interface StoredMatch {
  matchId: string;
  playerIndex: 0 | 1;
  scheme: 'groth16' | 'plonk';
  variant: string;
  windowTicks: number;
  /** Epoch ms until which the server accepts audit proofs; null while the match is live. */
  auditUntil: number | null;
}
