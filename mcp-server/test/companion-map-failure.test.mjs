import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMapError,
  createTileWatch,
  MAX_ZOOM,
  SOURCE_MAX_ZOOM,
  STYLE_URL,
  TILE_FAILURE_LIMIT
} from '../ui/travel-companion/src/map-source.mjs';

// MapLibre reports a failed fetch as an ErrorEvent wrapping an AJAXError, which carries the URL it
// could not load. These are the three that matter, spelled out rather than mocked so the shapes
// stay visible.
const styleFailure = { error: { message: `AJAXError: Not Found (404): ${STYLE_URL}`, url: STYLE_URL } };
const tileFailure = {
  sourceId: 'openmaptiles',
  error: {
    message: 'AJAXError: Forbidden (403): https://tiles.openfreemap.org/planet/20260802_080001_pt/14/13211/7002.pbf',
    url: 'https://tiles.openfreemap.org/planet/20260802_080001_pt/14/13211/7002.pbf'
  }
};
const descriptorFailure = {
  sourceId: 'openmaptiles',
  error: { message: 'AJAXError: Forbidden (403): https://tiles.openfreemap.org/planet', url: 'https://tiles.openfreemap.org/planet' }
};
const glyphFailure = {
  error: { message: 'AJAXError: Not Found (404): https://tiles.openfreemap.org/fonts/Noto%20Sans/0-255.pbf' }
};

test('a tile failure is recognised, which the message-substring check it replaces could not be', () => {
  // The whole bug in one assertion: the previous rule asked whether the error message contained
  // "style". A tile is served from /planet/ and so never matched, which is why a blocked or
  // captive-portalled basemap left an empty rectangle instead of falling back to the schematic.
  assert.ok(!tileFailure.error.url.includes('style'), 'a tile URL must not contain the old sentinel');
  assert.equal(classifyMapError(tileFailure), 'tile');
});

test('a dead style is fatal, because nothing will ever render without it', () => {
  assert.equal(classifyMapError(styleFailure), 'fatal');
});

test("a source's own descriptor failing is fatal, since no tile will ever be requested", () => {
  assert.equal(classifyMapError(descriptorFailure), 'fatal');
});

test('a missing glyph is ignored, because labels degrade but the map still works', () => {
  assert.equal(classifyMapError(glyphFailure), 'ignore');
  assert.equal(classifyMapError(null), 'ignore');
  assert.equal(classifyMapError({}), 'ignore');
});

test('a map that never paints falls back once the tile failures add up', () => {
  const watch = createTileWatch();
  for (let attempt = 1; attempt < TILE_FAILURE_LIMIT; attempt += 1) {
    assert.equal(watch.errored(tileFailure), false, `gave up after ${attempt} of ${TILE_FAILURE_LIMIT}`);
  }
  assert.equal(watch.errored(tileFailure), true);
});

test('the fallback fires exactly once, so the panel is not told twice', () => {
  const watch = createTileWatch({ limit: 1 });
  assert.equal(watch.errored(tileFailure), true);
  assert.equal(watch.errored(tileFailure), false);
  assert.equal(watch.errored(styleFailure), false);
});

test('a map that has already painted keeps its tiles when one goes missing', () => {
  // Tearing down a working map over a single gap would be worse than the gap. Proving the network
  // works also clears the count, so a later stretch of failures starts from scratch.
  const watch = createTileWatch({ limit: 2 });
  assert.equal(watch.errored(tileFailure), false);
  watch.drew();
  for (let attempt = 0; attempt < TILE_FAILURE_LIMIT * 2; attempt += 1) {
    assert.equal(watch.errored(tileFailure), false);
  }
});

test('a dead style falls back immediately, painted or not', () => {
  const watch = createTileWatch();
  watch.drew();
  assert.equal(watch.errored(styleFailure), true);
});

test('the zoom ceiling stays close to the data, not to the library default', () => {
  // OpenFreeMap's planet tileset stops at z14 and MapLibre would otherwise allow z22, inviting
  // eight steps of zoom that can only enlarge what is already drawn. A little overzoom separates
  // clustered pins; a lot of it reads as a broken map, especially over mainland China where OSM
  // has roads and POIs but almost no building footprints to magnify.
  assert.equal(SOURCE_MAX_ZOOM, 14);
  assert.ok(MAX_ZOOM > SOURCE_MAX_ZOOM, 'some overzoom is useful for pulling pins apart');
  assert.ok(MAX_ZOOM <= SOURCE_MAX_ZOOM + 2, `${MAX_ZOOM} promises detail the source cannot supply`);
});
