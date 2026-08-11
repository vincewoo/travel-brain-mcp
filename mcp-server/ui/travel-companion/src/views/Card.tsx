import { localDate, localTime, referenceCards } from "../derive";
import { dayLabel, localAddress, mapLink } from "../format";
import type { Place, Snapshot } from "../types";

/**
 * The reference sheet: what you have to produce at a counter, and where you sleep tonight.
 * Confirmation codes are set large because they get read aloud and typed into other people's
 * terminals; lodging addresses carry their local-script form for the same reason.
 */
export function CardView({ snapshot, places }: { snapshot: Snapshot; places: Map<string, Place> }) {
  const zone = snapshot.trip.timezone;
  const { reservations, lodging } = referenceCards(snapshot);
  const dietary = snapshot.preferences.filter((memory) => memory.status !== "rejected");

  return (
    <>
      <section className="card">
        <div className="eyebrow">Trip</div>
        <h2 className="headline" style={{ fontSize: 20 }}>
          {snapshot.trip.title}
        </h2>
        <div className="meta">
          {snapshot.trip.destination_summary ?? ""}
          {snapshot.trip.start_date ? ` · ${dayLabel(snapshot.trip.start_date, zone)}` : ""}
          {snapshot.trip.end_date ? ` – ${dayLabel(snapshot.trip.end_date, zone)}` : ""}
        </div>
        <div className="meta">All times shown on {zone} time.</div>
      </section>

      {lodging.length ? (
        <section className="card">
          <div className="eyebrow">Staying</div>
          {lodging.map((place) => (
            <div key={place.id} style={{ marginBottom: 10 }}>
              <div className="title" style={{ fontWeight: 600 }}>
                {place.name}
              </div>
              {place.address ? <div className="address">{place.address}</div> : null}
              {localAddress(place.metadata) ? (
                <div className="address-local">{localAddress(place.metadata)}</div>
              ) : null}
              {mapLink(place) ? (
                <a className="link" href={mapLink(place)!}>
                  Open in maps
                </a>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="card">
        <div className="eyebrow">Reservations</div>
        {reservations.length ? (
          reservations.map((reservation) => {
            const place = reservation.place_id ? places.get(reservation.place_id) : undefined;
            const date = localDate(reservation.reserved_start, zone);
            return (
              <div key={reservation.id} style={{ marginTop: 12 }}>
                <div className="title" style={{ fontWeight: 600 }}>
                  {reservation.provider ?? place?.name ?? "Reservation"}
                </div>
                <div className="meta">
                  {date ? `${dayLabel(date, zone)} · ${localTime(reservation.reserved_start, zone)}` : "No time recorded"}
                  {reservation.party_size ? ` · party of ${reservation.party_size}` : ""}
                  {reservation.status ? ` · ${reservation.status}` : ""}
                </div>
                {reservation.confirmation_code ? (
                  <div className="code" style={{ marginTop: 4 }}>
                    {reservation.confirmation_code}
                  </div>
                ) : null}
                {place?.address ? <div className="address">{place.address}</div> : null}
                {place && localAddress(place.metadata) ? (
                  <div className="address-local">{localAddress(place.metadata)}</div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="meta">No reservations recorded.</div>
        )}
      </section>

      {dietary.length ? (
        <section className="card">
          <div className="eyebrow">Preferences and constraints</div>
          {dietary.map((memory) => (
            <div className="notes" key={memory.id}>
              {memory.content}
            </div>
          ))}
        </section>
      ) : null}

      {snapshot.lessons.length ? (
        <section className="card">
          <div className="eyebrow">Lessons from this trip</div>
          {snapshot.lessons.map((memory) => (
            <div className="notes" key={memory.id}>
              {memory.content}
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
