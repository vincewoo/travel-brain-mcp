import { useEffect, useRef } from "react";
import { AlertRow, IssueRow, PlaceRow, TimelineRow } from "../components/rows";
import { NoteEmpty } from "../components/states";
import { dateLabel, dateTimeLabel, humanize, joinMeta, plural, shortDateLabel } from "../../../shared/format";
import { relatedIssues, withAlerts } from "../../../shared/timeline";
import type { PlaceCard, PlanView } from "../derive";
import { dayView, journalForDate, reservationsForItem } from "../derive";
import type { Place, Snapshot } from "../types";

/**
 * The whole plan, one day at a time — the dashboard's Plan view on a phone.
 *
 * The dashboard stacks every day down the page; a phone gets a day strip instead, because
 * scrolling past nine days of a two-week trip to reach Thursday is not a thing anyone does while
 * standing up. Everything else is the same: the trip's issues in one place, each day's items with
 * its alerts inline, and the shortlist still waiting for a slot.
 */
export function PlanView({ snapshot, plan, cards, days, selected, today, places, onSelect }: {
  snapshot: Snapshot;
  plan: PlanView;
  cards: PlaceCard[];
  days: string[];
  selected: string;
  today: string;
  places: Map<string, Place>;
  onSelect: (date: string) => void;
}) {
  const zone = snapshot.trip.timezone;
  const day = dayView(snapshot, selected);
  const issues = relatedIssues(selected, day.timeline, plan.issues);
  const notes = journalForDate(snapshot, selected);
  const summary = plan.days.find((entry) => entry.date === selected);
  const stripRef = useRef<HTMLDivElement>(null);
  const cardsByPlace = new Map(cards.map((card) => [card.place.id, card]));

  // Keep the selected day in view when the tab opens on a date deep into a two-week trip.
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(".chip.active")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selected]);

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Plan</h2>
        <span className="view-count">{joinMeta(
          plural(plan.days.length, "day"),
          `${plan.scheduledCount} scheduled`,
          `${plan.unscheduled.length} waiting`,
          plural(plan.issues.length, "issue"),
        )}</span>
      </div>
    </div>

    <div className="day-strip" ref={stripRef}>
      {days.map((date) => {
        const entry = plan.days.find((candidate) => candidate.date === date);
        return <button
          type="button"
          key={date}
          className={`chip${date === selected ? " active" : ""}${date === today ? " today" : ""}`}
          aria-pressed={date === selected}
          onClick={() => onSelect(date)}
        >
          {shortDateLabel(date)}
          {entry?.issue_count ? <i className="dot warning" /> : null}
        </button>;
      })}
    </div>

    {plan.issues.length ? <section className="container">
      <div className="container-head sunken">
        <strong>{plural(plan.issues.length, "issue")} across the trip</strong>
        <span>Ask Claude when you are back online</span>
      </div>
      {plan.issues.map((issue, index) => <IssueRow key={issue.id ?? `${issue.title}-${index}`} issue={issue} />)}
    </section> : <NoteEmpty title="No planning issues" detail="No overlaps, missing starts, short buffers or stale research." />}

    <section className="container">
      <div className="container-head">
        <div className="head-label">
          <strong>{dateLabel(selected)}</strong>
          <span>{joinMeta(
            summary?.area ?? "",
            plural(day.timeline.length, "item"),
            `${summary?.fixed_anchors.length ?? 0} fixed`,
          )}</span>
        </div>
      </div>
      {day.timeline.length ? withAlerts(day.timeline, issues, zone).map((row) => row.kind === "alert"
        ? <AlertRow key={row.key} alert={row.alert} />
        : <TimelineRow
            key={row.key}
            item={row.item}
            zone={zone}
            detailed
            place={row.item.place_id ? places.get(row.item.place_id) : undefined}
            reservations={reservationsForItem(snapshot, row.item.id)}
          />) : <div className="row"><p className="row-meta">Nothing scheduled on this date yet.</p></div>}
    </section>

    {/* Reservations with no itinerary item of their own would otherwise be invisible on the day
        they fall on, and a confirmation code is the last thing to lose track of. */}
    {(() => {
      const loose = day.reservations.filter((reservation) => !reservation.itinerary_item_id);
      return loose.length ? <section className="container">
        <div className="container-head"><strong>Reservations this day</strong><span>{plural(loose.length, "booking")}</span></div>
        {loose.map((reservation) => <article className="row" key={reservation.id}>
          <div className="row-title-line">
            <strong>{reservation.provider ?? places.get(reservation.place_id ?? "")?.name ?? "Reservation"}</strong>
            <span className="row-aside">{humanize(reservation.status)}</span>
          </div>
          <p className="row-meta">{dateTimeLabel(reservation.reserved_start, zone)}</p>
          {reservation.confirmation_code ? <div className="detail"><div className="code">{reservation.confirmation_code}</div></div> : null}
        </article>)}
      </section> : null;
    })()}

    {notes.length ? <section className="container">
      <div className="container-head"><strong>Journal this day</strong><span>{plural(notes.length, "note")}</span></div>
      {notes.map((entry) => <article className="row" key={entry.id}>
        <p className="row-meta">{dateTimeLabel(entry.captured_at, zone)}</p>
        {/* raw_note verbatim, never the generated summary — the same rule the server keeps. */}
        <p className="raw-note">{entry.raw_note}</p>
      </article>)}
    </section> : null}

    {plan.unscheduled.length ? <section className="container">
      <div className="container-head">
        <div className="head-label">
          <strong>Unscheduled</strong>
          <span>{plural(plan.unscheduled.length, "saved place")}</span>
        </div>
      </div>
      {plan.unscheduled.map((link) => {
        const card = cardsByPlace.get(link.place_id);
        return card ? <PlaceRow key={link.place_id} card={card} /> : null;
      })}
    </section> : <NoteEmpty title="Tray is clear" detail="Every saved place is scheduled or set aside." />}
  </div>;
}
