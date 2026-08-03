import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
