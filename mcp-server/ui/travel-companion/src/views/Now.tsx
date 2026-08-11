import type { PlaceCard, PositionView } from "../derive";
import { localTime } from "../derive";
import { distanceLabel, humanize, localAddress, mapLink } from "../format";
import type { ItineraryItem, Place, Snapshot } from "../types";

/**
 * The screen you open one-handed on a platform. Big type, current and next, and the addresses you
 * would otherwise have to dig for. Nothing here needs a connection.
 */

function PlaceLine({ place }: { place: Place | undefined }) {
  if (!place) return null;
  const local = localAddress(place.metadata);
  const link = mapLink(place);
  return (
    <div>
      <div className="address">{place.address ?? place.locality ?? place.name}</div>
      {local ? <div className="address-local">{local}</div> : null}
      {link ? (
        <a className="link" href={link}>
          Open in maps
        </a>
      ) : null}
    </div>
  );
}

function Slot({
  eyebrow,
  item,
  zone,
  places,
}: {
  eyebrow: string;
  item: ItineraryItem | null;
  zone: string;
  places: Map<string, Place>;
}) {
  if (!item) return null;
  const start = localTime(item.planned_start ?? item.actual_start, zone);
  const end = localTime(item.planned_end, zone);
  const place = item.place_id ? places.get(item.place_id) : undefined;
  return (
    <section className="card">
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="headline">{item.title}</h2>
      {start ? (
        <div className="headline-time">
          {start}
          {end ? `–${end}` : ""}
          {item.flexibility === "fixed" ? " · fixed" : ""}
        </div>
      ) : (
        <div className="headline-time">Unscheduled</div>
      )}
      {place ? <PlaceLine place={place} /> : null}
      {item.notes ? <div className="notes">{item.notes}</div> : null}
    </section>
  );
}

export function NowView({
  snapshot,
  position,
  places,
  nearby,
  onOpenDay,
}: {
  snapshot: Snapshot;
  position: PositionView;
  places: Map<string, Place>;
  nearby: PlaceCard[];
  onOpenDay: () => void;
}) {
  const zone = snapshot.trip.timezone;
  const late = snapshot.current_state?.running_late_minutes ?? 0;
  const nothing = !position.now && !position.next && !position.then;

  return (
    <>
      {late > 0 ? <div className="alert">Running about {late} minutes behind.</div> : null}

      <Slot eyebrow="Now" item={position.now} zone={zone} places={places} />
      <Slot eyebrow="Next" item={position.next} zone={zone} places={places} />
      <Slot eyebrow="Then" item={position.then} zone={zone} places={places} />

      {nothing ? (
        <section className="card">
          <div className="eyebrow">Now</div>
          <h2 className="headline">Nothing scheduled</h2>
          <div className="meta">
            No remaining items for {position.localDate}. It is {position.localTime} in{" "}
            {zone.split("/").pop()?.replace(/_/g, " ")}.
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="button" onClick={onOpenDay}>
              Browse the plan
            </button>
          </div>
        </section>
      ) : null}

      {nearby.length ? (
        <section className="card flush">
          <div style={{ padding: "14px 14px 4px" }}>
            <div className="eyebrow">Saved places nearby</div>
          </div>
          {nearby.map((card) => (
            <div className="row" key={card.place.id}>
              <div className="time">{distanceLabel(card.distanceMeters)}</div>
              <div className="body">
                <div className="title">{card.place.name}</div>
                <div className="sub">
                  {card.visit ? <span className="tag visited">Visited</span> : null}
                  {humanize(card.place.category) || "Place"}
                  {card.place.address ? ` · ${card.place.address}` : ""}
                </div>
              </div>
            </div>
          ))}
          <div style={{ padding: "10px 14px", color: "var(--muted)", fontSize: 12.5 }}>
            Straight-line distance from your last known position, not a walking route.
          </div>
        </section>
      ) : null}
    </>
  );
}
