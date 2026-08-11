import { BlankSlate, NoteEmpty } from "../components/states";
import {
  dateTimeLabel,
  humanize,
  joinMeta,
  plural,
  RECOMMENDATION_GROUPS,
  sentence,
  timeLabel,
  timeRangeLabel,
} from "../../../shared/format";
import type { RecommendationCard } from "../derive";
import type { ItineraryItem, JournalEntry, Place, Snapshot } from "../types";

/**
 * What the trip has already produced: the notes in the traveller's own words, and what they would
 * tell a friend.
 *
 * Read-only, like the rest of Phase 1 — the capture box belongs to Phase 2. Two things are kept
 * exactly as the dashboard keeps them because they are product invariants rather than layout:
 * `raw_note` is rendered verbatim and never the generated summary, and recommendations stay split
 * by provenance so a research-only tip can never be mistaken for somewhere you have been.
 */

function VisitContext({ item, zone }: { item: ItineraryItem | undefined; zone: string }) {
  if (!item) return null;
  const range = timeRangeLabel(item.actual_start ?? item.planned_start, item.actual_end ?? item.planned_end, zone);
  const shifted = item.actual_start && item.planned_start && timeLabel(item.actual_start, zone) !== timeLabel(item.planned_start, zone);
  return <div className="visit-context">
    <span>{range}</span>
    <span>{joinMeta(item.title, shifted ? `planned ${timeLabel(item.planned_start, zone)}` : "", item.status === "completed" ? "done" : sentence(item.status).toLowerCase())}</span>
  </div>;
}

function RecommendationRow({ card }: { card: RecommendationCard }) {
  const { recommendation } = card;
  const strong = recommendation.level === "strongly_recommend";
  return <article className="row">
    <div className="row-title-line">
      <strong>{card.place?.name ?? "Saved place"}</strong>
      <span className={`level${strong ? " ok" : ""}`}>{sentence(recommendation.level ?? "recommend")}</span>
    </div>
    <p className="row-meta">{joinMeta(
      humanize(card.place?.category ?? "place"),
      card.place?.locality ?? card.place?.region ?? "",
      card.researchCount ? plural(card.researchCount, "source") : "",
    )}</p>
    {recommendation.shareable_note ? <p className="rec-note">{recommendation.shareable_note}</p> : null}
    {recommendation.caveats ? <p className="rec-caveat">Caveat · {recommendation.caveats}</p> : null}
    {recommendation.best_for?.length ? <p className="rec-best">Best for {recommendation.best_for.join(", ")}</p> : null}
  </article>;
}

export function JournalView({ snapshot, entries, recommendations, places, items }: {
  snapshot: Snapshot;
  entries: JournalEntry[];
  recommendations: RecommendationCard[];
  places: Map<string, Place>;
  items: Map<string, ItineraryItem>;
}) {
  const zone = snapshot.trip.timezone;
  const firsthand = recommendations.filter((card) => card.recommendation.provenance === "firsthand").length;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Journal</h2>
        <span className="view-count">{plural(entries.length, "note")} · raw text is never rewritten</span>
      </div>
    </div>

    {entries.length ? entries.map((entry) => <article className="journal-card" key={entry.id}>
      <header>
        <strong>{(entry.place_id ? places.get(entry.place_id)?.name : null)
          ?? (entry.itinerary_item_id ? items.get(entry.itinerary_item_id)?.title : null)
          ?? "Trip note"}</strong>
        <time>{joinMeta(dateTimeLabel(entry.captured_at, zone), (entry.visibility ?? "private").replaceAll("_", " "))}</time>
      </header>
      <p className="raw-note">{entry.raw_note}</p>
      {entry.reaction ? <p className="reaction">Reaction · {entry.reaction}</p> : null}
      <VisitContext item={entry.itinerary_item_id ? items.get(entry.itinerary_item_id) : undefined} zone={zone} />
    </article>) : <BlankSlate
      title="No journal entries yet"
      detail="Notes captured with Claude land here on the next sync, in your own words."
    />}

    <div className="view-head">
      <div>
        <h2>Recommendations</h2>
        <span className="view-count">{joinMeta(`${recommendations.length} total`, `${firsthand} firsthand`)}</span>
      </div>
    </div>

    {RECOMMENDATION_GROUPS.map((group) => {
      const cards = recommendations.filter((card) => card.recommendation.provenance === group.key);
      if (!cards.length) return <NoteEmpty key={group.key} title={`No ${group.label.toLowerCase()} recommendations`} detail={group.empty} />;
      return <section className="container" key={group.key}>
        <div className="container-head sunken">
          <span className="head-label"><strong>{group.label}</strong><span>· {group.detail(cards.length)}</span></span>
        </div>
        {cards.map((card) => <RecommendationRow key={card.recommendation.id} card={card} />)}
      </section>;
    })}
  </div>;
}
