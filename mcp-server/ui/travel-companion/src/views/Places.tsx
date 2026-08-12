import { useMemo, useState } from "react";
import { MapPanel } from "../components/MapPanel";
import { MapLinks, PlaceRow } from "../components/rows";
import { BlankSlate } from "../components/states";
import { humanize, joinMeta, placeStatus, sentence } from "../../../shared/format";
import type { PlaceCard } from "../derive";
import { searchCards } from "../derive";
import { localAddress } from "../format";
import type { Origin } from "../types";

/**
 * Everything saved for the trip, filtered on the phone — no server round trip to search.
 *
 * The controls are the dashboard's: search, area, status chips with live counts, and a grouping
 * that can be category, area, status or a flat list. The rows carry more than the dashboard's do,
 * because offline this list is the research: address in local script, the note, what the visit was
 * like, and the first couple of findings.
 */

export const PLACE_STATUSES = ["shortlist", "planned", "visited", "rejected"] as const;
export type PlaceFilter = "all" | (typeof PLACE_STATUSES)[number];
export type PlaceGrouping = "category" | "locality" | "status" | "none";
export type PlacesMode = "list" | "map";

const GROUPINGS: { key: PlaceGrouping; label: string }[] = [
  { key: "category", label: "Category" },
  { key: "locality", label: "City / area" },
  { key: "status", label: "Status" },
  { key: "none", label: "Flat list" },
];
const UNKNOWN_AREA = "Unknown area";
const areaOf = (card: PlaceCard) => card.place.locality ?? card.place.region ?? UNKNOWN_AREA;

interface Props {
  cards: PlaceCard[];
  query: string;
  city: string;
  status: PlaceFilter;
  group: PlaceGrouping;
  openGroups: Record<string, boolean>;
  origin: Origin | null;
  mode: PlacesMode;
  offline: boolean;
  mapsEnabled: boolean;
  onMode: (value: PlacesMode) => void;
  onEnableMaps: () => void;
  onQuery: (value: string) => void;
  onCity: (value: string) => void;
  onStatus: (value: PlaceFilter) => void;
  onGroup: (value: PlaceGrouping) => void;
  onToggleGroup: (key: string) => void;
  onClear: () => void;
}

/** Visited is a recorded visit or the trip status saying so — the two do not always agree yet. */
const statusOf = (card: PlaceCard) => (card.visit ? "visited" : card.tripStatus || "shortlist");

