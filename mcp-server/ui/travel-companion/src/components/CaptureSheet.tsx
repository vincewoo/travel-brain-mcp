import { useState } from "react";
import { humanize } from "../../../shared/format";
import type { PositionView } from "../derive";
import type { Origin, Place, Snapshot } from "../types";

/**
 * The capture box: five safe writes behind one button.
 *
 * Everything here works with the radio off, because everything here either appends something new or
 * records something that already happened. What is deliberately absent is as much the point: no
 * moving an item to another day, no adding a scheduled activity, no approving a proposal. Those
 * need judgement or a fresh read, and a phone in a tunnel has neither — they stay with Claude.
 *
 * The one guard worth reading twice is the visit rule. A visit is the evidence a firsthand
 * recommendation is checked against, so a second one for a place already visited is not clutter but
 * a false second sighting. Where the trip already holds a visit, the form says so and offers the
 * journal instead of quietly writing another.
 */

export type CaptureMode = "note" | "visit" | "place" | "preference";

export interface CaptureDraft {
  mode: CaptureMode;
  text: string;
  reaction: string;
  attachItemId: string;
  placeId: string;
  rating: number | null;
  wouldReturn: boolean | null;
  name: string;
  category: string;
  address: string;
  usePosition: boolean;
}

const MODES: { key: CaptureMode; label: string }[] = [
  { key: "note", label: "Note" },
  { key: "visit", label: "Rate a place" },
  { key: "place", label: "New place" },
  { key: "preference", label: "Preference" },
];

const blank = (mode: CaptureMode): CaptureDraft => ({
  mode,
  text: "",
  reaction: "",
  attachItemId: "",
  placeId: "",
  rating: null,
  wouldReturn: null,
  name: "",
  category: "",
  address: "",
  usePosition: false,
});

