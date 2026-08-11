import { useMemo, useState } from "react";
import type { PlaceCard } from "../derive";
import { searchCards } from "../derive";
import { distanceLabel, humanize, localAddress, mapLink } from "../format";

/** Everything saved for the trip, filtered on the phone — no server round trip to search. */
export function PlacesView({ cards }: { cards: PlaceCard[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shortlist" | "visited">("all");

  const shown = useMemo(() => {
    const byStatus = cards.filter((card) => {
      if (filter === "visited") return Boolean(card.visit) || card.tripStatus === "visited";
      if (filter === "shortlist") return card.tripStatus === "shortlist";
      return true;
    });
    return searchCards(byStatus, query).sort((left, right) => {
      if (left.distanceMeters !== null && right.distanceMeters !== null) {
        return left.distanceMeters - right.distanceMeters;
      }
      return left.place.name.localeCompare(right.place.name);
    });
  }, [cards, filter, query]);

  return (
    <>
      <input
        className="search"
        type="search"
        value={query}
        placeholder="Search saved places"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="day-strip">
        {(["all", "shortlist", "visited"] as const).map((option) => (
          <button
            type="button"
            key={option}
            className={`day-chip${filter === option ? " selected" : ""}`}
            onClick={() => setFilter(option)}
          >
            {humanize(option)}
          </button>
        ))}
      </div>

      {shown.length ? (
        shown.map((card) => {
          const local = localAddress(card.place.metadata);
          const link = mapLink(card.place);
          return (
            <section className="card" key={card.place.id}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ flex: 1 }}>
                  <div className="title" style={{ fontSize: 17, fontWeight: 600 }}>
                    {card.place.name}
                  </div>
                  <div className="meta">
                    {card.visit ? <span className="tag visited">Visited</span> : null}
                    {card.scheduled ? <span className="tag">Scheduled</span> : null}
                    {card.researchFreshness === "stale" ? <span className="tag stale">Research stale</span> : null}
                    {humanize(card.place.category) || "Place"}
                  </div>
                </div>
                {card.distanceMeters !== null ? (
                  <div className="meta">{distanceLabel(card.distanceMeters)}</div>
                ) : null}
              </div>

              {card.place.address ? <div className="address">{card.place.address}</div> : null}
              {local ? <div className="address-local">{local}</div> : null}
              {card.note ? <div className="notes">{card.note}</div> : null}

              {card.visit?.notes ? <div className="notes">Visit: {card.visit.notes}</div> : null}
              {card.recommendation?.shareable_note ? (
                <div className="notes">
                  {humanize(card.recommendation.provenance)}: {card.recommendation.shareable_note}
                </div>
              ) : null}

              {card.research.slice(0, 3).map((entry) => (
                <div className="notes" key={entry.id}>
                  <strong>{entry.topic}:</strong> {entry.summary ?? entry.finding}
                </div>
              ))}

              {link ? (
                <div style={{ marginTop: 10 }}>
                  <a className="link" href={link}>
                    Open in maps
                  </a>
                </div>
              ) : null}
            </section>
          );
        })
      ) : (
        <div className="empty">No saved places match.</div>
      )}
    </>
  );
}
