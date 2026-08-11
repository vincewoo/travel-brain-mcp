import React from "react";
import { AlertRow, IssueRow, TimelineRow } from "../components/rows";
import { NoteEmpty } from "../components/states";
import { dateLabel, humanize, joinMeta, plural } from "../../../shared/format";
import { relatedIssues, withAlerts } from "../../../shared/timeline";
import type { PlanOverview, PlanningIssue, SavedPlace, TimelineItem } from "../types";
import { useZone } from "../zone";

interface Props {
  plan: PlanOverview;
  selected: string[];
  busy: string | null;
  onToggle: (place: SavedPlace) => void;
  onFitPlaces: () => void;
  onOpenDay: (date: string) => void;
  onRemove: (item: TimelineItem) => void;
  ask: (key: string, label: string, instruction: string) => void;
}

export function PlanView({ plan, selected, busy, onToggle, onFitPlaces, onOpenDay, onRemove, ask }: Props) {
  const zone = useZone();
  const waiting = plan.unscheduled_places.length;
  const recover = (date: string) => (alert: PlanningIssue) => ask(
    `alert-${alert.id ?? alert.title}`,
    alert.severity === "danger" ? "Asking Claude to repair the day…" : "Asking Claude to fix the conflict…",
    `Resolve “${alert.title}”${alert.detail ? ` (${alert.detail})` : ""} on ${date}. Preserve fixed commitments and prepare a proposal without committing it.`,
  );

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Plan</h2>
        <span className="view-count">{joinMeta(
          plural(plan.total_days ?? plan.days.length, "day"),
          `${plan.scheduled_count ?? 0} scheduled`,
          `${waiting} waiting`,
          plural(plan.issues.length, "issue"),
        )}</span>
      </div>
      <button type="button" className="button" onClick={() => ask("review-plan", "Asking Claude to review the plan…", "Review the full plan for geography, pace, meal gaps, overlaps, and buffers. Prepare proposals without committing them.")}>Review full plan</button>
    </div>

    {plan.issues.length ? <section className="container">
      <div className="container-head sunken">
        <strong>{plural(plan.issues.length, "issue")} before departure</strong>
        <button type="button" className="link-button" disabled={Boolean(busy)} onClick={() => ask("fix-issues", "Asking Claude to fix the issues…", `Fix these returned issues: ${plan.issues.map((issue) => issue.title).join("; ")}. Preserve fixed commitments and prepare a proposal without committing it.`)}>Fix with Claude</button>
      </div>
      {plan.issues.map((issue, index) => <IssueRow key={issue.id ?? `${issue.title}-${index}`} issue={issue} />)}
    </section> : <NoteEmpty title="No planning issues" detail="No overlaps, missing starts, short buffers or stale research." />}

    {plan.days.length ? plan.days.map((day) => {
      const issues = relatedIssues(day.date, day.items, plan.issues);
      return <section className="container" key={day.date}>
        <div className="container-head">
          <div className="head-label">
            <strong>{dateLabel(day.date)}</strong>
            <span>{joinMeta(day.area ?? "", plural(day.items.length, "item"), `${day.fixed_anchors?.length ?? 0} fixed`)}</span>
          </div>
          <div className="head-actions">
            <button type="button" className="link-button" onClick={() => onOpenDay(day.date)}>Open</button>
            <button type="button" className="link-button quiet" disabled={Boolean(busy)} onClick={() => ask(`optimize-${day.date}`, `Asking Claude to optimize ${dateLabel(day.date)}…`, `Optimize ${day.date}, preserve fixed commitments, address ${issues.map((issue) => issue.title).join(", ") || "returned constraints"}, and prepare a proposal without committing it.`)}>Optimize</button>
          </div>
        </div>
        {day.items.length ? withAlerts(day.items, issues, zone).map((row) => row.kind === "alert"
          ? <AlertRow key={row.key} alert={row.alert} busy={Boolean(busy)} onRecover={recover(day.date)} />
          : <TimelineRow
              key={row.key}
              item={row.item}
              phase="planning"
              busy={Boolean(busy)}
              onAdjust={(item: TimelineItem) => ask(`adjust-${item.id}`, "Asking Claude to adjust the item…", `Adjust “${item.title}” (${item.id}) on ${day.date}; prepare a proposal without committing it.`)}
              onRemove={onRemove}
            />) : <div className="row"><p className="row-meta">Nothing scheduled on this date yet.</p></div>}
      </section>;
    }) : <NoteEmpty title="No trip days yet" detail="Set trip dates or add itinerary items to create day sections." />}

    {waiting ? <section className="container">
      <div className="container-head">
        <div className="head-label">
          <strong>Unscheduled</strong>
          <span>{joinMeta(`${plural(waiting, "saved place")}`, selected.length ? `${selected.length} selected` : "")}</span>
        </div>
        <button type="button" className="button primary" disabled={!selected.length || Boolean(busy)} onClick={onFitPlaces}>Ask where these fit</button>
      </div>
      {plan.unscheduled_places.map((place) => {
        const stale = place.freshness === "stale";
        return <label className={`select-row${selected.includes(place.id) ? " is-selected" : ""}`} key={place.id}>
          <input type="checkbox" checked={selected.includes(place.id)} disabled={Boolean(busy)} onChange={() => onToggle(place)} />
          <div className="row-body">
            <div className="row-title-line">
              <strong>{place.name}</strong>
              <span className={`row-aside${stale ? " status warning" : ""}`}>{stale ? "Needs refresh" : joinMeta(place.priority ? `P${place.priority}` : "", place.research_count ? `${place.research_count} notes` : "")}</span>
            </div>
            <p className="row-meta">{joinMeta(humanize(place.category ?? "place"), place.locality ?? place.region ?? "")}</p>
          </div>
        </label>;
      })}
    </section> : <NoteEmpty title="Tray is clear" detail="Every saved place is scheduled or set aside." />}
  </div>;
}
