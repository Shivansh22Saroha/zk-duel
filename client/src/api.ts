/** REST client + guest session storage (FEATURES F1: token in sessionStorage). */
import { ENV } from './env';
import type { VariantMeta } from './zk/artefacts';
import type { ServerWindowRow } from './zk/auditResumer';

const TOKEN_KEY = 'zkd.token';
const NAME_KEY = 'zkd.name';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${ENV.API_URL}${path}`, { ...init, headers });
  if (r.status === 204) return undefined as T;
  const body = (await r.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!r.ok)
    throw new ApiError(
      r.status,
      body.error?.code ?? 'INTERNAL',
      body.error?.message ?? r.statusText,
    );
  return body as T;
}

export interface CircuitInfo {
  active: string;
  variants: VariantMeta[];
  constants: Record<string, unknown>;
  constantsHash: string;
}

export interface MatchSummary {
  id: string;
  status: string;
  winnerIndex: number | null;
  endReason: string | null;
  windowTicks: number;
  totalTicks: number;
  auditStatus: 'auditing' | 'audited_clean' | 'audited_failed' | 'audit_incomplete' | null;
  overturned: boolean;
  you: number | null;
  players: {
    playerIndex: number;
    displayName: string;
    roundsWon: number;
    hits: number;
    shots: number;
    windows: number;
    windowsCommitted: number;
    challenges: number;
    challengesPassed: number;
    challengeRate: number | null;
    detectionLatencyWindows: number | null;
    auditMs: number | null;
    auditStatus: 'audited_clean' | 'audited_failed' | 'audit_incomplete' | null;
    proofs: {
      byStatus: Record<string, number>;
      failed: number;
      proveMsMean: number | null;
      proveMsP95: number | null;
      verifyMsMean: number | null;
    };
  }[];
  rounds: {
    roundNo: number;
    startTick: number;
    endTick: number | null;
    winnerIndex: number | null;
  }[];
}

export const api = {
  circuitInfo: () => call<CircuitInfo>('/api/circuit/info'),
  guest: (displayName: string) =>
    call<{ token: string; player: { id: string; displayName: string } }>('/api/auth/guest', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }),
  match: (id: string, token: string) =>
    call<MatchSummary>(`/api/matches/${encodeURIComponent(id)}`, {}, token),
  windows: (id: string, token: string) =>
    call<{ windows: ServerWindowRow[] }>(
      `/api/matches/${encodeURIComponent(id)}/windows`,
      {},
      token,
    ),
};

export const session = {
  get token(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  },
  get name(): string | null {
    return sessionStorage.getItem(NAME_KEY);
  },
  save(token: string, name: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(NAME_KEY, name);
  },
  clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
  },
};
