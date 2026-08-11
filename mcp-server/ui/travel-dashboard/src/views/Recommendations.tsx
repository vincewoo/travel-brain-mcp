import React from "react";
import { NoteEmpty } from "../components/states";
import { humanize, joinMeta, plural, sentence } from "../format";
import type { RecommendationItem, RecommendationsOverview } from "../types";

interface Props {
  recommendations: RecommendationsOverview;
  ask: (key: string, label: string, instruction: string) => void;
}

const GROUPS = [
  { key: "firsthand", label: "Firsthand", detail: (count: number) => `you went, ${plural(count, "place")}`, empty: "Nothing you've recommended is from a visit yet." },
  { key: "mixed", label: "Mixed evidence", detail: (count: number) => `${plural(count, "place")}`, empty: "No recommendation mixes a visit with research." },
  { key: "research", label: "Research only", detail: (count: number) => `not visited, ${plural(count, "place")}`, empty: "Everything you'd recommend, you've actually been to." },
];

function Row({ item }: { item: RecommendationItem }) {
  const { recommendation: rec, place } = item;
  const strong = rec.level === "strongly_recommend";
  return <article className="row">
    <div className="row-title-line">
      <strong>{place.name}</strong>
      <span className={`level${strong ? " ok" : ""}`}>{sentence(rec.level ?? "recommend")}</span>
    </div>
    <p className="row-meta">{joinMeta(
      humanize(place.category ?? "place"),
      place.locality ?? place.region ?? "",
      place.research_count ? plural(place.research_count, "source") : "",
    )}</p>
    {rec.shareable_note ? <p className="rec-note">{rec.shareable_note}</p> : null}
    {rec.caveats ? <p className="rec-caveat">Caveat · {rec.caveats}</p> : null}
    {rec.best_for?.length ? <p className="rec-best">Best for {rec.best_for.join(", ")}</p> : null}
  </article>;
}

export function RecommendationsView({ recommendations, ask }: Props) {
  const all = recommendations.recommendations;
  const firsthand = all.filter((item) => item.recommendation.provenance === "firsthand").length;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Recommendations</h2>
        <span className="view-count">{joinMeta(`${all.length} total`, `${firsthand} firsthand`)}</span>
      </div>
      <button type="button" className="button primary" disabled={!all.length} onClick={() => ask("guide", "Asking Claude to write the guide…", "Create a friend guide with provenance, caveats, and best-for notes; never expose private journal text.")}>Generate friend guide</button>
    </div>
    {GROUPS.map((group) => {
      const items = all.filter((item) => item.recommendation.provenance === group.key);
      if (!items.length) return <NoteEmpty key={group.key} title={`No ${group.label.toLowerCase()} recommendations`} detail={group.empty} />;
      return <section className="container" key={group.key}>
        <div className="container-head sunken">
          <span className="head-label"><strong>{group.label}</strong><span>· {group.detail(items.length)}</span></span>
        </div>
        {items.map((item, index) => <Row key={item.recommendation.id ?? `${item.place.id}-${index}`} item={item} />)}
      </section>;
    })}
  </div>;
}
