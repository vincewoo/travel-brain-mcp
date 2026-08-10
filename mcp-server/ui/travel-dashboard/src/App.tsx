import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ItineraryCard } from "./components/ItineraryCard";
import { PlaceCard } from "./components/PlaceCard";
import { dateLabel, dateTimeLabel, humanize, shiftDate, timeLabel } from "./format";
import {
  app, callTool, defaultViewForTripStatus, loadJournal, loadPlaces, loadPlan,
  loadRecommendations, loadSnapshot, loadTripShell, parseToolJson, sendClaudeMessage,
} from "./mcp";
import { TOOL } from "./tool-contract";
import type {
  DashboardSnapshot, JournalOverview, LauncherContext, PlanningDay, PlanningIssue,
  PlanOverview, PlacesOverview, RecommendationsOverview, SavedPlace, TimelineItem,
  TripSummary, TripView,
} from "./types";
import "./styles.css";

const NAV: { key: TripView; label: string }[] = [
  { key: "today", label: "Today" }, { key: "plan", label: "Plan" },
  { key: "places", label: "Places" }, { key: "journal", label: "Journal" },
  { key: "recommendations", label: "Recommendations" },
];
const PLACE_FILTERS = ["all", "candidate", "saved", "planned", "visited", "rejected"] as const;
type PlaceFilter = typeof PLACE_FILTERS[number];

const messageFor = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const tripDates = (trip?: TripSummary | null) => trip?.start_date || trip?.end_date
  ? `${dateLabel(trip.start_date)}${trip.start_date && trip.end_date ? " – " : ""}${dateLabel(trip.end_date, true)}`
  : "Dates not set";
const issueTone = (severity?: string) => ["info", "warning", "danger"].includes(severity ?? "") ? severity : "warning";

