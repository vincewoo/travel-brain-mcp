import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, SkeletonList } from "./components/states";
import { browserZone, dateLabel, humanize, joinMeta, zoneLabel } from "../../shared/format";
import { relatedIssues } from "../../shared/timeline";
import {
  journalEntries,
  nearbyCards,
  placeCards,
  placeIndex,
  planView,
  position,
  recommendationCards,
  tripDays,
} from "./derive";
import { relativeSince } from "./format";
import {
  beginSignIn,
  completeSignIn,
  loadCachedSnapshot,
  SignInRequiredError,
  sync,
  UnauthorizedError,
} from "./mcp";
import { forgetDevice } from "./store";
import type { Snapshot, Tab } from "./types";
import { CardView } from "./views/Card";
import { JournalView } from "./views/Journal";
import { NowView } from "./views/Now";
import { PlacesView, type PlaceFilter, type PlaceGrouping } from "./views/Places";
import { PlanView } from "./views/Plan";

const TABS: { key: Tab; label: string }[] = [
  { key: "now", label: "Now" },
  { key: "plan", label: "Plan" },
  { key: "places", label: "Places" },
  { key: "journal", label: "Journal" },
  { key: "card", label: "Card" },
];
const SKELETON_LABEL: Record<Tab, string> = {
  now: "Timeline", plan: "Plan", places: "Places", journal: "Journal", card: "Card",
};

/** Long enough that a cached plan is not mistaken for a live one; short enough not to nag. */
const STALE_AFTER_MINUTES = 180;

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;

const tripDates = (snapshot: Snapshot) => snapshot.trip.start_date || snapshot.trip.end_date
  ? `${dateLabel(snapshot.trip.start_date)}${snapshot.trip.start_date && snapshot.trip.end_date ? " – " : ""}${dateLabel(snapshot.trip.end_date, true)}`
  : "Dates not set";
