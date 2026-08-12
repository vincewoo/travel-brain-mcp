import { MapPanel } from "../components/MapPanel";
import { NoteEmpty } from "../components/states";
import { dateLabel, dateTimeLabel, humanize, joinMeta, plural, zoneLabel } from "../../../shared/format";
import { MapLinks } from "../components/rows";
import { referenceCards } from "../derive";
import { localAddress } from "../format";
import { THEME_CHOICES, type ThemeChoice } from "../theme";
import type { Origin, Place, Snapshot } from "../types";

/**
 * How many lodging addresses get a real map. A tile map holds a WebGL context and browsers cap how
 * many can exist at once, so the number on screen has to stay countable — everything past this
 * still gets its address, its local-script address and its links.
 */
const MAPPED_LODGING = 3;

/**
 * The reference sheet: what you have to produce at a counter, and where you sleep tonight.
 * Confirmation codes are set large because they get read aloud and typed into other people's
 * terminals; lodging addresses carry their local-script form for the same reason.
 */
export function CardView({ snapshot, places, origin, offline, mapsEnabled, theme, onTheme, onEnableMaps, onDisableMaps, onForget }: {
  snapshot: Snapshot;
  places: Map<string, Place>;
  origin: Origin | null;
  offline: boolean;
  mapsEnabled: boolean;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onEnableMaps: () => void;
  onDisableMaps: () => void;
  onForget: () => void;
}) {
  const zone = snapshot.trip.timezone;
  const { reservations, lodging } = referenceCards(snapshot);
  const constraints = snapshot.preferences.filter((memory) => memory.status !== "rejected");

  const address = (place: Place | undefined) => {
    if (!place) return null;
    const local = localAddress(place.metadata);
    return <div className="detail">
      {place.address ? <div className="address">{place.address}</div> : null}
      {local ? <div className="address-local">{local}</div> : null}
      <MapLinks place={place} origin={origin ?? undefined} />
    </div>;
  };

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Card</h2>
        <span className="view-count">Everything you might have to show someone</span>
      </div>
    </div>

    <section className="container">
      <div className="container-head"><strong>{snapshot.trip.title}</strong><span>{humanize(snapshot.trip.status)}</span></div>
      <div className="row">
        <p className="row-meta">{joinMeta(
          snapshot.trip.destination_summary ?? "",
          snapshot.trip.start_date ? `${dateLabel(snapshot.trip.start_date)} – ${dateLabel(snapshot.trip.end_date, true)}` : "",
        )}</p>
        <p className="row-note">All times shown on {zoneLabel(zone)} time.</p>
      </div>
    </section>

    {lodging.length ? <section className="container">
      <div className="container-head"><strong>Staying</strong><span>{plural(lodging.length, "address")}</span></div>
      {lodging.map((place, order) => <article className="row" key={place.id}>
        <div className="row-title-line"><strong>{place.name}</strong></div>
        {order < MAPPED_LODGING ? <MapPanel
          points={[{
            id: place.id,
            label: place.name,
            latitude: place.latitude,
            longitude: place.longitude,
            approximate: place.coordinate_source === "estimated",
          }]}
          origin={origin}
          height={160}
          interactive={false}
          offline={offline}
          enabled={mapsEnabled}
          onEnable={onEnableMaps}
        /> : null}
        {address(place)}
      </article>)}
    </section> : null}

    <section className="container">
      <div className="container-head"><strong>Reservations</strong><span>{plural(reservations.length, "booking")}</span></div>
      {reservations.length ? reservations.map((reservation) => {
        const place = reservation.place_id ? places.get(reservation.place_id) : undefined;
        return <article className="row" key={reservation.id}>
          <div className="row-title-line">
            <strong>{reservation.provider ?? place?.name ?? "Reservation"}</strong>
            <span className="row-aside">{humanize(reservation.status)}</span>
          </div>
          <p className="row-meta">{joinMeta(
            dateTimeLabel(reservation.reserved_start, zone),
            reservation.party_size ? `party of ${reservation.party_size}` : "",
          )}</p>
          <div className="detail">
            {reservation.confirmation_code ? <div className="code">{reservation.confirmation_code}</div> : null}
          </div>
          {address(place)}
        </article>;
      }) : <div className="row"><p className="row-meta">No reservations recorded.</p></div>}
    </section>

    {constraints.length ? <section className="container">
      <div className="container-head sunken"><strong>Preferences and constraints</strong><span>{plural(constraints.length, "note")}</span></div>
      {constraints.map((memory) => <div className="row" key={memory.id}>
        <p className="row-meta">{memory.content}</p>
      </div>)}
    </section> : null}

    {snapshot.lessons.length ? <section className="container">
      <div className="container-head sunken"><strong>Lessons from this trip</strong><span>{plural(snapshot.lessons.length, "lesson")}</span></div>
      {snapshot.lessons.map((memory) => <div className="row" key={memory.id}>
        <p className="row-meta">{memory.content}</p>
      </div>)}
    </section> : <NoteEmpty title="No lessons yet" detail="What this trip teaches gets written down as it happens." />}

    <section className="container">
      <div className="container-head"><strong>This device</strong></div>
      <div className="row">
        <p className="row-meta">
          Appearance follows the phone unless you say otherwise — worth overriding on a night train,
          or in sun bright enough that dark text on white is the only thing still readable.
        </p>
        <div className="row-actions">
          <div className="button-row" role="group" aria-label="Appearance">
            {THEME_CHOICES.map((choice) => <button
              key={choice.key}
              type="button"
              className={`seg${theme === choice.key ? " active" : ""}`}
              aria-pressed={theme === choice.key}
              onClick={() => onTheme(choice.key)}
            >{choice.label}</button>)}
          </div>
        </div>
      </div>
      <div className="row">
        <p className="row-meta">
          Basemap tiles come from OpenFreeMap. Loading them tells it which area you are looking at;
          with them off, maps still draw every position and distance from what is already on the
          phone.
        </p>
        <div className="row-actions">
          {mapsEnabled
            ? <button type="button" className="link-button quiet" onClick={onDisableMaps}>Turn off basemap tiles</button>
            : <button type="button" className="link-button" onClick={onEnableMaps}>Turn on basemap tiles</button>}
        </div>
      </div>
      <div className="row">
        <p className="row-meta">
          The whole trip, including journal notes, is stored on this phone so it works offline.
        </p>
        <div className="row-actions">
          <button type="button" className="button" onClick={onForget}>Sign out and erase from this device</button>
        </div>
      </div>
    </section>
  </div>;
}
