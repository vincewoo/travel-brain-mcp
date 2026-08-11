import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The companion is served from `/app` on the MCP origin, so every asset URL has to carry that
 * prefix and the service worker's scope has to match it. Same origin is deliberate: no CORS, no
 * extra allowed origin on the server, and one place for the OAuth redirect to land.
 */
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  // The app imports `ui/shared` and the server's `src/trip-clock.mjs` by relative path, both of
  // which sit above this project. `vite build` resolves them either way; the dev server refuses to
  // serve anything outside its allow list, so the repository root goes on it.
  server: { fs: { allow: ["../../.."] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The shell is precached by the service worker, so keep it in a handful of long-lived files
    // rather than a wide graph of chunks a flaky connection has to fetch one by one.
    rollupOptions: { output: { manualChunks: undefined } }
  }
});
