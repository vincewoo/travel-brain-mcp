import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { companionDirectory, installCompanionRoutes } from '../src/companion-app.mjs';

const distDirectory = fileURLToPath(new URL('../ui/travel-companion/dist/', import.meta.url));

test('the built companion is discovered in the repository layout', () => {
  assert.equal(companionDirectory(), distDirectory);
});

test('a server without a companion build still starts, serving no /app route', () => {
  const routes = [];
  const app = {
    use: (path) => routes.push(path),
    get: (path) => routes.push(path)
  };
  const served = installCompanionRoutes(app, { companionPath: '/nonexistent/companion' });
  assert.equal(served, false);
  assert.deepEqual(routes, []);
});

test('the companion shell references only same-origin assets under /app', async () => {
  const html = await readFile(new URL('../ui/travel-companion/dist/index.html', import.meta.url), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith('/app/'), `${url} is not served from the companion scope`);
  }
});

test('the service worker leaves /mcp and every non-GET request to the network', async () => {
  const worker = await readFile(new URL('../ui/travel-companion/dist/sw.js', import.meta.url), 'utf8');
  // A worker that replayed a cached /mcp response would show a stale itinerary as though it were
  // live. Caching is confined to this app's own GETs, and the app owns trip data in IndexedDB.
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.ok(!worker.includes('"/mcp"'), 'the worker must not reference the MCP endpoint');
});

test('the manifest installs to the home screen at the companion scope', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../ui/travel-companion/dist/manifest.webmanifest', import.meta.url), 'utf8')
  );
  assert.equal(manifest.scope, '/app/');
  assert.equal(manifest.start_url, '/app/');
  // Installation is load-bearing rather than cosmetic: iOS evicts IndexedDB for a site left in a
  // browser tab and unused for a week, which would silently empty the offline cache.
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});
