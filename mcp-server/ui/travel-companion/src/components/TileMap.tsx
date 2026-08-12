import { useEffect, useRef } from "react";
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { BASEMAP_TIMEOUT_MS, createTileWatch, MAX_ZOOM, STYLE_URL } from "../map-source.mjs";
import type { MapPoint } from "./OfflineMap";
import type { Origin } from "../types";

/**
 * The real map, and the only module in this app that imports `maplibre-gl`.
 *
 * That is the whole point of the file existing separately: `MapPanel` reaches it through a dynamic
 * `import()`, so the library and its stylesheet land in their own chunk and never touch the cold
 * start. The shell is what the traveller downloads on bad hotel wifi; a map is what they open when
 * the connection is good enough to fetch tiles anyway. A guard test asserts the split holds.
 *
 * Tiles come from OpenFreeMap: no API key, no account, no request cap, commercial use allowed. The
 * attribution control is deliberately left on — the TileJSON carries the OpenStreetMap and
 * OpenMapTiles credit, and rendering it is the licence condition.
 *
 * Nothing here is cached for offline use. The service worker passes cross-origin requests straight
 * through, so tiles are never stored, which is what keeps `docs/companion-pwa.md`'s "no offline
 * tiles" promise true. With the radio off, `MapPanel` draws the schematic instead.
 */

const TONE_CLASS: Record<string, string> = {
  muted: "muted", info: "info", warning: "warning", danger: "danger", ok: "ok",
};

function pinElement(point: MapPoint): HTMLElement {
  const element = document.createElement("div");
  element.className = [
    "map-pin",
    TONE_CLASS[point.tone ?? "info"] ?? "info",
    point.muted ? "muted-fill" : "",
    point.approximate ? "approximate" : "",
  ].filter(Boolean).join(" ");
  element.title = point.label;
  if (point.index) element.textContent = String(point.index);
  return element;
}

function originElement(): HTMLElement {
  const element = document.createElement("div");
  element.className = "map-origin";
  element.title = "Your last known position";
  return element;
}

export default function TileMap({ points, origin, height = 220, interactive = true, onSelect, onFailure }: {
  points: MapPoint[];
  origin?: Origin | null;
  height?: number;
  interactive?: boolean;
  onSelect?: (id: string) => void;
  onFailure?: () => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  // Kept in a ref so a re-render with a new handler does not tear the map down and take a WebGL
  // context with it.
  const select = useRef(onSelect);
  select.current = onSelect;
  const fail = useRef(onFailure);
  fail.current = onFailure;

  const placed = points.filter(
    (point): point is MapPoint & { latitude: number; longitude: number } =>
      point.latitude !== null && point.longitude !== null
  );
  // A stable description of what is drawn, so the effect re-runs when the pins actually change
  // rather than on every parent render.
  const signature = JSON.stringify([
    placed.map((point) => [point.id, point.latitude, point.longitude, point.tone, point.index, point.muted, point.approximate]),
    origin ? [origin.latitude, origin.longitude] : null,
  ]);

  useEffect(() => {
    if (!container.current || !placed.length) return;

    const instance = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      interactive,
      // Without this MapLibre allows z22 over a source that stops at z14, so the pinch keeps
      // offering detail that cannot arrive. See `MAX_ZOOM`.
      maxZoom: MAX_ZOOM,
      // A phone in one hand does not need pitch or rotation, and both make a map harder to read
      // back against a north-up schematic.
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: { compact: true },
    });
    map.current = instance;
    instance.touchZoomRotate?.disableRotation();
    if (interactive) instance.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // A basemap that will not load means the panel should fall back to the schematic rather than
    // leave the traveller looking at an empty rectangle. What counts as "will not load" is decided
    // in `map-source.mjs`: a dead style is fatal at once, tiles are given a few attempts, and a
    // map that has already painted keeps its place when one tile goes missing.
    const watch = createTileWatch();
    instance.on("data", (event) => {
      if (event.dataType !== "source" || !("tile" in event)) return;
      // Only the vector source counts as the basemap drawing. The Liberty style also carries a
      // Natural Earth raster backdrop, which loads on the main thread and so keeps painting even
      // when the worker that fetches vector tiles is gone — the exact failure worth catching.
      const source = event.sourceId ? instance.getSource(event.sourceId) : undefined;
      if (source?.type === "vector") watch.drew();
    });
    instance.on("error", (event) => {
      if (watch.errored(event)) fail.current?.();
    });
    // Errors only catch a basemap that fails loudly. A worker that never starts makes no requests
    // and raises nothing, so the deadline is what turns that into the schematic.
    const deadline = setTimeout(() => {
      if (!watch.hasPainted() && watch.giveUp()) fail.current?.();
    }, BASEMAP_TIMEOUT_MS);

    const markers: Marker[] = [];
    for (const point of placed) {
      const element = pinElement(point);
      if (select.current) {
        element.setAttribute("role", "button");
        element.tabIndex = 0;
        element.addEventListener("click", () => select.current?.(point.id));
      }
      markers.push(new Marker({ element }).setLngLat([point.longitude, point.latitude]).addTo(instance));
    }
    if (origin) {
      markers.push(new Marker({ element: originElement() }).setLngLat([origin.longitude, origin.latitude]).addTo(instance));
    }

    const corners = [...placed.map((point) => [point.longitude, point.latitude] as [number, number])];
    if (origin) corners.push([origin.longitude, origin.latitude]);
    if (corners.length === 1) {
      instance.jumpTo({ center: corners[0], zoom: 15.5 });
    } else {
      const bounds = corners.reduce((box, corner) => box.extend(corner), new LngLatBounds(corners[0], corners[0]));
      instance.fitBounds(bounds, { padding: 48, maxZoom: MAX_ZOOM, animate: false });
    }

    return () => {
      clearTimeout(deadline);
      for (const marker of markers) marker.remove();
      // Releasing the WebGL context matters: browsers cap how many can exist at once, and this app
      // mounts a map inside rows that come and go.
      instance.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, interactive]);

  if (!placed.length) return null;
  return <div className="tile-map" style={{ height }} ref={container} />;
}
