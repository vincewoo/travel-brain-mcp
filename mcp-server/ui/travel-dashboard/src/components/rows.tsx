import React from "react";
import { durationLabel, flexibilityLabel, humanize, joinMeta, plural, timeLabel } from "../format";
import type { PlanningIssue, SavedPlace, TimelineItem } from "../types";

type Tone = "muted" | "info" | "warning" | "danger" | "ok";

export const issueTone = (severity?: string | null): Tone =>
  severity === "danger" ? "danger" : severity === "info" ? "info" : "warning";

/** Flexibility is metadata, so the word stays muted; only the dot carries the colour, and only "fixed" is loud. */
function flexibility(item: TimelineItem) {
  const value = item.flexibility ?? "flexible";
  return { label: flexibilityLabel(value), dot: value === "fixed" ? "warning" : value === "semi_flexible" ? "info" : "muted", text: value === "fixed" ? "warning" : "" };
}

export function placeStatus(place: SavedPlace): { label: string; dot: Tone; text: Tone | "" } {
  if (place.freshness === "stale") return { label: "Needs refresh", dot: "warning", text: "warning" };
  const status = place.trip_status ?? "shortlist";
  const dot: Tone = status === "planned" ? "info" : status === "visited" ? "ok" : status === "rejected" ? "danger" : "muted";
  return { label: humanize(status), dot, text: "" };
}

interface TimelineRowProps {
  item: TimelineItem;
  phase: "planning" | "active";
  current?: boolean;
  busy?: boolean;
  onDone?: (item: TimelineItem) => void;
  onSkip?: (item: TimelineItem) => void;
  onAdjust?: (item: TimelineItem) => void;
}

export function TimelineRow({ item, phase, current, busy, onDone, onSkip, onAdjust }: TimelineRowProps) {
  const done = item.status === "completed";
  const skipped = ["skipped", "cancelled"].includes(item.status ?? "");
  const inactive = done || skipped;
  const start = phase === "active" ? item.actual_start ?? item.planned_start : item.planned_start;
  const shifted = item.actual_start && item.planned_start && timeLabel(item.actual_start) !== timeLabel(item.planned_start);
  const under = current ? "now" : durationLabel(item.actual_start ?? item.planned_start, item.actual_end ?? item.planned_end);
  const flex = flexibility(item);

  return <article className={`row timeline-row${inactive ? " is-done" : ""}${current ? " is-current" : ""}`}>
    <div className={`time-gutter${inactive ? " past" : ""}${current ? " current" : ""}`}>
      {timeLabel(start) || "Unscheduled"}{under ? <span>{under}</span> : null}
    </div>
    <div className="row-body">
      <div className="row-title-line">
        <strong>{item.title}</strong>
        {done ? <span className="row-aside">Done</span>
          : skipped ? <span className="row-aside">Skipped</span>
          : current ? <span className="status info">In progress</span>
          : <span className={`status ${flex.text}`}><i className={`dot ${flex.dot}`} />{flex.label}</span>}
      </div>
      {(() => {
        const meta = joinMeta(
          humanize(item.item_type ?? "activity"),
          shifted ? `planned ${timeLabel(item.planned_start)}` : "",
          item.notes ?? "",
          item.travel_minutes_to_next ? `${item.travel_minutes_to_next} min to the next stop` : "",
        );
        return meta ? <p className="row-meta">{meta}</p> : null;
      })()}
      {/* The row in progress is the one the Now bar already carries Skip and Mark done for. */}
      {!inactive && !current && phase === "active" && (onDone || onSkip) ? <div className="row-actions">
        {onDone ? <button type="button" className="link-button" disabled={busy} onClick={() => onDone(item)}>Mark done</button> : null}
        {onSkip && item.flexibility !== "fixed" ? <button type="button" className="link-button quiet" disabled={busy} onClick={() => onSkip(item)}>Skip</button> : null}
      </div> : null}
      {!inactive && phase === "planning" && onAdjust ? <div className="row-actions">
        <button type="button" className="link-button" disabled={busy} onClick={() => onAdjust(item)}>Adjust with Claude</button>
      </div> : null}
    </div>
  </article>;
}

/** An alert is a row in the timeline, sitting at the point where it bites. */
export function AlertRow({ alert, busy, onRecover }: { alert: PlanningIssue; busy?: boolean; onRecover: (alert: PlanningIssue) => void }) {
  const tone = issueTone(alert.severity);
  return <div className={`alert-row ${tone}`}>
    <div />
    <div>
      <i className="dot" />{joinMeta(alert.title, alert.detail ?? "")}
      <button type="button" className={`link-button ${tone}`} disabled={busy} onClick={() => onRecover(alert)}>
        {tone === "danger" ? "Repair day" : "Fix"}
      </button>
    </div>
  </div>;
}

export function IssueRow({ issue }: { issue: PlanningIssue }) {
  return <div className={`issue-row ${issueTone(issue.severity)}`}>
    <i className={`dot ${issueTone(issue.severity)}`} />
    <div><strong>{issue.title}</strong>{issue.detail ? <span> — {issue.detail}</span> : null}</div>
    <small>{issue.date ? new Date(`${issue.date.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "—"}</small>
  </div>;
}

export function PlaceRow({ place, busy, onPlan }: { place: SavedPlace; busy?: boolean; onPlan?: (place: SavedPlace) => void }) {
  const status = placeStatus(place);
  const meta = joinMeta(
    humanize(place.category ?? "place"),
    place.locality ?? place.region ?? "",
    place.priority ? `P${place.priority}` : "",
    place.research_count ? plural(place.research_count, "research note") : "",
    place.itinerary_dates?.length ? `scheduled ${place.itinerary_dates.map((date) => new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })).join(", ")}` : "",
  );
  const settled = ["planned", "rejected", "visited"].includes(place.trip_status ?? "") || place.scheduled;
  return <article className="row">
    <div className="row-title-line">
      <strong>{place.name}</strong>
      <span className={`status ${status.text}`}><i className={`dot ${status.dot}`} />{status.label}</span>
    </div>
    {meta ? <p className="row-meta">{meta}</p> : null}
    {place.note ? <p className="row-note">{place.note}</p> : null}
    {!settled && onPlan ? <div className="row-actions">
      <button type="button" className="link-button" disabled={busy} onClick={() => onPlan(place)}>Ask Claude to plan it</button>
    </div> : null}
  </article>;
}
