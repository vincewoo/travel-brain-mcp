import React from "react";
import { BlankSlate } from "../components/states";
import { dateTimeLabel, joinMeta, plural, sentence, timeLabel, timeRangeLabel } from "../format";
import type { JournalEntry, JournalOverview } from "../types";

interface Props {
  journal: JournalOverview;
  ask: (key: string, label: string, instruction: string) => void;
}

/** The visit context collapses to one line so the raw note stays the loudest thing in the card. */
function VisitContext({ entry }: { entry: JournalEntry }) {
  const item = entry.itinerary_items;
  if (!item) return null;
  const range = timeRangeLabel(item.actual_start ?? item.planned_start, item.actual_end ?? item.planned_end);
  const shifted = item.actual_start && item.planned_start && timeLabel(item.actual_start) !== timeLabel(item.planned_start);
  return <div className="visit-context">
    <span>{range}</span>
    <span>{joinMeta(item.title, shifted ? `planned ${timeLabel(item.planned_start)}` : "", item.status === "completed" ? "done" : sentence(item.status).toLowerCase())}</span>
  </div>;
}

export function JournalView({ journal, ask }: Props) {
  const remember = () => ask("journal", "Asking Claude to capture a note…", "Help me capture a raw journal note and relevant context without rewriting my words.");

  if (!journal.entries.length) return <div className="view">
    <BlankSlate
      title="No journal entries yet"
      detail="Capture moments in your own words. Travel Brain keeps the raw note and never rewrites it."
      action={{ label: "Remember something", onPick: remember, primary: true }}
    />
  </div>;

  return <div className="view">
    <div className="view-head">
      <div>
        <h2>Journal</h2>
        <span className="view-count">{plural(journal.entries.length, "note")} · raw text is never rewritten</span>
      </div>
      <button type="button" className="button primary" onClick={remember}>Remember something</button>
    </div>
    {journal.entries.map((entry) => <article className="journal-card" key={entry.id}>
      <header>
        <strong>{entry.places?.name ?? entry.itinerary_items?.title ?? "Trip note"}</strong>
        <time>{joinMeta(dateTimeLabel(entry.captured_at), (entry.visibility ?? "private").replaceAll("_", " "))}</time>
      </header>
      <p className="raw-note">{entry.raw_note}</p>
      {entry.reaction ? <p className="reaction">Reaction · {entry.reaction}</p> : null}
      <VisitContext entry={entry} />
    </article>)}
  </div>;
}
