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
import { distanceLabel, localAddress, mapLink } from "../format";
import type { ClockIssue, ItineraryItem, Place, Reservation } from "../types";

/**
 * The same rows the dashboard draws, minus the writes.
 *
 * Phase 1 of the companion is read-only, so nothing here offers Mark done, Skip, or Ask Claude —
 * a button that queued a judgement call for later would be the one thing this app promised not to
 * do. What it adds instead is the offline detail the dashboard has no reason to carry: the address
 * in local script, the confirmation code, the straight-line distance.
 */

/** Address, local-script address, reservation code, notes: what you show someone, offline. */
export function PlaceDetail({ place, notes, reservations }: {
  place?: Place;
  notes?: string | null;
  reservations?: Reservation[];
}) {
  const local = place ? localAddress(place.metadata) : null;
  const link = place ? mapLink(place) : null;
  if (!place && !notes && !reservations?.length) return null;
  return <div className="detail">
    {place?.address ? <div className="address">{place.address}</div> : null}
    {local ? <div className="address-local">{local}</div> : null}
    {reservations?.map((reservation) => <div className="address" key={reservation.id}>
      {joinMeta(reservation.provider ?? "Reservation", reservation.party_size ? `party of ${reservation.party_size}` : "", reservation.status ?? "")}
      {reservation.confirmation_code ? <div className="code">{reservation.confirmation_code}</div> : null}
    </div>)}
    {notes ? <div className="notes">{notes}</div> : null}
    {link ? <a className="link" href={link}>Open in maps</a> : null}
  </div>;
}

export function TimelineRow({ item, zone, current, place, reservations, detailed }: {
  item: ItineraryItem;
  zone: string;
  current?: boolean;
  place?: Place;
  reservations?: Reservation[];
  /** The day view carries the address and code inline; the Now tab shows them once, up top. */
  detailed?: boolean;
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
      {detailed ? <PlaceDetail place={place} notes={item.notes} reservations={reservations} /> : null}
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