function Summary({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return <div className="summary-card"><span className="eyebrow">{label}</span><strong>{value}</strong>{detail ? <span>{detail}</span> : null}</div>;
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><b aria-hidden="true">·</b><h3>{title}</h3><p>{detail}</p></div>;
}
function Alert({ issue }: { issue: PlanningIssue }) {
  return <div className={`alert alert-${issueTone(issue.severity)}`}><i /><div><strong>{issue.title}</strong>{issue.detail ? <p>{issue.detail}</p> : null}</div>{issue.date ? <small>{dateLabel(issue.date)}</small> : null}</div>;
}
function relatedIssues(day: PlanningDay, issues: PlanningIssue[]) {
  const ids = new Set(day.items.map((item) => item.id));
  return issues.filter((issue) => issue.date === day.date || issue.item_ids?.some((id) => ids.has(id)));
}

export default function TravelDashboard() {
  const [launcher, setLauncher] = useState<LauncherContext>({});
  const [tab, setTab] = useState<TripView>("today");
  const [trip, setTrip] = useState<TripSummary | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [plan, setPlan] = useState<PlanOverview | null>(null);
  const [places, setPlaces] = useState<PlacesOverview | null>(null);
  const [journal, setJournal] = useState<JournalOverview | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationsOverview | null>(null);
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmProposal, setConfirmProposal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (context: LauncherContext, requested?: TripView) => {
    setLoading(true); setError(null);
    try {
      const shell = await loadTripShell(context);
      const view = requested ?? context.view ?? defaultViewForTripStatus(shell.trip.status);
      const resolved = { ...context, trip_id: shell.tripId, view };
      setLauncher(resolved); setTrip(shell.trip); setTab(view);
      if (view === "today") {
        const data = await loadSnapshot(resolved, shell); setSnapshot(data);
        setLauncher((current) => ({ ...current, date: data.date })); setConfirmProposal(false);
      } else if (view === "plan") {
        const data = await loadPlan(shell); setPlan(data);
        const available = new Set(data.unscheduled_places.map((place) => place.id));
        setSelected((current) => current.filter((id) => available.has(id)));
      } else if (view === "places") setPlaces(await loadPlaces(shell));
      else if (view === "journal") setJournal(await loadJournal(shell));
      else setRecommendations(await loadRecommendations(shell));
    } catch (cause) { setError(messageFor(cause, "Could not load Travel Brain.")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const receive = (result: any) => {
      const context = parseToolJson(result)?.dashboard;
      if (context && typeof context === "object") void load(context);
    };
    app.addEventListener("toolresult", receive);
    void app.connect().catch((cause) => { setError(messageFor(cause, "Could not connect the dashboard.")); setLoading(false); });
    return () => app.removeEventListener("toolresult", receive);
  }, [load]);

  const direct = useCallback(async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(success); await load(launcher, tab); }
    catch (cause) { setError(messageFor(cause, "Travel Brain could not save that change.")); }
    finally { setBusy(null); }
  }, [launcher, load, tab]);

  const ask = useCallback(async (key: string, request: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await sendClaudeMessage(request); setNotice("Sent to Claude for reasoning and review."); }
    catch (cause) { setError(messageFor(cause, "Could not send that request to Claude.")); }
    finally { setBusy(null); }
  }, []);

  const prompt = (instruction: string) => `${trip ? `Trip: “${trip.title}” (trip_id: ${trip.id}).` : "Use the current Travel Brain trip."} ${instruction}`;
  const changeTab = (view: TripView) => { setTab(view); void load({ ...launcher, view }, view); };
  const changeDate = (date: string) => date && void load({ ...launcher, view: "today", date }, "today");
  const updateStatus = (item: TimelineItem, status: "completed" | "skipped") => void direct(
    `${status}-${item.id}`,
    () => callTool(TOOL.updateItineraryItem, { itinerary_item_id: item.id, status, ...(status === "completed" ? { actual_end: new Date().toISOString() } : {}) }),
    status === "completed" ? `${item.title} marked done.` : `${item.title} skipped.`,
  );
  const togglePlace = (place: SavedPlace) => setSelected((current) => current.includes(place.id) ? current.filter((id) => id !== place.id) : [...current, place.id]);
  const fitPlaces = () => {
    const chosen = plan?.unscheduled_places.filter((place) => selected.includes(place.id)) ?? [];
    if (chosen.length) void ask("fit-places", prompt(`Find good itinerary slots for ${chosen.map((place) => `${place.name} (${place.id})`).join(", ")}. Preserve fixed commitments, cluster sensibly, and prepare a reviewable proposal without committing it.`));
  };

  const filteredPlaces = useMemo(() => placeFilter === "all" ? places?.places ?? [] : (places?.places ?? []).filter((place) => place.trip_status === placeFilter), [placeFilter, places]);
  const recommendationGroups = useMemo(() => [
    { key: "firsthand", label: "Firsthand" }, { key: "mixed", label: "Mixed evidence" }, { key: "research", label: "Research-only" },
  ].map((group) => ({ ...group, items: (recommendations?.recommendations ?? []).filter((item) => item.recommendation.provenance === group.key) })), [recommendations]);
  const selectedDate = snapshot?.date ?? launcher.date ?? "";

  return <main className="dashboard" aria-busy={loading}>
    <header className="shell-header">
      <div><div className="brand"><b>TB</b><span>Travel Brain</span>{trip?.status ? <em>{humanize(trip.status)}</em> : null}</div><h1>{trip?.title ?? "Your travel dashboard"}</h1><p>{trip?.destination_summary ?? "Plan, travel, remember, and recommend in one place."}<span>{trip ? tripDates(trip) : ""}</span></p></div>
      <button type="button" className="refresh" aria-label="Refresh current view" disabled={loading} onClick={() => void load(launcher, tab)}>↻</button>
    </header>
    <nav className="tabs" aria-label="Travel Brain views">{NAV.map((item) => <button type="button" key={item.key} className={tab === item.key ? "active" : ""} aria-current={tab === item.key ? "page" : undefined} onClick={() => changeTab(item.key)}>{item.label}</button>)}</nav>
    {loading ? <div className="loading"><i /></div> : null}

    {tab === "today" && snapshot ? <div className="view">
      <section className="intro"><div><span className="eyebrow">Live itinerary</span><h2>{dateLabel(snapshot.date, true)}</h2><p>{snapshot.local_time ? `${snapshot.local_time} local` : snapshot.timezone}{snapshot.running_late_minutes ? ` · ${snapshot.running_late_minutes} min behind` : " · On plan"}</p></div><div className="date-picker"><button type="button" aria-label="Previous day" onClick={() => changeDate(shiftDate(selectedDate, -1))}>‹</button><input aria-label="Itinerary date" type="date" value={selectedDate} min={trip?.start_date ?? undefined} max={trip?.end_date ?? undefined} onChange={(event) => changeDate(event.target.value)} /><button type="button" aria-label="Next day" onClick={() => changeDate(shiftDate(selectedDate, 1))}>›</button></div></section>
      {snapshot.alerts.length ? <section className="panel"><div className="section-title"><div><span className="eyebrow">Schedule health</span><h2>{snapshot.alerts.length} {snapshot.alerts.length === 1 ? "item needs" : "items need"} attention</h2></div></div>{snapshot.alerts.map((item, index) => <Alert key={item.id ?? index} issue={item} />)}</section> : <div className="health"><b>✓</b><div><strong>Schedule looks clear</strong><p>No deterministic conflicts were returned for this day.</p></div></div>}
      {snapshot.pending_proposal ? <section className="proposal"><div><span className="eyebrow">Prepared change</span><h2>{snapshot.pending_proposal.summary ?? "Itinerary change ready"}</h2><p>{snapshot.pending_proposal.rationale}</p></div>{confirmProposal ? <div className="confirm"><p>Has this proposal been reviewed and approved?</p><button className="button quiet" onClick={() => setConfirmProposal(false)}>Cancel</button><button className="button primary" disabled={busy === "commit"} onClick={() => void direct("commit", () => callTool(TOOL.commitItineraryChange, { proposal_id: snapshot.pending_proposal?.id }), "Approved change applied.")}>Confirm and apply</button></div> : <div className="actions"><button className="button secondary" onClick={() => void ask("review", prompt(`Review proposal ${snapshot.pending_proposal?.id} without committing it.`))}>Review with Claude</button><button className="button primary" onClick={() => setConfirmProposal(true)}>Apply approved change</button></div>}</section> : null}
      <section className="summary-grid three"><Summary label="Now" value={snapshot.now?.title ?? "Open time"} detail={timeLabel(snapshot.now?.actual_start ?? snapshot.now?.planned_start) || "Nothing in progress"} /><Summary label="Next" value={snapshot.next?.title ?? "Nothing queued"} detail={timeLabel(snapshot.next?.planned_start) || "The day is open"} /><Summary label="Then" value={snapshot.then?.title ?? "Nothing queued"} detail={timeLabel(snapshot.then?.planned_start) || "Room to improvise"} /></section>
      <section className="quick-actions">{[
        ["↘", "Running late", "Repair the schedule", "late", `I’m running late on ${snapshot.date}. Repair today with the smallest sensible changes and prepare a proposal without committing it.`],
        ["◇", "Find food", "Fit the next stop", "food", `Find practical food options that fit ${snapshot.date} and the next fixed commitment.`],
        ["+", "Remember", "Capture it raw", "remember", "Help me capture a freeform memory with record_journal_note without rewriting my raw words."],
        ["↻", "Replan day", "Make a proposal", "replan", `Replan the rest of ${snapshot.date}, preserve fixed commitments, and prepare a proposal without committing it.`],
      ].map(([icon, title, detail, key, request]) => <button type="button" key={key} disabled={Boolean(busy)} onClick={() => void ask(key, prompt(request))}><b>{icon}</b><strong>{title}</strong><small>{detail}</small></button>)}</section>
      <section><div className="section-title"><div><span className="eyebrow">Today</span><h2>Timeline</h2></div><small>{snapshot.timeline.length} items</small></div><div className="timeline">{snapshot.timeline.length ? snapshot.timeline.map((item) => <ItineraryCard key={item.id} item={item} phase="active" busy={Boolean(busy)} onDone={(target) => updateStatus(target, "completed")} onSkip={(target) => updateStatus(target, "skipped")} />) : <Empty title="An open day" detail="No itinerary items were returned for this date." />}</div></section>
    </div> : null}

    {tab === "plan" && plan ? <div className="view">
      <section className="intro"><div><span className="eyebrow">Planning workspace</span><h2>Shape the trip, one day at a time</h2><p>Travel Brain holds the plan. Claude reasons about changes before anything is committed.</p></div><button className="button secondary" onClick={() => void ask("review-plan", prompt("Review the full plan for geography, pace, meal gaps, overlaps, and buffers. Prepare proposals without committing them."))}>Review full plan</button></section>
      <section className="summary-grid four"><Summary label="Days" value={plan.total_days ?? plan.days.length} detail={tripDates(plan.trip)} /><Summary label="Scheduled" value={plan.scheduled_count ?? 0} detail="Active itinerary items" /><Summary label="Unscheduled" value={plan.unscheduled_places.length} detail="Saved places waiting" /><Summary label="Issues" value={plan.issues.length} detail={plan.issues.length ? "Review before travel" : "No conflicts returned"} /></section>
      <section className="panel"><div className="section-title"><div><span className="eyebrow">Backend checks</span><h2>Planning issues</h2></div><button className="button secondary" disabled={!plan.issues.length || Boolean(busy)} onClick={() => void ask("fix-issues", prompt(`Fix these returned issues: ${plan.issues.map((issue) => issue.title).join("; ")}. Preserve fixed commitments and prepare a proposal without committing it.`))}>Fix planning issues</button></div>{plan.issues.length ? plan.issues.map((issue, index) => <Alert key={issue.id ?? index} issue={issue} />) : <Empty title="No planning issues" detail="The read model returned no overlaps, missing starts, short buffers, or stale research." />}</section>
      <section><div className="section-title"><div><span className="eyebrow">Day by day</span><h2>Trip plan</h2></div><small>{plan.days.length} day sections</small></div><div className="days">{plan.days.length ? plan.days.map((day, index) => { const issues = relatedIssues(day, plan.issues); return <article className="day" key={day.date}><header><b>{String(index + 1).padStart(2, "0")}</b><div><span className="eyebrow">{day.area ?? "Area open"}</span><h3>{dateLabel(day.date, true)}</h3><p>{day.items.length} items · {day.fixed_anchors?.length ?? 0} fixed · {issues.length} issues</p></div><div className="actions"><button className="button quiet" onClick={() => changeDate(day.date)}>Open day</button><button className="button secondary" onClick={() => void ask(`optimize-${day.date}`, prompt(`Optimize ${day.date}, preserve fixed commitments, address ${issues.map((issue) => issue.title).join(", ") || "returned constraints"}, and prepare a proposal without committing it.`))}>Optimize day</button></div></header>{issues.length ? <div className="day-issues">{issues.map((issue) => <span key={issue.id ?? issue.title}>{issue.title}</span>)}</div> : null}<div className="timeline">{day.items.length ? day.items.map((item) => <ItineraryCard key={item.id} item={item} phase="planning" busy={Boolean(busy)} onAdjust={(target) => void ask(`adjust-${target.id}`, prompt(`Adjust “${target.title}” (${target.id}) on ${day.date}; prepare a proposal without committing it.`))} />) : <Empty title="Nothing scheduled" detail="This trip date has no timed itinerary items yet." />}</div></article>; }) : <Empty title="No trip days yet" detail="Set trip dates or add itinerary items to create day sections." />}</div></section>
      <section className="panel"><div className="section-title tray"><div><span className="eyebrow">Place backlog</span><h2>Unscheduled tray</h2><p>Saved research is not an itinerary commitment.</p></div><button className="button primary" disabled={!selected.length || Boolean(busy)} onClick={fitPlaces}>Ask Claude where these fit{selected.length ? ` (${selected.length})` : ""}</button></div><div className="place-grid">{plan.unscheduled_places.length ? plan.unscheduled_places.map((place) => <PlaceCard key={place.id} place={place} selectable selected={selected.includes(place.id)} busy={Boolean(busy)} onToggle={togglePlace} />) : <Empty title="Tray is clear" detail="No candidate or saved places are waiting to be scheduled." />}</div></section>
    </div> : null}

    {tab === "places" && places ? <div className="view"><section className="intro"><div><span className="eyebrow">Canonical backlog</span><h2>Places</h2><p>Research, schedule, visit, and freshness states remain distinct.</p></div><button className="button secondary" onClick={() => void ask("review-places", prompt("Review saved places and separate must-do options, useful backups, and low-priority ideas without scheduling research automatically."))}>Review with Claude</button></section><div className="filters">{PLACE_FILTERS.map((filter) => <button type="button" key={filter} className={placeFilter === filter ? "active" : ""} onClick={() => setPlaceFilter(filter)}>{humanize(filter)}</button>)}</div><div className="place-grid">{filteredPlaces.length ? filteredPlaces.map((place) => <PlaceCard key={place.id} place={place}>{!place.scheduled && place.trip_status !== "rejected" ? <button className="button quiet place-action" onClick={() => void ask(`plan-${place.id}`, prompt(`Find a sensible itinerary slot for “${place.name}” (${place.id}) and prepare a proposal without committing it.`))}>Ask Claude to plan</button> : null}</PlaceCard>) : <Empty title="No places in this filter" detail="Try another status to see the rest of the backlog." />}</div></div> : null}

    {tab === "journal" && journal ? <div className="view"><section className="intro"><div><span className="eyebrow">What actually happened</span><h2>Journal</h2><p>Raw notes stay raw, with their captured visit and itinerary context.</p></div><button className="button primary" onClick={() => void ask("journal", prompt("Help me capture a raw journal note and relevant context without rewriting my words."))}>Remember something</button></section><div className="journal">{journal.entries.length ? journal.entries.map((entry) => <article key={entry.id}><header><div><span className="eyebrow">{entry.places?.name ?? entry.itinerary_items?.title ?? "Trip note"}</span><time>{dateTimeLabel(entry.captured_at)}</time></div><span className="badge">{humanize(entry.visibility ?? "private")}</span></header><p className="raw-note">{entry.raw_note}</p>{entry.reaction ? <p className="reaction"><strong>Reaction</strong> {entry.reaction}</p> : null}{entry.itinerary_items ? <div className="journal-context"><span className="eyebrow">Visit context</span><ItineraryCard item={entry.itinerary_items} phase="completed" /></div> : null}</article>) : <Empty title="No journal entries yet" detail="Capture moments without polishing away your original words." />}</div></div> : null}

    {tab === "recommendations" && recommendations ? <div className="view"><section className="intro"><div><span className="eyebrow">Evidence-aware guidance</span><h2>Recommendations</h2><p>Firsthand experience and research-only ideas are clearly separated.</p></div><button className="button primary" disabled={!recommendations.recommendations.length} onClick={() => void ask("guide", prompt("Create a friend guide with provenance, caveats, and best-for notes; never expose private journal text."))}>Generate friend guide</button></section>{recommendationGroups.map((group) => <section key={group.key}><div className="section-title"><div><span className="eyebrow">Provenance</span><h2>{group.label}</h2></div><small>{group.items.length}</small></div><div className="place-grid">{group.items.length ? group.items.map((item, index) => <PlaceCard key={item.recommendation.id ?? `${item.place.id}-${index}`} place={item.place}><div className="recommendation"><b>{humanize(item.recommendation.level ?? "recommend")}</b>{item.recommendation.shareable_note ? <p>{item.recommendation.shareable_note}</p> : null}{item.recommendation.caveats ? <p><strong>Caveat:</strong> {item.recommendation.caveats}</p> : null}{item.recommendation.best_for?.length ? <div><strong>Best for</strong>{item.recommendation.best_for.map((value) => <span key={value}>{value}</span>)}</div> : null}</div></PlaceCard>) : <Empty title={`No ${group.label.toLowerCase()} recommendations`} detail="This evidence group is empty." />}</div></section>)}</div> : null}

    {error ? <div className="toast error" role="alert"><b>!</b>{error}</div> : null}{notice ? <div className="toast success" role="status"><b>✓</b>{notice}</div> : null}
  </main>;
}