export function CaptureSheet({ snapshot, position, origin, visited, busy, offline, onCapture, onClose, onLocate }: {
  snapshot: Snapshot;
  position: PositionView;
  origin: Origin | null;
  /** Places with a visit already recorded or queued — the ones the rating form refuses to double. */
  visited: Set<string>;
  busy: boolean;
  offline: boolean;
  onCapture: (draft: CaptureDraft) => void;
  onClose: () => void;
  onLocate: () => void;
}) {
  const [draft, setDraft] = useState<CaptureDraft>(() => blank("note"));
  const set = (patch: Partial<CaptureDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const places: Place[] = snapshot.places.map((link) => link.places).sort((left, right) => left.name.localeCompare(right.name));
  const today = snapshot.itinerary.filter((item) => !["cancelled"].includes(item.status));

  const ready = draft.mode === "place"
    ? draft.name.trim().length > 0
    : draft.mode === "visit"
      ? Boolean(draft.placeId) && !visited.has(draft.placeId)
      : draft.text.trim().length > 0;

  return <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Capture">
    <div className="sheet">
      <header className="sheet-head">
        <strong>Capture</strong>
        <button type="button" className="link-button quiet" onClick={onClose}>Close</button>
      </header>

      <div className="chip-row sheet-modes">
        {MODES.map((entry) => <button
          type="button"
          key={entry.key}
          className={`chip${draft.mode === entry.key ? " active" : ""}`}
          onClick={() => setDraft(blank(entry.key))}
        >{entry.label}</button>)}
      </div>

      <div className="sheet-body">
        {draft.mode === "note" ? <>
          <label className="field">
            <span>What happened</span>
            <textarea
              rows={5}
              value={draft.text}
              placeholder="Your words, kept exactly as written."
              onChange={(event) => set({ text: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Reaction (optional)</span>
            <input value={draft.reaction} placeholder="loved it, too crowded, worth the queue…" onChange={(event) => set({ reaction: event.target.value })} />
          </label>
          <label className="field">
            <span>Attach to</span>
            <select value={draft.attachItemId} onChange={(event) => set({ attachItemId: event.target.value })}>
              <option value="">Nothing in particular</option>
              {position.now ? <option value={position.now.id}>{position.now.title} (now)</option> : null}
              {today.filter((item) => item.id !== position.now?.id).map((item) =>
                <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Place (optional)</span>
            <select value={draft.placeId} onChange={(event) => set({ placeId: event.target.value })}>
              <option value="">No place</option>
              {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
            </select>
          </label>
        </> : null}

        {draft.mode === "visit" ? <>
          <label className="field">
            <span>Where you have been</span>
            <select value={draft.placeId} onChange={(event) => set({ placeId: event.target.value })}>
              <option value="">Choose a saved place</option>
              {places.map((place) => <option key={place.id} value={place.id} disabled={visited.has(place.id)}>
                {place.name}{visited.has(place.id) ? " — already recorded" : ""}
              </option>)}
            </select>
          </label>
          <div className="field">
            <span>Rating</span>
            <div className="chip-row">
              {[1, 2, 3, 4, 5].map((score) => <button
                type="button"
                key={score}
                className={`chip${draft.rating === score ? " active" : ""}`}
                onClick={() => set({ rating: score })}
              >{score}</button>)}
            </div>
          </div>
          <div className="field">
            <span>Would you go back</span>
            <div className="chip-row">
              <button type="button" className={`chip${draft.wouldReturn === true ? " active" : ""}`} onClick={() => set({ wouldReturn: true })}>Yes</button>
              <button type="button" className={`chip${draft.wouldReturn === false ? " active" : ""}`} onClick={() => set({ wouldReturn: false })}>No</button>
            </div>
          </div>
          <label className="field">
            <span>Notes (optional)</span>
            <textarea rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
          </label>
          <p className="sheet-note">
            One visit per place, per trip. A place already visited keeps its first record — write a
            journal note about the second time instead.
          </p>
        </> : null}

        {draft.mode === "place" ? <>
          <label className="field">
            <span>Name</span>
            <input value={draft.name} placeholder="The noodle place under the bridge" onChange={(event) => set({ name: event.target.value })} />
          </label>
          <label className="field">
            <span>Category (optional)</span>
            <input value={draft.category} placeholder="restaurant, viewpoint, shop…" onChange={(event) => set({ category: event.target.value })} />
          </label>
          <label className="field">
            <span>Address (optional)</span>
            <input value={draft.address} onChange={(event) => set({ address: event.target.value })} />
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={draft.usePosition} disabled={!origin} onChange={(event) => set({ usePosition: event.target.checked })} />
            <span>
              {origin ? "Pin it where I am standing" : "No position yet — tap Locate to use GPS"}
              {!origin ? <button type="button" className="link-button" onClick={onLocate}>Locate</button> : null}
            </span>
          </label>
          <label className="field">
            <span>A note about it (optional)</span>
            <textarea rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
          </label>
          <p className="sheet-note">
            Saved as a shortlisted place. The GPS point is recorded as surveyed; anything typed from
            memory stays an estimate, and the map draws the difference.
          </p>
        </> : null}

        {draft.mode === "preference" ? <>
          <label className="field">
            <span>Something to remember</span>
            <textarea
              rows={4}
              value={draft.text}
              placeholder="No more than one museum a day."
              onChange={(event) => set({ text: event.target.value })}
            />
          </label>
          <p className="sheet-note">Stored as your own words, explicitly — not something Claude inferred about you.</p>
        </> : null}
      </div>

      <footer className="sheet-foot">
        <span className="sheet-status">
          {offline ? "Queued on this phone until there is a signal." : "Sent as soon as this is saved."}
        </span>
        <div className="button-row">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={!ready || busy} onClick={() => onCapture(draft)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  </div>;
}

/** The label a queued entry carries in the sync sheet, in the traveller's terms rather than the tool's. */
export const captureLabel = (kind: string) => humanize(
  { new_place: "new place", itinerary_status: "itinerary update", place_visit: "visit", journal_note: "journal note", preference: "preference" }[kind] ?? kind
);
