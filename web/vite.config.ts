import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Dev-server WebSocket proxy target. Mirrors the client's VITE_BACKEND_URL
  // (see web/src/lib/voice-client.ts) so `bun run dev` can forward `/ws` to any
  // backend; defaults to the local backend. The deployed client connects
  // directly to VITE_BACKEND_URL, so this only affects the dev server.
  const env = loadEnv(mode, process.cwd(), "");
  const backend = (env.VITE_BACKEND_URL || "ws://localhost:8000").trim();
  const wsTarget = /^wss?:\/\//i.test(backend)
    ? backend
    : backend
        .replace(/^https:\/\//i, "wss://")
        .replace(/^http:\/\//i, "ws://")
        .replace(/^(?!wss?:\/\/)/i, "ws://");

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // TalkingHead imports `three/addons/...`, which only exists via importmap
        // in the browser. Map it to three's npm `examples/jsm` for bundling.
        { find: /^three\/addons\//, replacement: "three/examples/jsm/" },
      ],
    },
    optimizeDeps: {
      // TalkingHead loads its AudioWorklet via `new URL('./playback-worklet.js',
      // import.meta.url)`. esbuild pre-bundling rewrites import.meta.url into
      // .vite/deps, which breaks that asset resolution (worklet 404 →
      // "Failed to initialize streaming speech"). Serve it from node_modules.
      // `three` must be excluded too: the excluded talkinghead imports the raw
      // node_modules copy while app code would get the pre-bundled one — two
      // THREE instances in dev (avatar-controller shares textures with it).
      exclude: ["@met4citizen/talkinghead", "three"],
    },
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      proxy: {
        "/ws": {
          target: wsTarget.replace(/\/+$/, ""),
          ws: true,
        },
      },
    },
  };
});
