import { MapPanel } from "../components/MapPanel";
import type { MapPoint } from "../components/OfflineMap";
import { AlertRow, NearbyRow, TimelineRow } from "../components/rows";
import { NoteEmpty } from "../components/states";
import { clockLabel, dayHeadingLabel, flexibilityLabel, joinMeta, plural, timeLabel, zoneAbbreviation } from "../../../shared/format";
import { withAlerts } from "../../../shared/timeline";
import type { PlaceCard, PositionView } from "../derive";
import { dayView, reservationsForItem } from "../derive";
import type { ClockIssue, ItineraryItem, Origin, Place, Snapshot } from "../types";

/**
 * The screen you open one-handed on a platform.
 *
 * It is the dashboard's Today view: the same Now bar, the same timeline with alerts sitting where
 * they bite, the same status vocabulary. What differs is what a phone is for — the item in
 * progress and the one after it carry their address, their local-script address and their
 * confirmation code inline, because that is what you are actually holding the phone up to read.
 */

/** Elapsed share of the item in progress, or null when its span is unknown. */
function progressOf(item: { actual_start?: string | null; planned_start?: string | null; planned_end?: string | null } | null, at: Date) {
  const start = new Date(item?.actual_start ?? item?.planned_start ?? "").getTime();
  const end = new Date(item?.planned_end ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(100, Math.max(0, ((at.getTime() - start) / (end - start)) * 100));
}

/**
 * Today's stops as pins, numbered the way the timeline is numbered.
 *
 * An itinerary item carries a `place_id` and nothing else — no coordinates of its own — so a stop
 * that is transit, or open time, or a place saved by name alone, cannot be drawn. Those are counted
 * and reported by `MapPanel` rather than quietly left out: a map showing three of five stops while
 * looking complete is worse than no map.
 */
function dayPoints(timeline: ItineraryItem[], places: Map<string, Place>): MapPoint[] {
  return timeline.flatMap((item, order) => {
    const place = item.place_id ? places.get(item.place_id) : undefined;
    if (!place) return [];
    const done = ["completed", "skipped", "cancelled"].includes(item.status);
    return [{
      id: item.id,
      label: item.title,
      latitude: place.latitude,
      longitude: place.longitude,
      index: order + 1,
      tone: done ? "muted" as const : "info" as const,
      muted: done,
    }];
  });
}

export function NowView({ snapshot, position, places, nearby, issues, clock, origin, offline, mapsEnabled, onEnableMaps }: {
  snapshot: Snapshot;
  position: PositionView;
  places: Map<string, Place>;
  nearby: PlaceCard[];
  issues: ClockIssue[];
  clock: Date;
  origin: Origin | null;
  offline: boolean;
  mapsEnabled: boolean;
  onEnableMaps: () => void;
}) {
  const zone = snapshot.trip.timezone;
  const { now, next } = position;
  const day = dayView(snapshot, position.localDate);
  const percent = progressOf(now, clock);
  const done = day.timeline.filter((item) => item.status === "completed").length;
  const late = snapshot.current_state?.running_late_minutes ?? 0;
  const nowClock = [clockLabel(position.localTime), zoneAbbreviation(zone)].filter(Boolean).join(" ");
  const nextLine = next
    ? `Next: ${joinMeta([next.title, timeLabel(next.planned_start, zone)].filter(Boolean).join(", "), flexibilityLabel(next.flexibility).toLowerCase())}`
    : "";

  return <>
    <div className="now-bar">
      <div>
        <div>
          <p className="now-label">{joinMeta("Now", nowClock, late > 0 ? `${late} min behind` : "")}</p>
          <strong className="now-title">{now?.title ?? "Open time"}</strong>
          {nextLine ? <p className="now-next">{nextLine}</p> : null}
        </div>
      </div>
      {percent === null ? null : <div className="now-progress"><i style={{ width: `${percent}%` }} /></div>}
    </div>

    <div className="view">
      {day.timeline.length ? <section className="container">
        <div className="container-head">
          <strong>{dayHeadingLabel(position.localDate)}</strong>
          <span>{joinMeta(plural(day.timeline.length, "item"), done ? `${done} done` : "", issues.length ? `${issues.length} flagged` : "")}</span>
        </div>
        {withAlerts(day.timeline, issues, zone).map((row) => row.kind === "alert"
          ? <AlertRow key={row.key} alert={row.alert} />
          : <TimelineRow
              key={row.key}
              item={row.item}
              zone={zone}
              current={row.item.id === now?.id}
              detailed={row.item.id === now?.id || row.item.id === next?.id}
              place={row.item.place_id ? places.get(row.item.place_id) : undefined}
              reservations={reservationsForItem(snapshot, row.item.id)}
              origin={origin ?? undefined}
            />)}
      </section> : <NoteEmpty
        title={`Nothing scheduled on ${dayHeadingLabel(position.localDate).split(",")[0]}`}
        detail="The day is yours."
      />}

      {day.timeline.length ? <section className="container">
        <div className="container-head">
          <strong>Today on the map</strong>
          <span>{joinMeta("North up", origin ? "your position marked" : "position unknown")}</span>
        </div>
        <MapPanel
          points={dayPoints(day.timeline, places)}
          total={day.timeline.length}
          noun="stop"
          origin={origin}
          offline={offline}
          enabled={mapsEnabled}
          onEnable={onEnableMaps}
        />
      </section> : null}

      {nearby.length ? <section className="container">
        <div className="container-head">
          <strong>Saved places nearby</strong>
          <span>{plural(nearby.length, "place")}</span>
        </div>
        {nearby.map((card) => <NearbyRow key={card.place.id} card={card} />)}
        <p className="footnote">Straight-line distance from your last known position, not a walking route.</p>
      </section> : null}
    </div>
  </>;
}
