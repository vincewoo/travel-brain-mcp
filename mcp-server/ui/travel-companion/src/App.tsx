import { useCallback, useEffect, useMemo, useState } from "react";
import { CaptureSheet, type CaptureDraft } from "./components/CaptureSheet";
import { Banner, SkeletonList } from "./components/states";
import { SyncSheet } from "./components/SyncSheet";
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
  updateTripTask,
} from "./mcp";
import { discard, enqueue, flushOutbox, loadOutbox, retry, withPending } from "./outbox";
import { outboxSummary, pendingId } from "./outbox-queue.mjs";
import type { OutboxEntry } from "./outbox-queue.mjs";
import { forgetDevice, KEY, readValue, writeValue } from "./store";
import { applyTheme, readTheme, storeTheme, watchSystemTheme, type ThemeChoice } from "./theme";
import type { ItineraryItem, Snapshot, Tab, TripTask } from "./types";
import { CardView } from "./views/Card";
import { JournalView } from "./views/Journal";
import { NowView } from "./views/Now";
import { PlacesView, type PlaceFilter, type PlaceGrouping, type PlacesMode } from "./views/Places";
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
const taskOrder = (left: TripTask, right: TripTask) => {
  const completion = Number(Boolean(left.completed_at)) - Number(Boolean(right.completed_at));
  if (completion) return completion;
  if (left.completed_at && right.completed_at) {
    return right.completed_at.localeCompare(left.completed_at);
  }
  const due = (left.due_date ?? "9999-12-31").localeCompare(right.due_date ?? "9999-12-31");
  return due || left.created_at.localeCompare(right.created_at);
};

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("now");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [taskBusy, setTaskBusy] = useState<string | null>(null);
  // The capture queue, and the two sheets that let the traveller write into it and read it back.
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
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
  const [placesMode, setPlacesMode] = useState<PlacesMode>("list");
  // Consent to fetch basemap tiles. Starts false on every boot and is corrected from IndexedDB
  // below, so a map never loads tiles before the stored answer has been read.
  const [mapsEnabled, setMapsEnabled] = useState(false);
  // Appearance, read synchronously because the inline script in `index.html` has already applied it
  // — this is the same answer, in a form React can render the Card tab's control from.
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  /**
   * Replay what is queued against the trip as it is now.
   *
   * The snapshot passed in is what the conflict rules are checked against, which is why this runs
   * after a sync rather than before one: an item Claude deleted while the phone was dark is an item
   * missing from the fresh snapshot, and a status update for it is parked with its words intact
   * instead of being thrown five times at a server that will never accept it.
   */
  const drain = useCallback(async (base: Snapshot | null) => {
    try {
      const result = await flushOutbox(base);
      setOutbox(result.entries);
      return result.changed;
    } catch (caught) {
      if (caught instanceof SignInRequiredError || caught instanceof UnauthorizedError) setSignedOut(true);
      else setError(caught instanceof Error ? caught.message : "Queued writes could not be sent.");
      setOutbox(await loadOutbox());
      return false;
    }
  }, []);

  const refresh = useCallback(async (tripId?: string) => {
    setSyncing(true);
    setError(null);
    try {
      const result = await sync(tripId);
      setSnapshot(result.snapshot);
      setSyncedAt(result.syncedAt);
      setSignedOut(false);
      // A second read, only when something actually landed: the rows the server wrote replace the
      // optimistic ones this phone has been showing, rather than both being on screen at once.
      if (await drain(result.snapshot)) {
        const settled = await sync(tripId);
        setSnapshot(settled.snapshot);
        setSyncedAt(settled.syncedAt);
      }
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
  }, [drain]);

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
      setMapsEnabled((await readValue<boolean>(KEY.mapsEnabled)) === true);
      // The queue is read before the first paint for the same reason the cache is: a note captured
      // in a tunnel yesterday has to be on screen when the app opens today, sent or not.
      setOutbox(await loadOutbox());
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

  // Re-applied on every change rather than only on the traveller's tap, so a phone that flips to
  // dark at sunset carries the status bar with it while the choice is still "System".
  useEffect(() => {
    applyTheme(theme);
    return theme === "system" ? watchSystemTheme(() => applyTheme("system")) : undefined;
  }, [theme]);

  /**
   * The trip as this phone sees it: what Travel Brain sent, plus every capture still queued on the
   * device. Every derivation below reads this rather than the raw snapshot, so a note written in a
   * tunnel is in the journal, a place saved on a hillside is in Places, and an item marked done is
   * done — immediately, and consistently across the tabs, rather than at the next sync.
   */
  const view = useMemo(() => (snapshot ? withPending(snapshot, outbox) : null), [snapshot, outbox]);
  const queue = useMemo(() => outboxSummary(outbox), [outbox]);
  const visitedPlaces = useMemo(
    () => new Set((view?.visits ?? []).map((visit) => visit.place_id)),
    [view]
  );

  const days = useMemo(() => (view ? tripDays(view) : []), [view]);
  // Hooks run before the "no snapshot yet" return below, so these have to tolerate an empty cache.
  const here = useMemo(
    () =>
      view
        ? position(view, clock)
        : { now: null, next: null, then: null, localDate: "", localTime: "" },
    [view, clock]
  );
  const places = useMemo(() => (view ? placeIndex(view) : new Map()), [view]);
  const items = useMemo(
    () => new Map((view?.itinerary ?? []).map((item) => [item.id, item])),
    [view]
  );
  const plan = useMemo(() => (view ? planView(view, clock) : null), [view, clock]);
  const journal = useMemo(() => (view ? journalEntries(view) : []), [view]);
  const recommendations = useMemo(() => (view ? recommendationCards(view) : []), [view]);

  // The device's own GPS when the traveller offers it, otherwise the last position Travel Brain
  // knows about — labelled, never silently substituted.
  const origin = useMemo(() => {
    if (devicePoint) return devicePoint;
    const stored = view?.location;
    if (stored?.status === "fresh" && stored.latitude != null && stored.longitude != null) {
      return { latitude: stored.latitude, longitude: stored.longitude };
    }
    return null;
  }, [devicePoint, view]);

  const cards = useMemo(() => (view ? placeCards(view, origin) : []), [view, origin]);
  const nearby = useMemo(() => (origin ? nearbyCards(cards) : []), [cards, origin]);

  useEffect(() => {
    if (view && !selectedDate) setSelectedDate(here.localDate);
  }, [view, selectedDate, here.localDate]);

  // Asked once, in `MapPanel`, and remembered. Writing through to IndexedDB rather than keeping it
  // in state alone is the point: being asked again on every launch would train the traveller to tap
  // yes without reading it.
  const enableMaps = () => {
    setMapsEnabled(true);
    void writeValue(KEY.mapsEnabled, true);
  };

  const chooseTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    storeTheme(choice);
  };

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (found) => setDevicePoint({ latitude: found.coords.latitude, longitude: found.coords.longitude }),
      () => setError("Location is unavailable on this device."),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 }
    );
  };

  const toggleTask = async (task: TripTask, completed: boolean) => {
    if (!snapshot || !online) {
      setError("Reconnect to update planning tasks.");
      return;
    }
    setTaskBusy(task.id);
    setError(null);
    try {
      const saved = await updateTripTask(task.id, completed);
      const tasks = (snapshot.tasks ?? [])
        .map((entry) => entry.id === saved.id ? saved : entry)
        .sort(taskOrder);
      const next = { ...snapshot, tasks };
      setSnapshot(next);
      await writeValue(KEY.snapshot, next);
    } catch (caught) {
      if (caught instanceof SignInRequiredError || caught instanceof UnauthorizedError) setSignedOut(true);
      else setError(caught instanceof Error ? caught.message : "Task update failed.");
    } finally {
      setTaskBusy(null);
    }
  };

  /**
   * Capture something, offline or not.
   *
   * The write goes to disk before it is shown and is sent immediately when there is a signal, which
   * is the same path in both cases — there is no separate "online" capture to keep in step. Saving a
   * place with a note about it queues two operations rather than one: the place, and a journal note
   * pointing at the local id it will carry until `add_place` answers with a real one.
   */
  const capture = async (draft: CaptureDraft) => {
    if (!snapshot) return;
    const trip_id = snapshot.trip.id;
    const captured_at = new Date().toISOString();
    const text = draft.text.trim();
    setCapturing(true);
    setError(null);
    try {
      if (draft.mode === "note") {
        await enqueue("journal_note", {
          trip_id,
          raw_note: text,
          captured_at,
          reaction: draft.reaction.trim() || undefined,
          itinerary_item_id: draft.attachItemId || undefined,
          place_id: draft.placeId || undefined,
          latitude: origin?.latitude,
          longitude: origin?.longitude,
        });
      } else if (draft.mode === "visit") {
        await enqueue("place_visit", {
          trip_id,
          place_id: draft.placeId,
          // Only when the item in progress is this very place: a visit attached to the wrong item
          // would complete something the traveller never did.
          itinerary_item_id: here.now?.place_id === draft.placeId ? here.now.id : undefined,
          departed_at: captured_at,
          rating: draft.rating ?? undefined,
          would_return: draft.wouldReturn ?? undefined,
          notes: text || undefined,
          place_name: places.get(draft.placeId)?.name,
        });
      } else if (draft.mode === "place") {
        const local_id = pendingId();
        await enqueue("new_place", {
          trip_id,
          local_id,
          name: draft.name.trim(),
          category: draft.category.trim() || undefined,
          address: draft.address.trim() || undefined,
          latitude: draft.usePosition ? origin?.latitude : undefined,
          longitude: draft.usePosition ? origin?.longitude : undefined,
          // The phone's own fix is the one point this app can honestly call surveyed.
          coordinate_source: draft.usePosition && origin ? "provided" : undefined,
          trip_status: "shortlist",
        });
        if (text) await enqueue("journal_note", { trip_id, place_id: local_id, raw_note: text, captured_at });
      } else {
        await enqueue("preference", { trip_id, content: text });
      }
      setOutbox(await loadOutbox());
      setCaptureOpen(false);
      if (online && (await drain(snapshot))) void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved on this device.");
    } finally {
      setCapturing(false);
    }
  };

  /**
   * Mark done or Skip. It records what happened and never touches the plan's own timing — the
   * planned-vs-actual distinction is the invariant, so completion carries an `actual_end` and
   * nothing invents an `actual_start` the traveller never gave.
   */
  const changeStatus = async (item: ItineraryItem, status: "completed" | "skipped") => {
    if (!snapshot) return;
    setBusyItemId(item.id);
    setError(null);
    try {
      await enqueue("itinerary_status", {
        trip_id: snapshot.trip.id,
        itinerary_item_id: item.id,
        status,
        title: item.title,
        ...(status === "completed" ? { actual_end: new Date().toISOString() } : {}),
      });
      setOutbox(await loadOutbox());
      if (online && (await drain(snapshot))) void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved on this device.");
    } finally {
      setBusyItemId(null);
    }
  };

  const retryEntry = async (entry: OutboxEntry) => {
    await retry(entry);
    setOutbox(await loadOutbox());
    if (online && (await drain(snapshot))) void refresh();
  };

  const discardEntry = async (entry: OutboxEntry) => {
    await discard(entry);
    setOutbox(await loadOutbox());
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

  if (!snapshot || !view) {
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
        {/* The whole sync state is one tap away rather than one more banner: what is waiting, what
            failed, and the writes the trip outran, all readable before anything is decided. */}
        <button type="button" className={`pill${stale ? " warning" : ""}`} onClick={() => setSyncOpen(true)}>
          Synced {relativeSince(syncedAt)}
        </button>
        {queue.queued ? <button type="button" className="pill" onClick={() => setSyncOpen(true)}>
          {queue.queued} to send
        </button> : null}
        {queue.attention ? <button type="button" className="pill warning" onClick={() => setSyncOpen(true)}>
          {queue.attention} needs attention
        </button> : null}
        {!online ? <span className="pill warning">Offline</span> : null}
        {!origin ? <span className="pill">No position</span> : null}
        <span className="spacer" />
        <button type="button" className="button" onClick={() => setCaptureOpen(true)}>Capture</button>
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
            snapshot={view}
            position={here}
            places={places}
            nearby={nearby}
            issues={todayIssues}
            clock={clock}
            origin={origin}
            offline={!online}
            mapsEnabled={mapsEnabled}
            busyItemId={busyItemId}
            onStatus={(item, status) => void changeStatus(item, status)}
            onCapture={() => setCaptureOpen(true)}
            onEnableMaps={enableMaps}
          />
        ) : null}
        {tab === "plan" ? (
          plan ? (
            <PlanView
              snapshot={view}
              plan={plan}
              days={days}
              selected={selected}
              today={here.localDate}
              places={places}
              online={online && !signedOut}
              taskBusy={taskBusy}
              busyItemId={busyItemId}
              onStatus={(item, status) => void changeStatus(item, status)}
              onTaskToggle={(task, completed) => void toggleTask(task, completed)}
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
            origin={origin}
            mode={placesMode}
            offline={!online}
            mapsEnabled={mapsEnabled}
            onMode={setPlacesMode}
            onEnableMaps={enableMaps}
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
            snapshot={view}
            entries={journal}
            recommendations={recommendations}
            places={places}
            items={items}
            onCapture={() => setCaptureOpen(true)}
          />
        ) : null}
        {tab === "card" ? (
          <CardView
            snapshot={view}
            places={places}
            origin={origin}
            offline={!online}
            mapsEnabled={mapsEnabled}
            theme={theme}
            onTheme={chooseTheme}
            onEnableMaps={enableMaps}
            onDisableMaps={() => {
              setMapsEnabled(false);
              void writeValue(KEY.mapsEnabled, false);
            }}
            onForget={() => {
              void forgetDevice().then(() => location.reload());
            }}
          />
        ) : null}
      </main>

      {captureOpen ? <CaptureSheet
        snapshot={view}
        position={here}
        origin={origin}
        visited={visitedPlaces}
        busy={capturing}
        offline={!online}
        onCapture={(draft) => void capture(draft)}
        onClose={() => setCaptureOpen(false)}
        onLocate={locate}
      /> : null}

      {syncOpen ? <SyncSheet
        entries={outbox}
        syncedAt={syncedAt}
        online={online}
        syncing={syncing}
        onSync={() => void refresh()}
        onRetry={(entry) => void retryEntry(entry)}
        onDiscard={(entry) => void discardEntry(entry)}
        onClose={() => setSyncOpen(false)}
      /> : null}
    </div>
  );
}
