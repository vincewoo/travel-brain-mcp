import { attentionMessage, isQueued, needsAttention } from "../outbox-queue.mjs";
import type { OutboxEntry } from "../outbox-queue.mjs";
import { joinMeta, plural } from "../../../shared/format";
import { relativeSince } from "../format";
import { captureLabel } from "./CaptureSheet";

/**
 * What this phone is still carrying, and what it could not deliver.
 *
 * The needs-attention list is the reason this sheet exists. A queued write that can no longer be
 * attached to what it pointed at — Claude deleted the item while the phone was dark — is never
 * dropped and never re-pointed at a neighbouring item by guesswork. It is shown, in the traveller's
 * own words, with the one decision only they can make: send it again, or let it go.
 */

const summary = (entry: OutboxEntry): string => {
  const payload = entry.payload as Record<string, any>;
  return payload.raw_note ?? payload.content ?? payload.name ?? payload.title ?? payload.place_name ?? "Captured write";
};

function EntryRow({ entry, busy, onRetry, onDiscard }: {
  entry: OutboxEntry;
  busy: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  return <article className="row">
    <div className="row-title-line">
      <strong>{captureLabel(entry.kind)}</strong>
      <span className="row-aside">{relativeSince(entry.created_at)}</span>
    </div>
    <p className="row-note">{summary(entry)}</p>
    {needsAttention(entry) ? <p className="row-meta">{attentionMessage(entry)}</p> : null}
    {isQueued(entry) && entry.attempts > 0 ? <p className="row-meta">{joinMeta(plural(entry.attempts, "attempt"), entry.last_error ?? "")}</p> : null}
    {onRetry || onDiscard ? <div className="row-actions">
      {onRetry ? <button type="button" className="link-button" disabled={busy} onClick={onRetry}>Try again</button> : null}
      {onDiscard ? <button type="button" className="link-button danger" disabled={busy} onClick={onDiscard}>Discard</button> : null}
    </div> : null}
  </article>;
}

export function SyncSheet({ entries, syncedAt, online, syncing, onSync, onRetry, onDiscard, onClose }: {
  entries: OutboxEntry[];
  syncedAt?: string;
  online: boolean;
  syncing: boolean;
  onSync: () => void;
  onRetry: (entry: OutboxEntry) => void;
  onDiscard: (entry: OutboxEntry) => void;
  onClose: () => void;
}) {
  const queued = entries.filter(isQueued);
  const parked = entries.filter(needsAttention);

  return <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Sync">
    <div className="sheet">
      <header className="sheet-head">
        <strong>Sync</strong>
        <button type="button" className="link-button quiet" onClick={onClose}>Close</button>
      </header>

      <div className="sheet-body">
        <section className="container">
          <div className="container-head">
            <strong>Last sync</strong>
            <span>{joinMeta(relativeSince(syncedAt), online ? "" : "offline")}</span>
          </div>
          <div className="sheet-line">
            <span>{queued.length ? plural(queued.length, "write") + " waiting to send" : "Nothing waiting to send"}</span>
            <button type="button" className="button" disabled={!online || syncing} onClick={onSync}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </section>

        {queued.length ? <section className="container">
          <div className="container-head"><strong>Queued</strong><span>oldest first</span></div>
          {queued.map((entry) => <EntryRow
            key={entry.op_id}
            entry={entry}
            busy={syncing}
            onDiscard={() => onDiscard(entry)}
          />)}
        </section> : null}

        {parked.length ? <section className="container">
          <div className="container-head"><strong>Needs attention</strong><span>{plural(parked.length, "write")}</span></div>
          {parked.map((entry) => <EntryRow
            key={entry.op_id}
            entry={entry}
            busy={syncing}
            onRetry={() => onRetry(entry)}
            onDiscard={() => onDiscard(entry)}
          />)}
          <p className="footnote">
            Nothing here was thrown away. Retry once the trip has caught up, or discard when you have
            read it.
          </p>
        </section> : null}
      </div>
    </div>
  </div>;
}
