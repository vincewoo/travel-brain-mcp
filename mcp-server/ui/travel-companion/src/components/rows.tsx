import type { ReactNode } from "react";
import {
  durationLabel,
  flexibilityStatus,
  humanize,
  issueTone,
  joinMeta,
  placeStatus,
  plural,
  shortDateLabel,
  timeLabel,
} from "../../../shared/format";
import type { PlaceCard } from "../derive";
import { distanceLabel, localAddress, mapDirectionsLink, mapSearchLink } from "../format";
import type { ClockIssue, ItineraryItem, Origin, Place, Reservation } from "../types";

/**
 * The same rows the dashboard draws, with only the writes a phone may honestly make.
 *
 * Mark done and Skip are here because they record what already happened, offline or not; the queue
 * behind them is what makes that safe. Anything asking where an item should move to, or what to do
 * instead, still belongs to Claude — a button that queued a judgement call for later would be the
 * one thing this app promised not to do. What the rows add beyond the dashboard is the offline
 * detail it has no reason to carry: the address in local script, the confirmation code, the
 * straight-line distance.
 */

/**
 * The way out to a real map app, for the things this app deliberately does not do: routing, live
 * transit, street view, a search for something nobody saved.
 */
export function MapLinks({ place, origin }: { place: Place; origin?: Origin }) {
  const directions = mapDirectionsLink(place, origin);
  const search = mapSearchLink(place);
  if (!directions && !search) return null;
  return <div className="map-links">
    {directions ? <a className="link" href={directions} target="_blank" rel="noreferrer">Directions</a> : null}
    {search ? <a className="link" href={search} target="_blank" rel="noreferrer">Open in Google Maps</a> : null}
  </div>;
}

/** Address, local-script address, reservation code, notes: what you show someone, offline. */
export function PlaceDetail({ place, notes, reservations, origin, map }: {
  place?: Place;
  notes?: string | null;
  reservations?: Reservation[];
  origin?: Origin;
  /** A map for this one place. Passed in rather than mounted here — see `MapPanel` on why the
   *  number of live tile maps has to stay countable. */
  map?: ReactNode;
}) {
  const local = place ? localAddress(place.metadata) : null;
  if (!place && !notes && !reservations?.length) return null;
  return <div className="detail">
    {place?.address ? <div className="address">{place.address}</div> : null}
    {local ? <div className="address-local">{local}</div> : null}
    {reservations?.map((reservation) => <div className="address" key={reservation.id}>
      {joinMeta(reservation.provider ?? "Reservation", reservation.party_size ? `party of ${reservation.party_size}` : "", reservation.status ?? "")}
      {reservation.confirmation_code ? <div className="code">{reservation.confirmation_code}</div> : null}
    </div>)}
    {notes ? <div className="notes">{notes}</div> : null}
    {map}
    {place ? <MapLinks place={place} origin={origin} /> : null}
  </div>;
}

