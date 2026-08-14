/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the voice backend the frontend connects to over WebSocket.
   * Accepts an http(s):// or ws(s):// origin, or a bare `host[:port]`. Omit for
   * local dev (defaults to localhost:8000). Inlined at build time (Vite VITE_*
   * convention), so set it before `vite build`.
   */
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
