import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SkeletonList, Toast, ViewMessage, WorkingPill, type ToastState } from "./components/states";
import { JournalView } from "./views/Journal";
import { PlacesView, type PlaceFilter, type PlaceGrouping } from "./views/Places";
import { PlanView } from "./views/Plan";
import { RecommendationsView } from "./views/Recommendations";
import { TodayView } from "./views/Today";
import { browserZone, dateLabel, humanize, joinMeta, resolveZone, zoneLabel } from "../../shared/format";
import { ZoneProvider } from "./zone";
import {
  app, callTool, defaultViewForTripStatus, loadJournal, loadPlaces, loadPlan,
  loadRecommendations, loadSnapshot, loadTripShell, NoTripError, parseToolJson, sendClaudeMessage,
} from "./mcp";
import { TOOL } from "./tool-contract";
import type {
  DashboardSnapshot, JournalOverview, LauncherContext, PlacesOverview, PlanOverview,
  RecommendationsOverview, SavedPlace, TimelineItem, TripSummary, TripView,
} from "./types";
import "./styles.css";

const NAV: { key: TripView; label: string; short: string }[] = [
  { key: "today", label: "Today", short: "Today" }, { key: "plan", label: "Plan", short: "Plan" },
  { key: "places", label: "Places", short: "Places" }, { key: "journal", label: "Journal", short: "Journal" },
  { key: "recommendations", label: "Recommendations", short: "Recs" },
];
const SKELETON_LABEL: Record<TripView, string> = {
  today: "Timeline", plan: "Plan", places: "Places", journal: "Journal", recommendations: "Recommendations",
};

const messageFor = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const tripDates = (trip?: TripSummary | null) => trip?.start_date || trip?.end_date
  ? `${dateLabel(trip.start_date)}${trip.start_date && trip.end_date ? " – " : ""}${dateLabel(trip.end_date, true)}`
  : "Dates not set";
/** Only worth saying when the trip is on a different clock from the reader — at home it is noise. */
const zoneNote = (zone: string) => zone === browserZone() ? "" : `Times in ${zoneLabel(zone)}`;

interface Busy { key: string; label: string; }
interface SavedResult { detail: string; undo?: { detail: string; run: () => Promise<unknown> }; }

