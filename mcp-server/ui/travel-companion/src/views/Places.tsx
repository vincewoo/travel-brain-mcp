import { useMemo } from "react";
import { PlaceRow } from "../components/rows";
import { BlankSlate } from "../components/states";
import { humanize, joinMeta, sentence } from "../../../shared/format";
import type { PlaceCard } from "../derive";
import { searchCards } from "../derive";
import { localAddress, mapLink } from "../format";

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
  onQuery: (value: string) => void;
  onCity: (value: string) => void;
  onStatus: (value: PlaceFilter) => void;
  onGroup: (value: PlaceGrouping) => void;
  onToggleGroup: (key: string) => void;
  onClear: () => void;
}

/** Visited is a recorded visit or the trip status saying so — the two do not always agree yet. */
const statusOf = (card: PlaceCard) => (card.visit ? "visited" : card.tripStatus || "shortlist");

export function PlacesView({ cards, query, city, status, group, openGroups, onQuery, onCity, onStatus, onGroup, onToggleGroup, onClear }: Props) {
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

  const filtered = Boolean(query) || city !== "all" || status !== "all";
  const unscheduled = cards.filter((card) => !card.scheduled && statusOf(card) === "shortlist").length;

  if (!cards.length) return <div className="view">
    <BlankSlate title="No places saved yet" detail="Places Claude saves for this trip arrive with the next sync." />
  </div>;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Places</h2>
        <span className="view-count">{joinMeta(`${cards.length} saved`, `${unscheduled} unscheduled`)}</span>
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
      return <section className="container" key={entry.label || "all"}>
        {group === "none" ? null : <button type="button" className="container-head sunken" aria-expanded={open} onClick={() => onToggleGroup(entry.label)}>
          <span className="head-label"><strong>{entry.label}</strong><span>{entry.items.length}</span></span>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>}
        {open || group === "none" ? entry.items.map((card) => {
          const local = localAddress(card.place.metadata);
          const link = mapLink(card.place);
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
              {link ? <a className="link" href={link}>Open in maps</a> : null}
            </div>
          </PlaceRow>;
        }) : null}
      </section>;
    }) : <div className="blank-slate centred">
      <strong>{query ? `Nothing matches “${query}”` : "Nothing matches these filters"}</strong>
      <p>Search covers name, category, area and your notes.</p>
      <button type="button" className="button" onClick={onClear}>Clear filters</button>
    </div>}
  </div>;
}
