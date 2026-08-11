import { useEffect, useRef } from "react";
import { dayView, journalForDate, localTime, reservationsForItem } from "../derive";
import { dayLabel, humanize, localAddress } from "../format";
import type { Place, Snapshot } from "../types";

/** The whole plan, one day at a time, in the trip's timezone. */
export function DayView({
  snapshot,
  days,
  selected,
  today,
  places,
  onSelect,
}: {
  snapshot: Snapshot;
  days: string[];
  selected: string;
  today: string;
  places: Map<string, Place>;
  onSelect: (date: string) => void;
}) {
  const zone = snapshot.trip.timezone;
  const view = dayView(snapshot, selected);
  const notes = journalForDate(snapshot, selected);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the selected day in view when the tab opens on a date deep into a two-week trip.
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(".day-chip.selected")?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [selected]);

  return (
    <>
      <div className="day-strip" ref={stripRef}>
        {days.map((date) => (
          <button
            type="button"
            key={date}
            className={`day-chip${date === selected ? " selected" : ""}${date === today ? " today" : ""}`}
            onClick={() => onSelect(date)}
          >
            {dayLabel(date, zone)}
          </button>
        ))}
      </div>

      {view.alerts.map((alert) => (
        <div className="alert" key={alert.id}>
          {alert.detail}
        </div>
      ))}

      {view.timeline.length ? (
        <section className="card flush">
          {view.timeline.map((item) => {
            const place = item.place_id ? places.get(item.place_id) : undefined;
            const reservations = reservationsForItem(snapshot, item.id);
            const done = ["completed", "skipped", "cancelled"].includes(item.status);
            const start = localTime(item.actual_start ?? item.planned_start, zone);
            return (
              <div className={`row${done ? " done" : ""}`} key={item.id}>
                <div className="time">{start ?? "—"}</div>
                <div className="body">
                  <div className="title">{item.title}</div>
                  <div className="sub">
                    {item.flexibility === "fixed" ? <span className="tag fixed">Fixed</span> : null}
                    {done ? <span className="tag">{humanize(item.status)}</span> : null}
                    {place?.address ?? place?.name ?? humanize(item.item_type)}
                  </div>
                  {place && localAddress(place.metadata) ? (
                    <div className="address-local">{localAddress(place.metadata)}</div>
                  ) : null}
                  {reservations.map((reservation) => (
                    <div className="sub" key={reservation.id}>
                      {reservation.provider ?? "Reservation"}
                      {reservation.confirmation_code ? (
                        <>
                          {" · "}
                          <span className="code">{reservation.confirmation_code}</span>
                        </>
                      ) : null}
                    </div>
                  ))}
                  {item.notes ? <div className="notes">{item.notes}</div> : null}
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <div className="empty">Nothing scheduled on this day.</div>
      )}

      {notes.length ? (
        <section className="card">
          <div className="eyebrow">Journal</div>
          {notes.map((entry) => (
            <div key={entry.id} style={{ marginTop: 8 }}>
              <div className="meta">{localTime(entry.captured_at, zone)}</div>
              {/* raw_note verbatim, never the generated summary — the same rule the server keeps. */}
              <div className="notes">{entry.raw_note}</div>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
