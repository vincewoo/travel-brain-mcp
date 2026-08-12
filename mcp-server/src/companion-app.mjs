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

/**
 * Whether a path names a file rather than a client-side route.
 *
 * The last segment carrying a dot is the whole test, and it is deliberately crude: every route this
 * app owns (`/app`, `/app/callback`) is a bare word, and every asset it serves is fingerprinted or
 * suffixed. Getting it wrong in the safe direction costs a 404 on a route nobody has; getting it
 * wrong the other way is what this exists to prevent.
 */
export function isFileRequest(pathname) {
  const last = pathname.split('/').pop() ?? '';
  return last.includes('.');
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
  app.get(/^\/app(\/.*)?$/, (req, res, next) => {
    // ...but only routes. A request for a file that is not there has to 404. Answering it with the
    // shell means a missing asset arrives as HTML under a 200, which the browser then fails to use
    // for whatever it asked for and the service worker happily caches — a missing map worker
    // presented as a working response, and a bug that stays invisible until someone reads a
    // console. A 404 says what happened at the moment it happens.
    if (isFileRequest(req.path)) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: directory });
  });

  console.info(`companion_app=served path=/app directory=${directory}`);
  return true;
}
