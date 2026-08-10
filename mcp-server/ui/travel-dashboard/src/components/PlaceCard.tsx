import React, { type ReactNode } from "react";
import { humanize } from "../format";
import type { SavedPlace } from "../types";

interface Props {
  place: SavedPlace;
  selected?: boolean;
  selectable?: boolean;
  busy?: boolean;
  onToggle?: (place: SavedPlace) => void;
  children?: ReactNode;
}

export function PlaceCard({ place, selected, selectable, busy, onToggle, children }: Props) {
  const location = [place.locality, place.region].filter(Boolean).join(", ");
  return <article className={`place-card ${selected ? "is-selected" : ""}`}>
    <div className="place-main">
      <div className="card-title-row"><div><span className="item-type">{humanize(place.category ?? "place")}</span><h3>{place.name}</h3></div><span className={`badge badge-status-${place.trip_status ?? "saved"}`}>{humanize(place.trip_status ?? "saved")}</span></div>
      {location || place.address ? <p className="supporting-copy">{location || place.address}</p> : null}
      {place.note ? <p className="supporting-copy">{place.note}</p> : null}
      <div className="evidence-list">
        {place.priority ? <span>Priority {place.priority}</span> : null}
        {place.researched ? <span>{place.research_count ? `${place.research_count} research notes` : "Researched"}</span> : null}
        {place.scheduled ? <span>Scheduled</span> : null}{place.visited ? <span>Visited</span> : null}
        {place.freshness === "stale" ? <span className="evidence-warning">Needs refresh</span> : null}
      </div>
      {children}
    </div>
    {selectable && onToggle ? <button type="button" className={`select-control ${selected ? "is-selected" : ""}`} aria-pressed={selected} disabled={busy} onClick={() => onToggle(place)}>{selected ? "Selected" : "Select"}</button> : null}
  </article>;
}
