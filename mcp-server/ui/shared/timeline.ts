import { zoneDate } from "./format";

/**
 * Where an alert belongs in a timeline. Shared by both surfaces so a conflict appears at the same
 * point in the day on the phone as it does in the dashboard.
 *
 * The row shapes are structural rather than imported: the dashboard reads items from
 * `get_today` / `get_plan_overview` and the companion reads the raw rows out of its cached
 * snapshot, and the placement rule only ever needs an id, a start, and the ids an alert points at.
 */

export interface AlertLike {
  id?: string;
  date?: string | null;
  item_ids?: string[];
}

export interface ItemLike {
  id: string;
  planned_start?: string | null;
  actual_start?: string | null;
}

export type TimelineRowModel<Item extends ItemLike, Alert extends AlertLike> =
  | { kind: "item"; key: string; item: Item }
  | { kind: "alert"; key: string; alert: Alert };

/**
 * Each alert renders immediately after the timeline item its `item_ids` points at.
 * Failing that it follows the last item sharing its date, and failing that it goes to the top.
 *
 * An alert's `date` is a trip-local day, so the item instants it is matched against have to be
 * resolved in the trip's zone too — a UTC reading would misplace anything either side of midnight.
 */
export function withAlerts<Item extends ItemLike, Alert extends AlertLike>(
  timeline: Item[],
  alerts: Alert[],
  zone: string,
): TimelineRowModel<Item, Alert>[] {
  const positionFor = (alert: Alert) => {
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
  const rows: TimelineRowModel<Item, Alert>[] = [];
  for (let slot = 0; slot <= timeline.length; slot += 1) {
    for (const entry of placed) {
      if (entry.position === slot) rows.push({ kind: "alert", key: `alert-${entry.alert.id ?? entry.index}`, alert: entry.alert });
    }
    if (slot < timeline.length) rows.push({ kind: "item", key: timeline[slot].id, item: timeline[slot] });
  }
  return rows;
}

/** The issues that bite on one day: dated to it, or pointing at something scheduled on it. */
export function relatedIssues<Item extends ItemLike, Alert extends AlertLike>(date: string, items: Item[], issues: Alert[]) {
  const ids = new Set(items.map((item) => item.id));
  return issues.filter((issue) => issue.date === date || issue.item_ids?.some((id) => ids.has(id)));
}
