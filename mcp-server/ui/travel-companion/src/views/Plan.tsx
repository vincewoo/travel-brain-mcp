import { useEffect, useRef } from "react";
import { AlertRow, IssueRow, PlaceRow, TimelineRow } from "../components/rows";
import { NoteEmpty } from "../components/states";
import { dateLabel, dateTimeLabel, humanize, joinMeta, plural, shortDateLabel } from "../../../shared/format";
import { relatedIssues, withAlerts } from "../../../shared/timeline";
import type { PlaceCard, PlanView as Plan } from "../derive";
import { dayView, journalForDate, reservationsForItem } from "../derive";
import type { Place, Snapshot } from "../types";

/**
 * The whole plan, every day of it — the dashboard's Plan view on a phone, and a board on a screen.
 *
 * The dashboard stacks every day down the page and so does this, because a plan you can only read
 * one day at a time is a plan you cannot check: Thursday's ferry makes sense next to Wednesday's
 * hotel, not alone behind a chip. On a wider screen the same day sections turn side by side into
 * columns that scroll horizontally, which is what the extra width is actually good for — four days
 * at once instead of four inches of empty margin. The day strip stays either way, no longer as a
 * filter but as the jump: tap a date and its column comes to you.
 *
 * Each day carries what that day needs offline — its timeline with alerts inline, the reservations
 * that belong to no item, the notes written on it — so scrolling to a date is scrolling to
 * everything about it.
 */
export function PlanView({ snapshot, plan, cards, days, selected, today, places, onSelect }: {
  snapshot: Snapshot;
  plan: Plan;
  cards: PlaceCard[];
  days: string[];
  selected: string;
  today: string;
  places: Map<string, Place>;
  onSelect: (date: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const cardsByPlace = new Map(cards.map((card) => [card.place.id, card]));

  // Keep the selected day's chip in view when the tab opens on a date deep into a two-week trip.
  // The day itself is not scrolled to on open — that would bury the trip's issues under a day.
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(".chip.active")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selected]);

  // A chip is a jump, so it moves the plan to the day: down the page on a phone, across the board
  // on a screen. `nearest` leaves a day that is already visible where it is.
  const jump = (date: string) => {
    onSelect(date);
    dayRefs.current.get(date)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  return <div className="view plan">
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

    <div className="day-strip plan-strip" ref={stripRef}>
      {days.map((date) => {
        const entry = plan.days.find((candidate) => candidate.date === date);
        return <button
          type="button"
          key={date}
          className={`chip${date === selected ? " active" : ""}${date === today ? " today" : ""}`}
          aria-pressed={date === selected}
          onClick={() => jump(date)}
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

    {days.length ? <div className="plan-days">
      {days.map((date) => <PlanDay
        key={date}
        ref={(node) => {
          if (node) dayRefs.current.set(date, node);
          else dayRefs.current.delete(date);
        }}
        snapshot={snapshot}
        plan={plan}
        date={date}
        today={today}
        places={places}
      />)}
    </div> : <NoteEmpty title="No trip days yet" detail="Set trip dates or add itinerary items to create day sections." />}

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

/** One day of the trip: its timeline, the bookings it holds, and what was written on it. */
function PlanDay({ ref, snapshot, plan, date, today, places }: {
  ref: (node: HTMLElement | null) => void;
  snapshot: Snapshot;
  plan: Plan;
  date: string;
  today: string;
  places: Map<string, Place>;
}) {
  const zone = snapshot.trip.timezone;
  const day = dayView(snapshot, date);
  const issues = relatedIssues(date, day.timeline, plan.issues);
  const summary = plan.days.find((entry) => entry.date === date);
  const notes = journalForDate(snapshot, date);
  // Reservations with no itinerary item of their own would otherwise be invisible on the day they
  // fall on, and a confirmation code is the last thing to lose track of.
  const loose = day.reservations.filter((reservation) => !reservation.itinerary_item_id);

  return <section className={`container plan-day${date === today ? " is-today" : ""}`} ref={ref}>
    <div className="container-head">
      <div className="head-label">
        <strong>{dateLabel(date)}</strong>
        <span>{joinMeta(
          date === today ? "Today" : "",
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

    {loose.length ? <>
      <div className="container-head sunken subhead"><strong>Reservations</strong><span>{plural(loose.length, "booking")}</span></div>
      {loose.map((reservation) => <article className="row" key={reservation.id}>
        <div className="row-title-line">
          <strong>{reservation.provider ?? places.get(reservation.place_id ?? "")?.name ?? "Reservation"}</strong>
          <span className="row-aside">{humanize(reservation.status)}</span>
        </div>
        <p className="row-meta">{dateTimeLabel(reservation.reserved_start, zone)}</p>
        {reservation.confirmation_code ? <div className="detail"><div className="code">{reservation.confirmation_code}</div></div> : null}
      </article>)}
    </> : null}

    {notes.length ? <>
      <div className="container-head sunken subhead"><strong>Journal</strong><span>{plural(notes.length, "note")}</span></div>
      {notes.map((entry) => <article className="row" key={entry.id}>
        <p className="row-meta">{dateTimeLabel(entry.captured_at, zone)}</p>
        {/* raw_note verbatim, never the generated summary — the same rule the server keeps. */}
        <p className="raw-note">{entry.raw_note}</p>
      </article>)}
    </> : null}
  </section>;
}
