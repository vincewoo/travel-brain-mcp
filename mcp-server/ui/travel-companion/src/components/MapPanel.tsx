import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { plural } from "../../../shared/format";
import { OfflineMap, type MapPoint } from "./OfflineMap";
import type { Origin } from "../types";

/**
 * The one component every map on this app goes through, and the only thing that decides whether a
 * traveller sees tiles or the schematic.
 *
 * Three rules, in order:
 *
 * 1. **Offline draws the schematic.** Never a grey grid, never a spinner waiting on tiles that are
 *    not coming. The coordinates are already on the phone; the basemap is the only missing part.
 * 2. **Tiles are opted into once.** A tile request tells a third party which corner of which city
 *    the traveller is looking at, which is close to telling it where they are — in an app that
 *    deliberately keeps no GPS trail. So the first map asks, and remembers the answer.
 * 3. **A failure falls back rather than reports.** A dead style URL, a captive portal, a chunk that
 *    will not load: all of them end at the schematic, which is still useful.
 */

const TileMap = lazy(() => import("./TileMap"));

/** A chunk that will not load is just another way of being offline. */
class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MapPanel({
  points,
  origin,
  total,
  noun = "place",
  height = 220,
  interactive = true,
  offline,
  enabled,
  onEnable,
  onSelect,
}: {
  points: MapPoint[];
  origin?: Origin | null;
  /** How many things the caller wanted to draw, including the ones with no coordinates. */
  total?: number;
  noun?: string;
  height?: number;
  interactive?: boolean;
  offline: boolean;
  enabled: boolean;
  onEnable: () => void;
  onSelect?: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const mappable = points.filter((point) => point.latitude !== null && point.longitude !== null);
  const counted = total ?? points.length;
  const missing = counted - mappable.length;

  // A place Claude saved by name alone is normal — `trip_offline_places` returns it with null
  // coordinates rather than dropping it — so this says why the map is missing instead of hiding.
  if (!mappable.length) {
    return counted
      ? <p className="map-note">No coordinates saved for {counted === 1 ? `this ${noun}` : `these ${plural(counted, noun)}`} yet, so there is nothing to draw.</p>
      : null;
  }

  const schematic = <OfflineMap points={mappable} origin={origin} height={height} />;
  const tiles = enabled && !offline && !failed;

  // Said under every map, tiles or not: the count is how you know the drawing is the whole day and
  // not the part of it that happened to be geocoded.
  const note = missing > 0 ? `${mappable.length} of ${plural(counted, noun)} mapped` : "";
  // The dashed pin already says which points are estimates. This says it once in words when every
  // pin is one, because a map drawn entirely from recalled coordinates is worth stating outright
  // rather than leaving to be inferred from a stroke style.
  const estimated = mappable.filter((point) => point.approximate).length;
  const approximate = estimated === mappable.length
    ? "Positions are approximate"
    : estimated > 0 ? `${estimated} position${estimated === 1 ? "" : "s"} approximate` : "";
  const caption = [
    note,
    approximate,
    tiles || !offline ? "" : "No basemap offline — positions and distances are real",
  ].filter(Boolean).join(" · ");

  return <div className="map-panel">
    {tiles
      ? <MapBoundary fallback={schematic}>
          <Suspense fallback={schematic}>
            <TileMap
              points={mappable}
              origin={origin}
              height={height}
              interactive={interactive}
              onSelect={onSelect}
              onFailure={() => setFailed(true)}
            />
          </Suspense>
        </MapBoundary>
      : schematic}

    {caption ? <p className="map-note">{caption}</p> : null}

    {!enabled && !offline ? <div className="map-consent">
      <p>Map tiles come from OpenFreeMap. Loading them tells it which area you are looking at.</p>
      <button type="button" className="button" onClick={onEnable}>Load map</button>
    </div> : null}
  </div>;
}
