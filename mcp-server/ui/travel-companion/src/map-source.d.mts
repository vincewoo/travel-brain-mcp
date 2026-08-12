/**
 * Types for the basemap facts and failure classification. The implementation is plain JavaScript so
 * that `node --test` can exercise the fallback rules directly — the app has no DOM test runner, and
 * a rule about when to abandon the tiles is worth testing somewhere other than by eye.
 */

/** A MapLibre `ErrorEvent`, narrowed to the parts the classification actually reads. */
export interface MapErrorLike {
  error?: { message?: string; url?: string } | null;
  sourceId?: string;
}

export type MapErrorKind = "fatal" | "tile" | "ignore";

export interface TileWatch {
  /** Record that a tile painted. Only for the source carrying the map's content, never a backdrop. */
  drew(): void;
  /** Whether anything has drawn yet. */
  hasPainted(): boolean;
  /** @returns true exactly once, the moment the map should fall back to the schematic. */
  errored(event: MapErrorLike | null | undefined): boolean;
  /** Claim the single fallback directly, for a deadline rather than an error. */
  giveUp(): boolean;
}

export declare const STYLE_URL: string;
export declare const SOURCE_MAX_ZOOM: number;
export declare const MAX_ZOOM: number;
export declare const TILE_FAILURE_LIMIT: number;
export declare const BASEMAP_TIMEOUT_MS: number;

export declare function classifyMapError(event: MapErrorLike | null | undefined): MapErrorKind;
export declare function createTileWatch(options?: { limit?: number }): TileWatch;