export default function TravelDashboard() {
  const [launcher, setLauncher] = useState<LauncherContext>({});
  const [tab, setTab] = useState<TripView>("today");
  const [trip, setTrip] = useState<TripSummary | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [plan, setPlan] = useState<PlanOverview | null>(null);
  const [places, setPlaces] = useState<PlacesOverview | null>(null);
  const [journal, setJournal] = useState<JournalOverview | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationsOverview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noTrip, setNoTrip] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  // Places view: search, area, status and grouping are all client-side over the loaded array.
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>("all");
  const [group, setGroup] = useState<PlaceGrouping>("category");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const load = useCallback(async (context: LauncherContext, requested?: TripView) => {
    setLoading(true); setLoadError(null); setNoTrip(false);
    try {
      const shell = await loadTripShell(context);
      const view = requested ?? context.view ?? defaultViewForTripStatus(shell.trip.status);
      const resolved = { ...context, trip_id: shell.tripId, view };
      setLauncher(resolved); setTrip(shell.trip); setTab(view);
      if (view === "today") {
        const data = await loadSnapshot(resolved, shell); setSnapshot(data);
        setLauncher((current) => ({ ...current, date: data.date })); setConfirming(false);
      } else if (view === "plan") {
        const data = await loadPlan(shell); setPlan(data);
        const available = new Set(data.unscheduled_places.map((place) => place.id));
        setSelected((current) => current.filter((id) => available.has(id)));
      } else if (view === "places") setPlaces(await loadPlaces(shell));
      else if (view === "journal") setJournal(await loadJournal(shell));
      else setRecommendations(await loadRecommendations(shell));
    } catch (cause) {
      if (cause instanceof NoTripError) setNoTrip(true);
      else setLoadError(messageFor(cause, "Could not load Travel Brain."));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const receive = (result: any) => {
      const context = parseToolJson(result)?.dashboard;
      if (context && typeof context === "object") void load(context);
    };
    app.addEventListener("toolresult", receive);
    void app.connect().catch((cause) => { setLoadError(messageFor(cause, "Could not connect the dashboard.")); setLoading(false); });
    return () => app.removeEventListener("toolresult", receive);
  }, [load]);

  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const prompt = (instruction: string) => `${trip ? `Trip: “${trip.title}” (trip_id: ${trip.id}).` : "Use the current Travel Brain trip."} ${instruction}`;

  /** Direct writes report Saved (with Undo where there is a previous state) or Not saved (with Retry). */
  const direct = (key: string, label: string, run: () => Promise<unknown>, saved: SavedResult) => {
    const attempt = async () => {
      setBusy({ key, label }); setToast(null);
      try {
        await run();
        setToast({
          kind: "success", title: "Saved", detail: saved.detail,
          action: saved.undo ? { label: "Undo", onPick: () => direct(`${key}-undo`, "Undoing…", saved.undo!.run, { detail: saved.undo!.detail }) } : undefined,
        });
        await load(launcher, tab);
      } catch (cause) {
        setToast({ kind: "error", title: "Not saved", detail: messageFor(cause, "Travel Brain could not save that change."), action: { label: "Retry", onPick: () => void attempt() } });
      } finally { setBusy(null); }
    };
    void attempt();
  };

  /** Anything phrased as "Ask Claude…" only sends a message; it never mutates Travel Brain. */
  const ask = (key: string, label: string, instruction: string) => {
    const attempt = async () => {
      setBusy({ key, label }); setToast(null);
      try {
        await sendClaudeMessage(prompt(instruction));
        setToast({ kind: "success", title: "Sent to Claude", detail: "Review and reply in the conversation." });
      } catch (cause) {
        setToast({ kind: "error", title: "Not sent", detail: messageFor(cause, "Could not send that request to Claude."), action: { label: "Retry", onPick: () => void attempt() } });
      } finally { setBusy(null); }
    };
    void attempt();
  };

  const changeTab = (view: TripView) => { setTab(view); void load({ ...launcher, view }, view); };
  const changeDate = (date: string) => { if (date) void load({ ...launcher, view: "today", date }, "today"); };
  const openDay = (date: string) => { setTab("today"); void load({ ...launcher, view: "today", date }, "today"); };
  const updateStatus = (item: TimelineItem, status: "completed" | "skipped") => direct(
    `${status}-${item.id}`,
    status === "completed" ? `Marking “${item.title}” done…` : `Skipping “${item.title}”…`,
    () => callTool(TOOL.updateItineraryItem, { itinerary_item_id: item.id, status, ...(status === "completed" ? { actual_end: new Date().toISOString() } : {}) }),
    {
      detail: status === "completed" ? `${item.title} marked done.` : `${item.title} skipped.`,
      undo: { detail: `${item.title} restored.`, run: () => callTool(TOOL.updateItineraryItem, { itinerary_item_id: item.id, status: item.status ?? "planned" }) },
    },
  );
  /** Planning removals delete the row; the server refuses anything with recorded history. */
  const removeItem = (item: TimelineItem) => direct(
    `remove-${item.id}`,
    `Removing “${item.title}”…`,
    async () => {
      const result = await callTool<{ error_code?: string; message?: string }>(TOOL.removeItineraryItem, { itinerary_item_id: item.id });
      if (result?.error_code) throw new Error(result.message ?? "Travel Brain kept this item.");
      return result;
    },
    { detail: `${item.title} removed from the plan.` },
  );
  const togglePlace = (place: SavedPlace) => setSelected((current) => current.includes(place.id) ? current.filter((id) => id !== place.id) : [...current, place.id]);
  const fitPlaces = () => {
    const chosen = plan?.unscheduled_places.filter((place) => selected.includes(place.id)) ?? [];
    if (chosen.length) ask("fit-places", "Asking Claude where these fit…", `Find good itinerary slots for ${chosen.map((place) => `${place.name} (${place.id})`).join(", ")}. Preserve fixed commitments, cluster sensibly, and prepare a reviewable proposal without committing it.`);
  };
  const clearPlaceFilters = () => { setQuery(""); setCity("all"); setPlaceFilter("all"); };

  const issueCount = plan?.issues.length ?? 0;
  const zone = useMemo(() => resolveZone(trip?.timezone ?? snapshot?.timezone), [trip?.timezone, snapshot?.timezone]);

  return <ZoneProvider zone={zone}><main className="dashboard" aria-busy={loading}>
    <header className="shell-header">
      <div>
        <h1>{trip?.title ?? "Your travel dashboard"}</h1>
        <p className="shell-meta">{trip
          ? joinMeta(humanize(trip.status ?? ""), tripDates(trip), trip.destination_summary ?? "", zoneNote(zone))
          : "Plan, travel, remember, and recommend in one place."}</p>
      </div>
      <button type="button" className="icon-button" aria-label="Refresh current view" disabled={loading || noTrip} onClick={() => void load(launcher, tab)}>↻</button>
    </header>

    {noTrip ? null : <nav className="tabs" aria-label="Travel Brain views">
      {NAV.map((item) => <button
        type="button"
        key={item.key}
        className={tab === item.key ? "active" : ""}
        aria-current={tab === item.key ? "page" : undefined}
        onClick={() => changeTab(item.key)}
      >
        <span className="tab-full">{item.label}</span><span className="tab-short">{item.short}</span>
        {item.key === "plan" && issueCount ? <span className="tab-badge">{issueCount}</span> : null}
      </button>)}
    </nav>}

    {noTrip ? <div className="view">
      <ViewMessage title="No trip to show yet" detail="The dashboard opens against one trip. Ask Claude to create a trip, or name an existing one, and it’ll open here.">
        <button type="button" className="button primary" onClick={() => ask("start-trip", "Asking Claude to start a trip…", "Create a Travel Brain trip with me, then open this dashboard against it.")}>Start a trip with Claude</button>
      </ViewMessage>
    </div>
    : loadError ? <div className="view">
      <ViewMessage title="Travel Brain didn’t answer" detail="The dashboard couldn’t reach the server. Nothing was changed." detailBlock={loadError}>
        <button type="button" className="button primary" disabled={loading} onClick={() => void load(launcher, tab)}>Try again</button>
        <button type="button" className="button" onClick={() => ask("diagnose", "Asking Claude what happened…", `The dashboard failed to load with: ${loadError}. Explain what happened and what to try.`)}>Ask Claude what happened</button>
      </ViewMessage>
    </div>
    : loading ? <div className="view"><SkeletonList label={SKELETON_LABEL[tab]} /></div>
    : tab === "today" && snapshot ? <TodayView
        snapshot={snapshot}
        trip={trip}
        busy={busy?.key ?? null}
        confirming={confirming}
        onConfirm={setConfirming}
        onCommit={() => direct("commit", "Applying the approved change…", () => callTool(TOOL.commitItineraryChange, { proposal_id: snapshot.pending_proposal?.id }), { detail: "Approved change applied." })}
        onChangeDate={changeDate}
        onStatus={updateStatus}
        ask={ask}
      />
    : tab === "plan" && plan ? <PlanView plan={plan} selected={selected} busy={busy?.key ?? null} onToggle={togglePlace} onFitPlaces={fitPlaces} onOpenDay={openDay} onRemove={removeItem} ask={ask} />
    : tab === "places" && places ? <PlacesView
        places={places.places}
        query={query} city={city} status={placeFilter} group={group} openGroups={openGroups}
        busy={busy?.key ?? null}
        onQuery={setQuery} onCity={setCity} onStatus={setPlaceFilter} onGroup={setGroup}
        onToggleGroup={(key) => setOpenGroups((current) => ({ ...current, [key]: current[key] === false }))}
        onClear={clearPlaceFilters}
        ask={ask}
      />
    : tab === "journal" && journal ? <JournalView journal={journal} ask={ask} />
    : tab === "recommendations" && recommendations ? <RecommendationsView recommendations={recommendations} ask={ask} />
    : <div className="view"><SkeletonList label={SKELETON_LABEL[tab]} /></div>}

    {busy ? <WorkingPill label={busy.label} /> : null}
    {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
  </main></ZoneProvider>;
}
