/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_ZK_BASE?: string;
  readonly VITE_DEV_CHEATS?: string;
  readonly VITE_SHOW_DEBUG?: string;
  readonly VITE_LOG_TICKS?: string;
}
