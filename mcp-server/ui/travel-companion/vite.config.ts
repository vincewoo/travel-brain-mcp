import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * Ship MapLibre's worker, which the bundler cannot see.
 *
 * MapLibre builds the worker's URL at runtime rather than declaring it:
 *
 *   const file = import.meta.url.endsWith("-dev.mjs") ? "…-worker-dev.mjs" : "…-worker.mjs";
 *   return new URL(`./${file}`, import.meta.url).href;
 *
 * Because the filename is a computed string, Rollup never records a dependency on it and never
 * emits it. The request then lands on whatever the server does with an unknown path — and a URL
 * that resolves to something other than the worker is a map with no vector tiles at all, since
 * every tile is fetched and parsed in that worker. Everything else keeps working, which is what
 * makes the failure so quiet.
 *
 * Emitting both files beside the chunk that asks for them is what makes the runtime resolution
 * above land on the real thing. The worker imports `./maplibre-gl-shared.mjs` at that same path,
 * so it is not optional; a test asserts both survive the build.
 */
function maplibreWorkerAssets(): Plugin {
  return {
    name: "maplibre-worker-assets",
    apply: "build",
    generateBundle() {
      for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${file}`,
          source: readFileSync(require.resolve(`maplibre-gl/dist/${file}`), "utf8")
        });
      }
    }
  };
}

/**
 * The companion is served from `/app` on the MCP origin, so every asset URL has to carry that
 * prefix and the service worker's scope has to match it. Same origin is deliberate: no CORS, no
 * extra allowed origin on the server, and one place for the OAuth redirect to land.
 */
export default defineConfig({
  base: "/app/",
  plugins: [react(), maplibreWorkerAssets()],
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
