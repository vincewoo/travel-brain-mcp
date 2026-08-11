import { existsSync } from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';

/**
 * Serve the offline companion PWA at `/app` on the MCP origin.
 *
 * Same origin as `/mcp` is a deliberate choice, not a convenience: it keeps the browser out of
 * CORS entirely, means no extra entry in `ALLOWED_ORIGINS`, gives the service worker a scope that
 * covers the app and nothing else, and gives the OAuth redirect a fixed place to land under the
 * Supabase Site URL that is already configured.
 *
 * The shell is public and unauthenticated, which is correct: it holds no secrets and no trip data.
 * Every byte of travel content still comes through an authenticated `/mcp` tool call made by the
 * browser with the traveller's own OAuth token, and the MCP transport remains the only boundary.
 */

const BUNDLED_DIRECTORY = fileURLToPath(new URL('../companion/', import.meta.url));
const REPOSITORY_DIRECTORY = fileURLToPath(new URL('../ui/travel-companion/dist/', import.meta.url));

export function companionDirectory(explicitPath) {
  for (const candidate of explicitPath ? [explicitPath] : [BUNDLED_DIRECTORY, REPOSITORY_DIRECTORY]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The worker is served from `/app/sw.js` and claims `/app/`; a worker may only control paths at or
 * below its own URL, so this file must not be moved to a hashed asset path.
 */
function staticHeaders(res, path) {
  if (path.endsWith('sw.js')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/app/');
    return;
  }
  // Vite fingerprints everything under assets/, so those are safe to keep for a year. The shell
  // and the manifest are revalidated so a deploy is picked up on the next online load.
  res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
}

export function installCompanionRoutes(app, options = {}) {
  const directory = companionDirectory(options.companionPath);
  if (!directory) {
    // A server without the built companion is a valid configuration — the MCP surface is
    // unaffected — so this reports rather than refuses to start.
    console.info('companion_app=absent path=/app reason=build_missing');
    return false;
  }

  app.use('/app', express.static(directory, { index: false, setHeaders: staticHeaders }));

  // Client-side routes, `/app/callback` above all: the OAuth redirect has to resolve to the shell
  // so the app can finish the token exchange.
  app.get(/^\/app(\/.*)?$/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: directory });
  });

  console.info(`companion_app=served path=/app directory=${directory}`);
  return true;
}
