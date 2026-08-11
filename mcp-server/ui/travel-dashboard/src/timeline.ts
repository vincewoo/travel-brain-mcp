import { zoneDate } from "./format";
import type { PlanningIssue, TimelineItem } from "./types";

export type TimelineRowModel =
  | { kind: "item"; key: string; item: TimelineItem }
  | { kind: "alert"; key: string; alert: PlanningIssue };

/**
 * Each alert renders immediately after the timeline item its `item_ids` points at.
 * Failing that it follows the last item sharing its date, and failing that it goes to the top.
 *
 * An alert's `date` is a trip-local day, so the item instants it is matched against have to be
 * resolved in the trip's zone too — a UTC reading would misplace anything either side of midnight.
 */
export function withAlerts(timeline: TimelineItem[], alerts: PlanningIssue[], zone: string): TimelineRowModel[] {
  const positionFor = (alert: PlanningIssue) => {
    const ids = new Set(alert.item_ids ?? []);
    let byId = -1;
    let byDate = -1;
    timeline.forEach((item, index) => {
      if (ids.has(item.id)) byId = index;
      if (alert.date && zoneDate(item.planned_start ?? item.actual_start, zone) === alert.date.slice(0, 10)) byDate = index;
    });
    if (byId >= 0) return byId + 1;
    return byDate >= 0 ? byDate + 1 : 0;
  };

  const placed = alerts.map((alert, index) => ({ alert, index, position: positionFor(alert) }));
  const rows: TimelineRowModel[] = [];
  for (let slot = 0; slot <= timeline.length; slot += 1) {
    for (const entry of placed) {
      if (entry.position === slot) rows.push({ kind: "alert", key: `alert-${entry.alert.id ?? entry.index}`, alert: entry.alert });
    }
    if (slot < timeline.length) rows.push({ kind: "item", key: timeline[slot].id, item: timeline[slot] });
  }
  return rows;
}

export function relatedIssues(date: string, items: TimelineItem[], issues: PlanningIssue[]) {
  const ids = new Set(items.map((item) => item.id));
  return issues.filter((issue) => issue.date === date || issue.item_ids?.some((id) => ids.has(id)));
}
