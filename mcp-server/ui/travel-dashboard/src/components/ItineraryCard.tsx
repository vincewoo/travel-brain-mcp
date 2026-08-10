import React from "react";
import { humanize, timeLabel, timeRangeLabel } from "../format";
import type { TimelineItem } from "../types";

interface Props {
  item: TimelineItem;
  phase: "planning" | "active" | "completed";
  busy?: boolean;
  onDone?: (item: TimelineItem) => void | Promise<void>;
  onSkip?: (item: TimelineItem) => void | Promise<void>;
  onAdjust?: (item: TimelineItem) => void | Promise<void>;
}

export function ItineraryCard({ item, phase, busy, onDone, onSkip, onAdjust }: Props) {
  const inactive = ["completed", "skipped", "cancelled"].includes(item.status ?? "");
  const actual = timeRangeLabel(item.actual_start, item.actual_end);
  const planned = timeRangeLabel(item.planned_start, item.planned_end);
  const primary = phase === "planning" ? planned : (item.actual_start ? actual : planned);
  const label = item.status === "completed" ? "Done" : item.status === "skipped" ? "Skipped" : humanize(item.flexibility ?? "flexible");
  const differs = phase !== "planning" && item.actual_start && item.planned_start && timeLabel(item.actual_start) !== timeLabel(item.planned_start);

  return <article className={`itinerary-card ${inactive ? "is-muted" : ""}`}>
    <div className="itinerary-time"><strong>{primary}</strong>{differs ? <span>Planned {timeLabel(item.planned_start)}</span> : null}</div>
    <div className="itinerary-body">
      <div className="card-title-row"><div><span className="item-type">{humanize(item.item_type ?? "activity")}</span><h3>{item.title}</h3></div><span className={`badge badge-${item.flexibility ?? "flexible"}`}>{label}</span></div>
      {item.notes ? <p className="supporting-copy">{item.notes}</p> : null}
      {item.travel_minutes_to_next ? <p className="route-note">{item.travel_minutes_to_next} min to the next stop</p> : null}
      {phase === "active" && !inactive ? <div className="inline-actions">
        {onDone ? <button type="button" className="button button-quiet" disabled={busy} onClick={() => void onDone(item)}>Mark done</button> : null}
        {onSkip && item.flexibility !== "fixed" ? <button type="button" className="button button-quiet" disabled={busy} onClick={() => void onSkip(item)}>Skip</button> : null}
      </div> : null}
      {phase === "planning" && onAdjust ? <div className="inline-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={() => void onAdjust(item)}>Adjust with Claude</button></div> : null}
    </div>
  </article>;
}