export function PlacesView({ cards, query, city, status, group, openGroups, origin, mode, offline, mapsEnabled, onMode, onEnableMaps, onQuery, onCity, onStatus, onGroup, onToggleGroup, onClear }: Props) {
  const model = useMemo(() => {
    const searched = searchCards(cards, query);
    // Counts are scope-aware: a chip never offers a filter that would return nothing.
    const byStatusScope = searched.filter((card) => city === "all" || areaOf(card) === city);
    const byCityScope = searched.filter((card) => status === "all" || statusOf(card) === status);
    const visible = byStatusScope
      .filter((card) => status === "all" || statusOf(card) === status)
      .sort((left, right) => {
        if (left.distanceMeters !== null && right.distanceMeters !== null) return left.distanceMeters - right.distanceMeters;
        return left.place.name.localeCompare(right.place.name);
      });

    const areaCounts = new Map<string, number>();
    for (const card of byCityScope) areaCounts.set(areaOf(card), (areaCounts.get(areaOf(card)) ?? 0) + 1);
    if (city !== "all" && !areaCounts.has(city)) areaCounts.set(city, 0);

    const groupKey = (card: PlaceCard) => group === "category" ? humanize(card.place.category ?? "Other")
      : group === "locality" ? areaOf(card)
      : group === "status" ? humanize(statusOf(card))
      : "";
    const grouped = new Map<string, PlaceCard[]>();
    for (const card of visible) grouped.set(groupKey(card), [...(grouped.get(groupKey(card)) ?? []), card]);
    const groups = [...grouped.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

    return {
      visible,
      groups,
      statusChips: [
        { key: "all" as PlaceFilter, label: "All", count: byStatusScope.length },
        ...PLACE_STATUSES.map((value) => ({
          key: value as PlaceFilter,
          label: humanize(value),
          count: byStatusScope.filter((card) => statusOf(card) === value).length,
        })),
      ].filter((chip) => chip.count > 0 || chip.key === "all" || chip.key === status),
      areaOptions: [
        { value: "all", label: `All areas (${byCityScope.length})` },
        ...[...areaCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ value: label, label: `${label} (${count})` })),
      ],
    };
  }, [cards, query, city, status, group]);

  // Which pin the traveller last tapped. Transient presentation state, deliberately not persisted:
  // it means "the one I am looking at", not a selection the trip should remember.
  const [picked, setPicked] = useState<string | null>(null);

  const filtered = Boolean(query) || city !== "all" || status !== "all";
  const unscheduled = cards.filter((card) => !card.scheduled && statusOf(card) === "shortlist").length;

  // The map draws exactly what the list would: search, area and status chips all still apply, so
  // the two modes never disagree about what is on screen.
  const pins = model.visible.map((card) => ({
    id: card.place.id,
    label: card.place.name,
    latitude: card.place.latitude,
    longitude: card.place.longitude,
    tone: placeStatus(card.tripStatus, card.researchFreshness).dot,
    muted: statusOf(card) === "rejected",
  }));
  const pickedCard = model.visible.find((card) => card.place.id === picked) ?? null;

  if (!cards.length) return <div className="view">
    <BlankSlate title="No places saved yet" detail="Places Claude saves for this trip arrive with the next sync." />
  </div>;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Places</h2>
        <span className="view-count">{joinMeta(`${cards.length} saved`, `${unscheduled} unscheduled`)}</span>
      </div>
      <div className="segments" role="group" aria-label="Show places as">
        {(["list", "map"] as PlacesMode[]).map((option) => <button
          key={option}
          type="button"
          className={`seg${mode === option ? " active" : ""}`}
          aria-pressed={mode === option}
          onClick={() => onMode(option)}
        >{humanize(option)}</button>)}
      </div>
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

    {/* Grouping is a property of the list. On the map, geography does the grouping. */}
    {mode === "list" ? <div className="group-row">
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
    </div> : filtered ? <div className="group-row">
      <button type="button" className="link-button" onClick={onClear}>Clear filters</button>
    </div> : null}

    {mode === "map" && model.visible.length ? <section className="container">
      <MapPanel
        points={pins}
        total={model.visible.length}
        origin={origin}
        height={320}
        offline={offline}
        enabled={mapsEnabled}
        onEnable={onEnableMaps}
        onSelect={setPicked}
      />
      {/* Tapping a pin opens the row that is already the answer everywhere else in this app,
          rather than a second, map-only way of describing a place. */}
      {pickedCard ? <PlaceRow card={pickedCard}>
        <div className="detail">
          {pickedCard.place.address ? <div className="address">{pickedCard.place.address}</div> : null}
          {localAddress(pickedCard.place.metadata) ? <div className="address-local">{localAddress(pickedCard.place.metadata)}</div> : null}
          {pickedCard.visit?.notes ? <div className="notes">Visit · {pickedCard.visit.notes}</div> : null}
          <MapLinks place={pickedCard.place} origin={origin ?? undefined} />
        </div>
      </PlaceRow> : <p className="footnote">Tap a pin to see the place.</p>}
    </section> : null}

    {mode === "list" && model.visible.length ? model.groups.map((entry) => {
      const open = openGroups[entry.label] !== false;
      return <section className="container" key={entry.label || "all"}>
        {group === "none" ? null : <button type="button" className="container-head sunken" aria-expanded={open} onClick={() => onToggleGroup(entry.label)}>
          <span className="head-label"><strong>{entry.label}</strong><span>{entry.items.length}</span></span>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>}
        {open || group === "none" ? entry.items.map((card) => {
          const local = localAddress(card.place.metadata);
          return <PlaceRow card={card} key={card.place.id}>
            <div className="detail">
              {card.place.address ? <div className="address">{card.place.address}</div> : null}
              {local ? <div className="address-local">{local}</div> : null}
              {card.visit?.notes ? <div className="notes">Visit · {card.visit.notes}</div> : null}
              {card.recommendation?.shareable_note
                ? <div className="notes">{sentence(card.recommendation.provenance)} · {card.recommendation.shareable_note}</div>
                : null}
              {card.research.slice(0, 2).map((entry) => <div className="notes" key={entry.id}>
                <strong>{entry.topic}:</strong> {entry.summary ?? entry.finding}
              </div>)}
              <MapLinks place={card.place} origin={origin ?? undefined} />
            </div>
          </PlaceRow>;
        }) : null}
      </section>;
    }) : null}

    {/* One empty state for both modes: an empty map and an empty list are the same fact. */}
    {model.visible.length ? null : <div className="blank-slate centred">
      <strong>{query ? `Nothing matches “${query}”` : "Nothing matches these filters"}</strong>
      <p>Search covers name, category, area and your notes.</p>
      <button type="button" className="button" onClick={onClear}>Clear filters</button>
    </div>}
  </div>;
}
