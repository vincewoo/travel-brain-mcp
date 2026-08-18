import {
  applyOperation,
  applyResult,
  flagForAttention,
  isQueued,
  pendingPlaceIds,
  queueOperation,
  recordFailure,
  resolveOperation,
  sortQueue,
} from "./outbox-queue.mjs";
import type { OutboxEntry, OutboxKind, OutboxPayload, ToolResult } from "./outbox-queue.mjs";
import { openWriter, SignInRequiredError, UnauthorizedError } from "./mcp";
import { deleteOutboxEntry, readOutbox, writeOutboxEntry } from "./store";
import type { Snapshot } from "./types";

/**
 * The capture queue with a disk and a network attached.
 *
 * The rules are all in `outbox-queue.mjs`; this module is what makes them durable (IndexedDB, one
 * row per operation, so a phone closed mid-replay resumes rather than restarts) and what actually
 * sends them. Replay is FIFO and one at a time — a place saved offline has to reach the server
 * before the note written beside it can point at anything.
 *
 * Nothing here decides *whether* a write may be captured offline. That question was answered once,
 * in the list of kinds: everything queueable appends something new or records something that
 * already happened.
 */

export type { OutboxEntry } from "./outbox-queue.mjs";

export async function loadOutbox(): Promise<OutboxEntry[]> {
  return sortQueue(await readOutbox<OutboxEntry>());
}

/** Capture something. Written to disk before it is shown, so a killed tab never loses it. */
export async function enqueue<P extends OutboxPayload>(kind: OutboxKind, payload: P): Promise<OutboxEntry<P>> {
  const entry = queueOperation(kind, payload);
  await writeOutboxEntry(entry);
  return entry;
}

/** Put a parked entry back in the queue — the traveller's answer to "try this again". */
export async function retry(entry: OutboxEntry): Promise<void> {
  await writeOutboxEntry({ ...entry, state: "queued", attempts: 0, last_error: null, attention_reason: null });
}

/**
 * Drop an entry for good. Only ever from an explicit tap on a queue the traveller can read first:
 * discarding a note silently is the one thing this app promised never to do.
 */
export const discard = (entry: OutboxEntry): Promise<void> => deleteOutboxEntry(entry.op_id);

/** The trip as this phone sees it: what Travel Brain sent, plus everything still on its way there. */
export function withPending(snapshot: Snapshot, entries: OutboxEntry[]): Snapshot {
  return entries.reduce(applyOperation, snapshot);
}

export interface FlushResult {
  entries: OutboxEntry[];
  sent: number;
  /** True when something landed, so the caller knows a re-sync is worth the round trip. */
  changed: boolean;
}

/**
 * Send what is queued, oldest first.
 *
 * `snapshot` is the most recent one from the server, and it is what the conflict rules are checked
 * against: an item deleted while the phone was dark is an item missing from that snapshot, which is
 * how a status update for something that no longer exists gets parked instead of failing five times
 * against a server that will never accept it.
 *
 * The run stops early on a lost session or a lost connection — neither is the write's fault, and
 * burning attempts on a tunnel would eventually park perfectly good notes.
 */
export async function flushOutbox(snapshot: Snapshot | null): Promise<FlushResult> {
  const queue = await loadOutbox();
  if (!queue.some(isQueued)) return { entries: queue, sent: 0, changed: false };

  const writer = await openWriter();
  const idMap = new Map<string, string>();
  let working = snapshot;
  let sent = 0;
  try {
    for (const entry of queue) {
      if (!isQueued(entry)) continue;
      const resolution = resolveOperation(entry, {
        snapshot: working,
        idMap,
        pending: pendingPlaceIds(queue),
      });
      if (resolution.action === "hold") continue;
      if (resolution.action === "attention") {
        await writeOutboxEntry(flagForAttention(entry, resolution.reason));
        continue;
      }
      try {
        const result = await writer.call<ToolResult>(resolution.request.name, resolution.request.arguments);
        if (working) {
          const applied = applyResult(working, entry, result);
          working = applied.snapshot;
          if (applied.mapping) idMap.set(applied.mapping[0], applied.mapping[1]);
        }
        await deleteOutboxEntry(entry.op_id);
        sent += 1;
      } catch (caught) {
        if (caught instanceof SignInRequiredError || caught instanceof UnauthorizedError) throw caught;
        await writeOutboxEntry(recordFailure(entry, caught));
        if (!navigator.onLine) break;
      }
    }
  } finally {
    await writer.close().catch(() => undefined);
  }
  return { entries: await loadOutbox(), sent, changed: sent > 0 };
}
