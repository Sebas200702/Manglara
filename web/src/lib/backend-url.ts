/**
 * Origin of the backend. Configurable via the Vite env var `VITE_BACKEND_URL`
 * so a single codebase can point at any backend (local, staging, prod).
 * Accepts:
 *   - a `ws://` / `wss://` origin  -> used as-is
 *   - an `http://` / `https://` origin -> mapped to `ws` / `wss`
 *   - a bare `host[:port]`         -> scheme derived from the page (wss on https)
 *   - omitted                      -> `localhost:8000` (local-dev default)
 * NOTE: `VITE_*` vars are inlined at build time, so set it before `vite build`
 * (or in the shell/`.env` before `bun run dev`).
 */
export function backendWsOrigin(): string {
  const configured = import.meta.env.VITE_BACKEND_URL?.trim();
  const pageProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (!configured) return `${pageProto}//localhost:8000`;
  if (/^wss?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  if (/^https:\/\//i.test(configured))
    return `wss://${configured.slice(8).replace(/\/+$/, "")}`;
  if (/^http:\/\//i.test(configured))
    return `ws://${configured.slice(7).replace(/\/+$/, "")}`;
  return `${pageProto}//${configured.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

/** Same backend as `backendWsOrigin`, for REST calls (`ws` -> `http`). */
export function backendHttpOrigin(): string {
  return backendWsOrigin().replace(/^ws(s?):\/\//i, "http$1://");
}
