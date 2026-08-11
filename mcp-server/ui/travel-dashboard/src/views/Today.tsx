import React from "react";
import { AlertRow, TimelineRow } from "../components/rows";
import { NoteEmpty } from "../components/states";
import { clockLabel, dayHeadingLabel, flexibilityLabel, joinMeta, plural, shiftDate, shortDateLabel, timeLabel, zoneAbbreviation } from "../format";
import { withAlerts } from "../timeline";
import type { DashboardSnapshot, PlanningIssue, TimelineItem, TripSummary } from "../types";
import { useZone } from "../zone";

interface Props {
  snapshot: DashboardSnapshot;
  trip: TripSummary | null;
  busy: string | null;
  confirming: boolean;
  onConfirm: (value: boolean) => void;
  onCommit: () => void;
  onChangeDate: (date: string) => void;
  onStatus: (item: TimelineItem, status: "completed" | "skipped") => void;
  ask: (key: string, label: string, instruction: string) => void;
}

const QUICK_ACTIONS = (date: string) => [
  { key: "late", label: "Running late", working: "Asking Claude to repair the day…", instruction: `I’m running late on ${date}. Repair today with the smallest sensible changes and prepare a proposal without committing it.` },
  { key: "food", label: "Find food", working: "Asking Claude to find food…", instruction: `Find practical food options that fit ${date} and the next fixed commitment.` },
  { key: "remember", label: "Remember something", working: "Asking Claude to capture a note…", instruction: "Help me capture a freeform memory with record_journal_note without rewriting my raw words." },
  { key: "replan", label: "Replan the day", working: "Asking Claude to replan…", instruction: `Replan the rest of ${date}, preserve fixed commitments, and prepare a proposal without committing it.` },
];

/** Elapsed share of the item in progress, or null when its span is unknown. */
function progressOf(item?: TimelineItem | null) {
  const start = new Date(item?.actual_start ?? item?.planned_start ?? "").getTime();
  const end = new Date(item?.planned_end ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
}

export function TodayView({ snapshot, trip, busy, confirming, onConfirm, onCommit, onChangeDate, onStatus, ask }: Props) {
  const zone = useZone();
  const { now, next, timeline, alerts } = snapshot;
  const proposal = snapshot.pending_proposal;
  const percent = progressOf(now);
  const doneCount = timeline.filter((item) => item.status === "completed").length;
  // The clock in the Now bar is the trip's, so it says which one it is.
  const nowClock = [clockLabel(snapshot.local_time), zoneAbbreviation(zone)].filter(Boolean).join(" ");
  const nextLine = next
    ? `Next: ${joinMeta([next.title, timeLabel(next.planned_start, zone)].filter(Boolean).join(", "), flexibilityLabel(next.flexibility).toLowerCase())}`
    : "";
  const recover = (alert: PlanningIssue) => ask(
    `alert-${alert.id ?? alert.title}`,
    alert.severity === "danger" ? `Asking Claude to repair ${shortDateLabel(snapshot.date)}…` : "Asking Claude to fix the conflict…",
    `Resolve “${alert.title}”${alert.detail ? ` (${alert.detail})` : ""} on ${snapshot.date}. Preserve fixed commitments and prepare a proposal without committing it.`,
  );

  return <>
    <div className="now-bar">
      <div>
        <div>
          <p className="now-label">{joinMeta("Now", nowClock, snapshot.running_late_minutes ? `${snapshot.running_late_minutes} min behind` : "")}</p>
          <strong className="now-title">{now?.title ?? "Open time"}</strong>
          {nextLine ? <p className="now-next">{nextLine}</p> : null}
        </div>
        {now ? <div className="now-actions">
          {now.flexibility !== "fixed" ? <button type="button" className="button" disabled={busy === `skipped-${now.id}`} onClick={() => onStatus(now, "skipped")}>Skip</button> : null}
          <button type="button" className="button primary" disabled={busy === `completed-${now.id}`} onClick={() => onStatus(now, "completed")}>Mark done</button>
        </div> : null}
      </div>
      {percent === null ? null : <div className="now-progress"><i style={{ width: `${percent}%` }} /></div>}
    </div>

    <div className="view under-now-bar">
      <div className="view-head">
        <h2>{dayHeadingLabel(snapshot.date)}</h2>
        <div className="date-step">
          <button type="button" aria-label="Previous day" onClick={() => onChangeDate(shiftDate(snapshot.date, -1))}>‹</button>
          <input aria-label="Itinerary date" type="date" value={snapshot.date} min={trip?.start_date ?? undefined} max={trip?.end_date ?? undefined} onChange={(event) => onChangeDate(event.target.value)} />
          <button type="button" aria-label="Next day" onClick={() => onChangeDate(shiftDate(snapshot.date, 1))}>›</button>
        </div>
      </div>

      {proposal ? <section className="tint">
        <p className="tint-label">Prepared change, not yet applied</p>
        <strong>{proposal.summary ?? "Itinerary change ready"}</strong>
        {proposal.rationale ? <p>{proposal.rationale}</p> : null}
        {confirming ? <>
          <p>Has this proposal been reviewed and approved?</p>
          <div className="button-row">
            <button type="button" className="button" onClick={() => onConfirm(false)}>Cancel</button>
            <button type="button" className="button primary" disabled={busy === "commit"} onClick={onCommit}>Confirm and apply</button>
          </div>
        </> : <div className="button-row">
          <button type="button" className="button primary" onClick={() => onConfirm(true)}>Apply</button>
          <button type="button" className="button" onClick={() => ask("review", "Asking Claude to review the proposal…", `Review proposal ${proposal.id} without committing it.`)}>Review with Claude</button>
        </div>}
      </section> : null}

      {timeline.length ? <section className="container">
        <div className="container-head">
          <strong>Timeline</strong>
          <span>{joinMeta(plural(timeline.length, "item"), doneCount ? `${doneCount} done` : "", alerts.length ? `${alerts.length} flagged` : "")}</span>
        </div>
        {withAlerts(timeline, alerts, zone).map((row) => row.kind === "alert"
          ? <AlertRow key={row.key} alert={row.alert} busy={Boolean(busy)} onRecover={recover} />
          : <TimelineRow
              key={row.key}
              item={row.item}
              phase="active"
              current={Boolean(now && row.item.id === now.id)}
              busy={Boolean(busy)}
              onDone={(item) => onStatus(item, "completed")}
              onSkip={(item) => onStatus(item, "skipped")}
            />)}
      </section> : <NoteEmpty
        title={`Nothing scheduled on ${dayHeadingLabel(snapshot.date).split(",")[0]}`}
        detail="The day is yours."
        action={{ label: "Ask Claude to fill it", onPick: () => ask("fill-day", "Asking Claude to fill the day…", `Suggest a sensible plan for ${snapshot.date} from saved places and prepare a proposal without committing it.`) }}
      />}

      <div className="button-row quick-actions">
        {QUICK_ACTIONS(snapshot.date).map((action) => <button
          key={action.key}
          type="button"
          className="button"
          disabled={Boolean(busy)}
          onClick={() => ask(action.key, action.working, action.instruction)}
        >{action.label}</button>)}
      </div>
    </div>
  </>;
}
