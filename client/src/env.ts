/** Client config (docs/ENVIRONMENT.md §2). Only VITE_* values exist here; none are secret. */
const env = import.meta.env;
const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
const flag = (v: string | undefined): boolean => v === 'true';

export const ENV = {
  API_URL: env.VITE_API_URL || `http://${host}:8080`,
  WS_URL: env.VITE_WS_URL || `ws://${host}:8080/ws`,
  ZK_BASE: env.VITE_ZK_BASE || '/zk',
  SHOW_DEBUG: flag(env.VITE_SHOW_DEBUG),
  LOG_TICKS: flag(env.VITE_LOG_TICKS),
} as const;
