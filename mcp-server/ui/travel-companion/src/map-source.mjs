/**
 * What this app knows about its basemap.
 *
 * It lives outside `TileMap` on purpose: that module is the lazily loaded chunk that carries
 * MapLibre, and none of the facts below need the library to be true. Reading the style URL or the
 * zoom ceiling should not cost a traveller a megabyte on hotel wifi.
 *
 * Two of the exports describe the tile source rather than the map widget — where the style comes
 * from, and how far it can honestly be zoomed. The rest is how to tell a basemap that has failed
 * from one that has merely lost a tile.
 */

/** The Liberty style already labels in `name:latin` + `name:nonlatin`, so Chinese place names come
 *  through beside the Latin ones without a style override — exactly what `address_local` exists
 *  for, on the map instead of in a row. */
export const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/** OpenFreeMap's planet tileset declares `maxzoom: 14` in its TileJSON. Past that MapLibre rescales
 *  the z14 tile instead of fetching a sharper one: everything gets bigger, nothing gets finer. */
export const SOURCE_MAX_ZOOM = 14;

/**
 * How far the map lets a traveller pinch.
 *
 * MapLibre defaults to 22, which offers eight steps of zoom beyond the point where any new detail
 * can arrive. That is a thin promise anywhere and a misleading one over mainland China, where OSM
 * carries roads and points of interest but almost no building footprints — a z14 tile of central
 * Guilin holds four buildings against Hong Kong's 176. There the extra zoom magnifies empty
 * background, so a map that is merely sparse reads as a map that is broken. Two steps of overzoom
 * still earn their place pulling apart a cluster of pins; past that the gesture only lies.
 */
export const MAX_ZOOM = SOURCE_MAX_ZOOM + 2;

/** How many tile requests may fail before a map that has never drawn anything gives up. */
export const TILE_FAILURE_LIMIT = 4;

/**
 * How long a basemap may show nothing before the schematic takes over.
 *
 * Counting errors is not enough on its own. MapLibre fetches and parses vector tiles inside a web
 * worker, and a worker that never starts makes no requests and raises no `error` event — the map
 * simply sits there, painting whatever the main thread already had (the style's background, and any
 * raster layer) while the data that matters never arrives. Nothing in an error-driven rule ever
 * fires. A deadline catches that whole class without needing to know what went wrong.
 *
 * Long enough not to punish a slow connection that is still working, short enough that a traveller
 * checking where they are does not sit looking at an empty rectangle.
 */
export const BASEMAP_TIMEOUT_MS = 12_000;

/** `/{z}/{x}/{y}.pbf` and friends — the shape of a tile request, as opposed to the descriptor that
 *  lists them or the glyphs that label them. */
const TILE_PATH = /\/\d+\/\d+\/\d+\.(?:pbf|mvt|png|jpe?g|webp)(?:\?|$)/;

function urlOf(error) {
  if (!error) return "";
  // MapLibre's AJAXError carries the URL directly; anything else only mentions it in the message.
  if (typeof error.url === "string") return error.url;
  return typeof error.message === "string" ? error.message : "";
}

/**
 * What a MapLibre `error` event means for the basemap.
 *
 * - `fatal` — the style, or a source's own descriptor, did not load. Nothing will ever render.
 * - `tile` — a single tile request failed. Harmless on its own, decisive in bulk.
 * - `ignore` — a glyph or a sprite. Labels or icons degrade; the map still works.
 *
 * This replaces a check that asked whether the error message contained the word "style". That was
 * right only by accident: the style URL contains `/styles/`, so a failed style matched, and a
 * failed tile — served from `/planet/` — never did. Tile failures are the common case (a captive
 * portal, a blocked host, a radio that dropped mid-pan), and they were precisely the ones that
 * silently left an empty rectangle instead of falling back to the schematic.
 */
export function classifyMapError(event) {
  const error = event?.error;
  if (!error) return "ignore";
  const url = urlOf(error);
  if (url.includes(STYLE_URL)) return "fatal";
  // An error tagged with a source is about the basemap data. If it names a tile it is one tile; if
  // it does not, the source descriptor itself failed and no tile will ever be requested.
  if (event.sourceId) return TILE_PATH.test(url) ? "tile" : "fatal";
  if (TILE_PATH.test(url)) return "tile";
  return "ignore";
}

/**
 * Tracks whether the basemap is worth waiting for.
 *
 * The asymmetry is deliberate. A map that has already painted has proved the network works, so a
 * later missing tile is cosmetic and tearing the map down over it would be worse than the gap. A
 * map that has never painted is proving the opposite, and after a few failures the schematic is
 * the more useful thing to be looking at.
 *
 * `errored` returns true exactly once, so the caller can treat it as the moment to fall back.
 */
export function createTileWatch({ limit = TILE_FAILURE_LIMIT } = {}) {
  let painted = false;
  let failures = 0;
  let settled = false;
  return {
    /**
     * A tile arrived: the basemap works, and any earlier stumbles no longer count against it.
     *
     * Only ever call this for the source that carries the map's actual content. A raster backdrop
     * painting while the vector data fails is precisely the state this whole module exists to
     * notice, and treating it as success would grant immunity to the failure being watched for.
     */
    drew() {
      painted = true;
      failures = 0;
    },
    /** Whether anything has drawn yet, for the caller's deadline. */
    hasPainted() {
      return painted;
    },
    /** Claim the one fallback, so a deadline and an error cannot both fire it. */
    giveUp() {
      if (settled) return false;
      settled = true;
      return true;
    },
    errored(event) {
      if (settled) return false;
      const kind = classifyMapError(event);
      if (kind === "ignore") return false;
      if (kind === "fatal") {
        settled = true;
        return true;
      }
      failures += 1;
      if (painted || failures < limit) return false;
      settled = true;
      return true;
    }
  };
}