export function TimelineRow({ item, zone, current, place, reservations, detailed, origin, map, busy, onDone, onSkip }: {
  item: ItineraryItem;
  zone: string;
  current?: boolean;
  place?: Place;
  reservations?: Reservation[];
  /** The day view carries the address and code inline; the Now tab shows them once, up top. */
  detailed?: boolean;
  origin?: Origin;
  map?: ReactNode;
  busy?: boolean;
  onDone?: (item: ItineraryItem) => void;
  onSkip?: (item: ItineraryItem) => void;
}) {
  const done = item.status === "completed";
  const skipped = ["skipped", "cancelled"].includes(item.status);
  const inactive = done || skipped;
  const start = item.actual_start ?? item.planned_start;
  const shifted = item.actual_start && item.planned_start && timeLabel(item.actual_start, zone) !== timeLabel(item.planned_start, zone);
  const under = current ? "now" : durationLabel(start, item.actual_end ?? item.planned_end);
  const flex = flexibilityStatus(item.flexibility);

  return <article className={`row timeline-row${inactive ? " is-done" : ""}${current ? " is-current" : ""}`}>
    <div className={`time-gutter${inactive ? " past" : ""}${current ? " current" : ""}`}>
      {timeLabel(start, zone) || "Unscheduled"}{under ? <span>{under}</span> : null}
    </div>
    <div className="row-body">
      <div className="row-title-line">
        <strong>{item.title}</strong>
        {done ? <span className="row-aside">Done</span>
          : skipped ? <span className="row-aside">Skipped</span>
          : current ? <span className="status info">In progress</span>
          : <span className={`status ${flex.text}`}><i className={`dot ${flex.dot}`} />{flex.label}</span>}
      </div>
      {(() => {
        const meta = joinMeta(
          humanize(item.item_type ?? "activity"),
          shifted ? `planned ${timeLabel(item.planned_start, zone)}` : "",
          place?.name && place.name !== item.title ? place.name : "",
        );
        return meta ? <p className="row-meta">{meta}</p> : null;
      })()}
      {detailed ? <PlaceDetail place={place} notes={item.notes} reservations={reservations} origin={origin} map={map} /> : null}
      {/* The row in progress carries its own buttons in the Now bar, so it does not repeat them. */}
      {!inactive && !current && (onDone || onSkip) ? <div className="row-actions">
        {onDone ? <button type="button" className="link-button" disabled={busy} onClick={() => onDone(item)}>Mark done</button> : null}
        {onSkip && item.flexibility !== "fixed" ? <button type="button" className="link-button quiet" disabled={busy} onClick={() => onSkip(item)}>Skip</button> : null}
      </div> : null}
    </div>
  </article>;
}

/** An alert is a row in the timeline, sitting at the point where it bites. */
export function AlertRow({ alert }: { alert: ClockIssue }) {
  return <div className={`alert-row ${issueTone(alert.severity)}`}>
    <div />
    <div><i className="dot" />{joinMeta(alert.title, alert.detail ?? "")}</div>
  </div>;
}

export function IssueRow({ issue }: { issue: ClockIssue }) {
  const tone = issueTone(issue.severity);
  return <div className={`issue-row ${tone}`}>
    <i className={`dot ${tone}`} />
    <div><strong>{issue.title}</strong>{issue.detail ? <span> — {issue.detail}</span> : null}</div>
    <small>{issue.date ? shortDateLabel(issue.date) : "—"}</small>
  </div>;
}

/** A saved place, with everything the phone knows about it and nothing it has to fetch. */
export function PlaceRow({ card, children }: { card: PlaceCard; children?: ReactNode }) {
  const status = placeStatus(card.tripStatus, card.researchFreshness);
  const meta = joinMeta(
    humanize(card.place.category ?? "place"),
    card.place.locality ?? card.place.region ?? "",
    card.priority ? `P${card.priority}` : "",
    card.research.length ? plural(card.research.length, "research note") : "",
    card.itineraryDates.length ? `scheduled ${card.itineraryDates.map(shortDateLabel).join(", ")}` : "",
    distanceLabel(card.distanceMeters) ?? "",
  );
  return <article className="row">
    <div className="row-title-line">
      <strong>{card.place.name}</strong>
      <span className={`status ${status.text}`}><i className={`dot ${status.dot}`} />{status.label}</span>
    </div>
    {meta ? <p className="row-meta">{meta}</p> : null}
    {card.note ? <p className="row-note">{card.note}</p> : null}
    {children}
  </article>;
}

/** Nearby reads like the timeline does, with distance where the time would be. */
export function NearbyRow({ card }: { card: PlaceCard }) {
  const status = placeStatus(card.tripStatus, card.researchFreshness);
  return <article className="row timeline-row">
    <div className="time-gutter">{distanceLabel(card.distanceMeters)}</div>
    <div className="row-body">
      <div className="row-title-line">
        <strong>{card.place.name}</strong>
        <span className={`status ${status.text}`}><i className={`dot ${status.dot}`} />{status.label}</span>
      </div>
      <p className="row-meta">{joinMeta(humanize(card.place.category ?? "place"), card.place.address ?? "")}</p>
    </div>
  </article>;
}