/** Only worth saying when the trip is on a different clock from the reader — at home it is noise. */
const zoneNote = (zone: string) => zone === browserZone() ? "" : `Times in ${zoneLabel(zone)}`;

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("now");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [devicePoint, setDevicePoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [installHint, setInstallHint] = useState(false);
  // Places view: search, area, status and grouping are all client-side over the cached rows.
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>("all");
  const [group, setGroup] = useState<PlaceGrouping>("category");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async (tripId?: string) => {
    setSyncing(true);
    setError(null);
    try {
      const result = await sync(tripId);
      setSnapshot(result.snapshot);
      setSyncedAt(result.syncedAt);
      setSignedOut(false);
    } catch (caught) {
      // A missing or rejected session blocks syncing and nothing else: the cache still renders,
      // and the traveller decides when to sign in again rather than being redirected mid-trip.
      if (caught instanceof SignInRequiredError || caught instanceof UnauthorizedError) {
        setSignedOut(true);
      } else {
        setError(caught instanceof Error ? caught.message : "Sync failed.");
      }
    } finally {
      setSyncing(false);
    }
  }, []);

  // Boot: cache first, always. Reading what is already on the phone never waits on the network,
  // and never waits on a token — that is the entire promise of the app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (location.pathname === "/app/callback") {
        try {
          await completeSignIn(new URLSearchParams(location.search));
        } catch (caught) {
          if (!cancelled) setError(caught instanceof Error ? caught.message : "Sign-in failed.");
        }
        history.replaceState(null, "", "/app/");
      }
      const cached = await loadCachedSnapshot();
      if (cancelled) return;
      if (cached.snapshot) {
        setSnapshot(cached.snapshot);
        setSyncedAt(cached.syncedAt);
      }
      setLoading(false);
      setInstallHint(!isStandalone());
      if (navigator.onLine) await refresh();
      else if (!cached.snapshot) setSignedOut(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void refresh();
    };
    const goOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void refresh();
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    const tick = window.setInterval(() => setClock(new Date()), 30_000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(tick);
    };
  }, [refresh]);

  const days = useMemo(() => (snapshot ? tripDays(snapshot) : []), [snapshot]);
  // Hooks run before the "no snapshot yet" return below, so these have to tolerate an empty cache.
  const here = useMemo(
    () =>
      snapshot
        ? position(snapshot, clock)
        : { now: null, next: null, then: null, localDate: "", localTime: "" },
    [snapshot, clock]
  );
  const places = useMemo(() => (snapshot ? placeIndex(snapshot) : new Map()), [snapshot]);
  const items = useMemo(
    () => new Map((snapshot?.itinerary ?? []).map((item) => [item.id, item])),
    [snapshot]
  );
  const plan = useMemo(() => (snapshot ? planView(snapshot, clock) : null), [snapshot, clock]);
  const journal = useMemo(() => (snapshot ? journalEntries(snapshot) : []), [snapshot]);
  const recommendations = useMemo(() => (snapshot ? recommendationCards(snapshot) : []), [snapshot]);

  // The device's own GPS when the traveller offers it, otherwise the last position Travel Brain
  // knows about — labelled, never silently substituted.
  const origin = useMemo(() => {
    if (devicePoint) return devicePoint;
    const stored = snapshot?.location;
    if (stored?.status === "fresh" && stored.latitude != null && stored.longitude != null) {
      return { latitude: stored.latitude, longitude: stored.longitude };
    }
    return null;
  }, [devicePoint, snapshot]);

  const cards = useMemo(() => (snapshot ? placeCards(snapshot, origin) : []), [snapshot, origin]);
  const nearby = useMemo(() => (origin ? nearbyCards(cards) : []), [cards, origin]);

  useEffect(() => {
    if (snapshot && !selectedDate) setSelectedDate(here.localDate);
  }, [snapshot, selectedDate, here.localDate]);

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (found) => setDevicePoint({ latitude: found.coords.latitude, longitude: found.coords.longitude }),
      () => setError("Location is unavailable on this device."),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 }
    );
  };

  if (loading) {
    return (
      <div className="app">
        <div className="view">
          <SkeletonList label="Your trip" />
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="centre">
        <div>
          <h1>Travel Brain</h1>
          <p>
            Sign in once while you have a connection. After that the trip stays on this phone and
            opens with no signal at all.
          </p>
          <div className="button-row">
            <button type="button" className="button primary" onClick={() => void beginSignIn()}>
              Sign in
            </button>
          </div>
          {error ? <p>{error}</p> : null}
          {!online ? <p>No connection — the first sign-in needs one.</p> : null}
        </div>
      </div>
    );
  }

  const staleMinutes = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) / 60_000 : Infinity;
  const stale = staleMinutes > STALE_AFTER_MINUTES;
  const selected = selectedDate ?? here.localDate;
  const todayIssues = plan ? relatedIssues(here.localDate, plan.days.find((day) => day.date === here.localDate)?.items ?? [], plan.issues) : [];

  return (
    <div className="app">
      <header className="shell-header">
        <div>
          <h1>{snapshot.trip.title}</h1>
          <p className="shell-meta">{joinMeta(
            humanize(snapshot.trip.status),
            tripDates(snapshot),
            snapshot.trip.destination_summary ?? "",
            zoneNote(snapshot.trip.timezone),
          )}</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Sync now"
            disabled={syncing || !online}
            onClick={() => void refresh()}
          >
            {syncing ? "…" : "↻"}
          </button>
        </div>
      </header>

      <div className="sync-row">
        <span className={`pill${stale ? " warning" : ""}`}>Synced {relativeSince(syncedAt)}</span>
        {!online ? <span className="pill warning">Offline</span> : null}
        {!origin ? <span className="pill">No position</span> : null}
        <span className="spacer" />
        {!origin ? (
          <button type="button" className="button" onClick={locate}>
            Locate
          </button>
        ) : null}
      </div>

      <nav className="nav" aria-label="Travel Brain views">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className={tab === entry.key ? "active" : ""}
            aria-current={tab === entry.key ? "page" : undefined}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main>
        {signedOut || error || installHint ? (
          <div className="view banners">
            {signedOut ? (
              <Banner tone="warning">
                Signed out — the cached trip still reads, but it will not refresh.
                <button type="button" className="button" onClick={() => void beginSignIn()}>
                  Sign in again
                </button>
              </Banner>
            ) : null}
            {error ? <Banner tone="danger">{error}</Banner> : null}
            {installHint ? (
              <Banner>
                Add this to your Home Screen. Installed, it keeps the trip cached; left in a browser
                tab, iOS may clear it after a week unused.
                <button type="button" className="button" onClick={() => setInstallHint(false)}>
                  Got it
                </button>
              </Banner>
            ) : null}
          </div>
        ) : null}

        {tab === "now" ? (
          <NowView
            snapshot={snapshot}
            position={here}
            places={places}
            nearby={nearby}
            issues={todayIssues}
            clock={clock}
          />
        ) : null}
        {tab === "plan" ? (
          plan ? (
            <PlanView
              snapshot={snapshot}
              plan={plan}
              cards={cards}
              days={days}
              selected={selected}
              today={here.localDate}
              places={places}
              onSelect={setSelectedDate}
            />
          ) : (
            <div className="view"><SkeletonList label={SKELETON_LABEL.plan} /></div>
          )
        ) : null}
        {tab === "places" ? (
          <PlacesView
            cards={cards}
            query={query}
            city={city}
            status={placeFilter}
            group={group}
            openGroups={openGroups}
            onQuery={setQuery}
            onCity={setCity}
            onStatus={setPlaceFilter}
            onGroup={setGroup}
            onToggleGroup={(key) => setOpenGroups((current) => ({ ...current, [key]: current[key] === false }))}
            onClear={() => { setQuery(""); setCity("all"); setPlaceFilter("all"); }}
          />
        ) : null}
        {tab === "journal" ? (
          <JournalView
            snapshot={snapshot}
            entries={journal}
            recommendations={recommendations}
            places={places}
            items={items}
          />
        ) : null}
        {tab === "card" ? (
          <CardView
            snapshot={snapshot}
            places={places}
            onForget={() => {
              void forgetDevice().then(() => location.reload());
            }}
          />
        ) : null}
      </main>
    </div>
  );
}
