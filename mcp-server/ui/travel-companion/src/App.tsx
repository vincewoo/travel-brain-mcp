import { useCallback, useEffect, useMemo, useState } from "react";
import { nearbyCards, placeCards, placeIndex, position, tripDays } from "./derive";
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
import { DayView } from "./views/Day";
import { NowView } from "./views/Now";
import { PlacesView } from "./views/Places";

const TABS: { key: Tab; label: string }[] = [
  { key: "now", label: "Now" },
  { key: "day", label: "Plan" },
  { key: "places", label: "Places" },
  { key: "card", label: "Card" },
];

/** Long enough that a cached plan is not mistaken for a live one; short enough not to nag. */
const STALE_AFTER_MINUTES = 180;

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;

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
  // Hooks run before the "no snapshot yet" return below, so this has to tolerate an empty cache.
  const here = useMemo(
    () =>
      snapshot
        ? position(snapshot, clock)
        : { now: null, next: null, then: null, localDate: "", localTime: "" },
    [snapshot, clock]
  );
  const places = useMemo(() => (snapshot ? placeIndex(snapshot) : new Map()), [snapshot]);

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
      <div className="centre">
        <p>Opening your trip…</p>
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
          <div style={{ marginTop: 16 }}>
            <button type="button" className="button primary" onClick={() => void beginSignIn()}>
              Sign in
            </button>
          </div>
          {error ? <div className="error">{error}</div> : null}
          {!online ? <div className="error">No connection — the first sign-in needs one.</div> : null}
        </div>
      </div>
    );
  }

  const staleMinutes = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) / 60_000 : Infinity;
  const stale = staleMinutes > STALE_AFTER_MINUTES;

  return (
    <div className="app">
      <header className="header">
        <h1>{snapshot.trip.title}</h1>
        <div className="sub">
          {here.localTime} · {snapshot.trip.timezone}
          {origin ? "" : " · no position"}
        </div>
        <div className="sync-row">
          <span className={`pill${stale ? " stale" : ""}`}>Synced {relativeSince(syncedAt)}</span>
          {!online ? <span className="pill offline">Offline</span> : null}
          <span className="spacer" />
          {!origin ? (
            <button type="button" className="button" onClick={locate}>
              Locate
            </button>
          ) : null}
          <button type="button" className="button" onClick={() => void refresh()} disabled={syncing || !online}>
            {syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
        {signedOut ? (
          <div className="error">
            Signed out.{" "}
            <button type="button" className="button" onClick={() => void beginSignIn()}>
              Sign in again
            </button>
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
      </header>

      <main>
        {installHint ? (
          <div className="alert">
            Add this to your Home Screen. Installed, it keeps the trip cached; left in a browser tab,
            iOS may clear it after a week unused.{" "}
            <button type="button" className="button" onClick={() => setInstallHint(false)}>
              Got it
            </button>
          </div>
        ) : null}

        {tab === "now" ? (
          <NowView
            snapshot={snapshot}
            position={here}
            places={places}
            nearby={nearby}
            onOpenDay={() => setTab("day")}
          />
        ) : null}
        {tab === "day" ? (
          <DayView
            snapshot={snapshot}
            days={days}
            selected={selectedDate ?? here.localDate}
            today={here.localDate}
            places={places}
            onSelect={setSelectedDate}
          />
        ) : null}
        {tab === "places" ? <PlacesView cards={cards} /> : null}
        {tab === "card" ? (
          <>
            <CardView snapshot={snapshot} places={places} />
            <section className="card">
              <div className="eyebrow">This device</div>
              <div className="meta">
                The whole trip, including journal notes, is stored on this phone so it works offline.
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void forgetDevice().then(() => location.reload());
                  }}
                >
                  Sign out and erase from this device
                </button>
              </div>
            </section>
          </>
        ) : null}
      </main>

      <nav className="nav">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className={tab === entry.key ? "selected" : ""}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
