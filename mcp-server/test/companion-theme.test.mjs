import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * The appearance choice: shared palette, companion control.
 *
 * The dark palette exists twice in `ui/shared/travel-brain.css` — once for the system setting and
 * once for a traveller who has overridden it — because CSS cannot share a declaration block between
 * a media query and a selector. Nothing in a build catches the two drifting apart: a token added to
 * one and forgotten in the other renders a theme that is dark everywhere except the one component
 * nobody opened. These tests are that check.
 */

const sharedCss = () => readFile(new URL('../ui/shared/travel-brain.css', import.meta.url), 'utf8');

/** The declarations of the rule introduced by `selector`, as a token → value map. */
function declarations(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${selector} should exist in the shared stylesheet`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return Object.fromEntries(
    css.slice(open + 1, close)
      .split(';')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      })
  );
}

test('the system dark palette and the chosen dark palette are the same palette', async () => {
  const css = await sharedCss();
  const system = declarations(css, ':root:not([data-theme="light"])');
  const chosen = declarations(css, ':root[data-theme="dark"] {');
  assert.ok(Object.keys(system).length > 15, 'the dark palette should be the full token set');
  assert.deepEqual(chosen, system);
});

test('an explicit choice outranks the phone in both directions', async () => {
  const css = await sharedCss();
  // Dark on a light phone needs a rule with no media query around it; light on a dark phone needs
  // the media query to stand down. Losing either one turns the control into a no-op for half the
  // travellers who touch it, in a way that only shows up on a device set the other way.
  const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.match(media, /^@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.ok(
    css.includes('}\n\n:root[data-theme="dark"] {'),
    'the chosen dark palette must sit outside the media query'
  );
  // Told to the browser too, or the platform's own checkboxes and scrollbars stay light.
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
});

test('the companion applies a stored theme before the first paint', async () => {
  // In the built shell, not just in source: this is the one part of the feature that cannot live in
  // the app bundle, because by the time a module script runs the light palette has already painted.
  const html = await readFile(new URL('../ui/travel-companion/dist/index.html', import.meta.url), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inline, 'the shell should carry an inline boot script');
  assert.match(inline[1], /localStorage\.getItem\(["']travel-brain:theme["']\)/);
  assert.match(inline[1], /dataset\.theme/);
  // The bundle reads the same key, so a rename on one side is a preference that silently stops
  // being remembered.
  const entry = html.match(/<script[^>]+src="([^"]+\.js)"/);
  const bundle = await readFile(
    new URL(`../ui/travel-companion/dist/${entry[1].replace('/app/', '')}`, import.meta.url),
    'utf8'
  );
  assert.ok(bundle.includes('travel-brain:theme'), 'the app should read the same stored key');
});
