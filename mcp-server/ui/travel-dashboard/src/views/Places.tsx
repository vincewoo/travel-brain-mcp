import React, { useMemo } from "react";
import { PlaceRow } from "../components/rows";
import { BlankSlate } from "../components/states";
import { humanize, joinMeta } from "../../../shared/format";
import type { SavedPlace } from "../types";

export const PLACE_STATUSES = ["shortlist", "planned", "visited", "rejected"] as const;
export type PlaceFilter = "all" | typeof PLACE_STATUSES[number];
export type PlaceGrouping = "category" | "locality" | "status" | "none";

const GROUPINGS: { key: PlaceGrouping; label: string }[] = [
  { key: "category", label: "Category" },
  { key: "locality", label: "City / area" },
  { key: "status", label: "Status" },
  { key: "none", label: "Flat list" },
];
const UNKNOWN_AREA = "Unknown area";
const areaOf = (place: SavedPlace) => place.locality ?? place.region ?? UNKNOWN_AREA;

/** Search covers the fields the user can see, notes included — research detail lives there. */
const haystack = (place: SavedPlace) =>
  [place.name, place.category, place.locality, place.note, place.trip_status].filter(Boolean).join(" ").toLowerCase();

interface Props {
  places: SavedPlace[];
  query: string;
  city: string;
  status: PlaceFilter;
  group: PlaceGrouping;
  openGroups: Record<string, boolean>;
  busy: string | null;
  onQuery: (value: string) => void;
  onCity: (value: string) => void;
  onStatus: (value: PlaceFilter) => void;
  onGroup: (value: PlaceGrouping) => void;
  onToggleGroup: (key: string) => void;
  onClear: () => void;
  ask: (key: string, label: string, instruction: string) => void;
}

export function PlacesView({ places, query, city, status, group, openGroups, busy, onQuery, onCity, onStatus, onGroup, onToggleGroup, onClear, ask }: Props) {
  const model = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const searched = places.filter((place) => { const text = haystack(place); return terms.every((term) => text.includes(term)); });
    // Counts are scope-aware: a chip never offers a filter that would return nothing.
    const byStatusScope = searched.filter((place) => city === "all" || areaOf(place) === city);
    const byCityScope = searched.filter((place) => status === "all" || (place.trip_status ?? "shortlist") === status);
    const visible = byStatusScope.filter((place) => status === "all" || (place.trip_status ?? "shortlist") === status);

    const areaCounts = new Map<string, number>();
    for (const place of byCityScope) areaCounts.set(areaOf(place), (areaCounts.get(areaOf(place)) ?? 0) + 1);
    if (city !== "all" && !areaCounts.has(city)) areaCounts.set(city, 0);

    const groupKey = (place: SavedPlace) => group === "category" ? humanize(place.category ?? "Other")
      : group === "locality" ? areaOf(place)
      : group === "status" ? humanize(place.trip_status ?? "shortlist")
      : "";
    const grouped = new Map<string, SavedPlace[]>();
    for (const place of visible) {
      const key = groupKey(place);
      grouped.set(key, [...(grouped.get(key) ?? []), place]);
    }
    const groups = [...grouped.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

    return {
      visible,
      groups,
      statusChips: [
        { key: "all" as PlaceFilter, label: "All", count: byStatusScope.length },
        ...PLACE_STATUSES.map((value) => ({
          key: value as PlaceFilter, label: humanize(value),
          count: byStatusScope.filter((place) => (place.trip_status ?? "shortlist") === value).length,
        })),
      ].filter((chip) => chip.count > 0 || chip.key === "all" || chip.key === status),
      areaOptions: [
        { value: "all", label: `All areas (${byCityScope.length})` },
        ...[...areaCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ value: label, label: `${label} (${count})` })),
      ],
    };
  }, [places, query, city, status, group]);

  const filtered = Boolean(query) || city !== "all" || status !== "all";
  // The same definition db.mjs uses for the unscheduled tray: shortlisted but not on the itinerary.
  const unscheduled = places.filter((place) => !place.scheduled && (place.trip_status ?? "shortlist") === "shortlist").length;

  if (!places.length) return <div className="view">
    <BlankSlate
      title="No places saved yet"
      detail="Ask Claude to research the trip and anything worth keeping lands here."
      action={{ label: "Find places to consider", onPick: () => ask("find-places", "Asking Claude to research places…", "Research candidate places for this trip and save the ones worth keeping.") }}
    />
  </div>;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Places</h2>
        <span className="view-count">{joinMeta(`${places.length} saved`, `${unscheduled} unscheduled`)}</span>
      </div>
      <button type="button" className="button" onClick={() => ask("review-places", "Asking Claude to review places…", "Review saved places and separate must-do options, useful backups, and low-priority ideas without scheduling research automatically.")}>Review with Claude</button>
    </div>

    <div className="search-row">
      <div className="search">
        <span aria-hidden="true">⌕</span>
        <input type="search" value={query} placeholder="Search places, areas, notes" aria-label="Search places" onChange={(event) => onQuery(event.target.value)} />
      </div>
      <select className="area-select" value={city} aria-label="Filter by area" onChange={(event) => onCity(event.target.value)}>
        {model.areaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>

    <div className="chip-row">
      {model.statusChips.map((chip) => <button
        key={chip.key}
        type="button"
        className={`chip${status === chip.key ? " active" : ""}`}
        aria-pressed={status === chip.key}
        onClick={() => onStatus(chip.key)}
      >{chip.label} {chip.count}</button>)}
    </div>

    <div className="group-row">
      <div>
        <label id="group-by-label">Group by</label>
        <div className="segments" role="group" aria-labelledby="group-by-label">
          {GROUPINGS.map((option) => <button
            key={option.key}
            type="button"
            className={`seg${group === option.key ? " active" : ""}`}
            aria-pressed={group === option.key}
            onClick={() => onGroup(option.key)}
          >{option.label}</button>)}
        </div>
      </div>
      {filtered ? <button type="button" className="link-button" onClick={onClear}>Clear filters</button> : null}
    </div>

    {model.visible.length ? model.groups.map((entry) => {
      const open = openGroups[entry.label] !== false;
      const plan = (place: SavedPlace) => ask(`plan-${place.id}`, `Asking Claude where ${place.name} fits…`, `Find a sensible itinerary slot for “${place.name}” (${place.id}) and prepare a proposal without committing it.`);
      return <section className="container" key={entry.label || "all"}>
        {group === "none" ? null : <button type="button" className="container-head sunken" aria-expanded={open} onClick={() => onToggleGroup(entry.label)}>
          <span className="head-label"><strong>{entry.label}</strong><span>{entry.items.length}</span></span>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>}
        {open || group === "none" ? entry.items.map((place) => <PlaceRow key={place.id} place={place} busy={Boolean(busy)} onPlan={plan} />) : null}
      </section>;
    }) : <div className="blank-slate centred">
      <strong>{query ? `Nothing matches “${query}”` : "Nothing matches these filters"}</strong>
      <p>Search covers name, category, area and your notes.</p>
      <button type="button" className="button" onClick={onClear}>Clear filters</button>
    </div>}
  </div>;
}
