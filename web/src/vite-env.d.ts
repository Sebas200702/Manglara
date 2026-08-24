/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the voice backend the frontend connects to over WebSocket.
   * Accepts an http(s):// or ws(s):// origin, or a bare `host[:port]`. Omit for
   * local dev (defaults to localhost:8000). Inlined at build time (Vite VITE_*
   * convention), so set it before `vite build`.
   */
  readonly VITE_BACKEND_URL?: string;
  /**
   * URL of the avatar GLB. Defaults to `/MANGLARIASK.glb` (served from the
   * app). Set to an absolute CDN URL to host the model off the deploy (e.g. when
   * the GLB is not committed to the repo). Inlined at build time.
   */
  readonly VITE_AVATAR_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
