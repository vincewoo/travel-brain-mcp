/**
 * The rules an offline capture queue runs by: what a queued write becomes on the wire, what it
 * looks like on the phone before it lands, and what happens to it when the trip moved underneath.
 *
 * It is plain JavaScript, and it holds no IndexedDB and no MCP client, for the same reason
 * `map-source.mjs` is: the app has no DOM test runner, and "a journal note whose itinerary item was
 * deleted keeps its words" is a rule worth testing somewhere other than by eye. `outbox.ts` gives
 * these functions durability and `mcp.ts` gives them a network; the decisions are all here.
 *
 * Two things every rule below is written against:
 *
 * 1. Nothing queued needs judgement. Each kind either appends something new or records something
 *    that already happened, so a write held for six hours in a tunnel is still true when it lands.
 * 2. The traveller's words always survive. When a queued write can no longer be attached to what it
 *    pointed at, the pointer is what gets dropped — never the note.
 */

/**
 * How many failed sends before an entry stops being retried and starts being reported.
 *
 * Retrying forever is how a queue quietly becomes a place writes go to die: every sync spends its
 * first seconds re-sending something that will never work, and the traveller is never told. Five
 * attempts is enough to ride out a bad hotel connection and few enough that a genuine rejection
 * surfaces the same day.
 */
export const MAX_ATTEMPTS = 5;

/** Local ids are prefixed so nothing can mistake one for a server uuid — not a row, not a tool call. */
export const PENDING_PREFIX = "pending:";

export const isPendingId = (id) => typeof id === "string" && id.startsWith(PENDING_PREFIX);

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

/** An id for a row that exists only on this phone so far. */
export const pendingId = () => `${PENDING_PREFIX}${uuid()}`;

/**
 * The five writes that may be captured without a connection.
 *
 * The test each one passed: it records something that already happened or the traveller's own
 * intent, it cannot conflict in a way that loses information, and it needs nothing the phone does
 * not already know. `update_current_trip_state` fails the first (a location delivered four hours
 * late is a false statement) and committing a proposal fails the second, so neither is here.
 */
export const OUTBOX_KINDS = ["new_place", "itinerary_status", "place_visit", "journal_note", "preference"];

/**
 * Build a queue entry. `op_id` is the idempotency key the append tools store in the row's metadata,
 * so a reply lost on the way back costs a duplicate note only if the key changes — which is why it
 * is generated once, here, and never regenerated on retry.
 */
export function queueOperation(kind, payload, at = new Date()) {
  if (!OUTBOX_KINDS.includes(kind)) throw new Error(`${kind} is not a queueable operation.`);
  return {
    op_id: uuid(),
    kind,
    payload,
    created_at: at.toISOString(),
    attempts: 0,
    last_error: null,
    state: "queued",
    attention_reason: null,
  };
}

/** FIFO, and stable: a place saved before the note about it is replayed before it. */
export const sortQueue = (entries) =>
  [...entries].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.op_id.localeCompare(right.op_id));

export const isQueued = (entry) => entry.state === "queued";
export const needsAttention = (entry) => entry.state === "attention";

export function outboxSummary(entries) {
  const queued = entries.filter(isQueued);
  return {
    queued: queued.length,
    failing: queued.filter((entry) => entry.attempts > 0).length,
    attention: entries.filter(needsAttention).length,
  };
}

const itemExists = (snapshot, id) => Boolean(id) && snapshot.itinerary.some((item) => item.id === id);
const placeExists = (snapshot, id) => Boolean(id) && snapshot.places.some((link) => link.place_id === id);

/**
 * Turn one queued entry into the tool call that will land it, against the trip as it is now.
 *
 * The interesting half is the conflict rules. Everything queued is an append or a record of the
 * past, so the only real collision is the one where Claude moved or deleted the thing the phone was
 * pointing at while the phone was dark:
 *
 * - A status or actual-time update for an item that is gone cannot be replayed at all and cannot be
 *   guessed at a different item. It goes to needs-attention with what was recorded, and stays
 *   readable until the traveller decides.
 * - A journal note or a visit whose itinerary item is gone is sent with the pointer stripped. The
 *   words and the rating are the valuable part; the item was only context.
 * - A visit for a place that is gone has nothing left to be a visit *of*, so that one is reported.
 *
 * @returns `{ action: "send", request }`, `{ action: "hold" }` while a dependency is still queued,
 *          or `{ action: "attention", reason }`.
 */
export function resolveOperation(entry, { snapshot, idMap = new Map(), pending = new Set() } = {}) {
  const payload = { ...entry.payload };

  // A place saved offline has no server id until its own `add_place` replays. FIFO puts the creator
  // first, so an unresolved local id here means either that it has not run yet (hold) or that it
  // will never run (report) — never a reason to send a write pointing at nothing.
  for (const key of ["place_id"]) {
    if (isPendingId(payload[key])) {
      const resolved = idMap.get(payload[key]);
      if (resolved) payload[key] = resolved;
      else if (pending.has(payload[key])) return { action: "hold", reason: "awaiting_place" };
      else return { action: "attention", reason: "place_never_saved" };
    }
  }

  if (snapshot) {
    if (payload.itinerary_item_id && !itemExists(snapshot, payload.itinerary_item_id)) {
      if (entry.kind === "itinerary_status") return { action: "attention", reason: "item_gone" };
      delete payload.itinerary_item_id;
    }
    if (entry.kind === "place_visit" && !isPendingId(payload.place_id) && !placeExists(snapshot, payload.place_id)) {
      return { action: "attention", reason: "place_gone" };
    }
    if (entry.kind === "journal_note" && payload.place_id && !isPendingId(payload.place_id) && !placeExists(snapshot, payload.place_id)) {
      delete payload.place_id;
    }
  }

  return { action: "send", request: toolRequest(entry, payload) };
}

/**
 * The wire form of an entry.
 *
 * Only the four inserting tools carry `client_op_id`; `update_itinerary_item` is left without one
 * because it is idempotent by construction — replaying it sets the same fields to the same values —
 * and an idempotency key it does not need would only be a key to keep in step.
 */
export function toolRequest(entry, payload = entry.payload) {
  switch (entry.kind) {
    case "itinerary_status":
      return {
        name: "update_itinerary_item",
        arguments: prune({
          itinerary_item_id: payload.itinerary_item_id,
          status: payload.status,
          actual_start: payload.actual_start,
          actual_end: payload.actual_end,
        }),
      };
    case "journal_note":
      return {
        name: "record_journal_note",
        arguments: prune({
          trip_id: payload.trip_id,
          itinerary_item_id: payload.itinerary_item_id,
          place_id: payload.place_id,
          captured_at: payload.captured_at,
          raw_note: payload.raw_note,
          reaction: payload.reaction,
          latitude: payload.latitude,
          longitude: payload.longitude,
          client_op_id: entry.op_id,
        }),
      };
    case "place_visit":
      return {
        name: "mark_place_visited",
        arguments: prune({
          trip_id: payload.trip_id,
          place_id: payload.place_id,
          itinerary_item_id: payload.itinerary_item_id,
          arrived_at: payload.arrived_at,
          departed_at: payload.departed_at,
          rating: payload.rating,
          would_return: payload.would_return,
          recommendation: payload.recommendation,
          notes: payload.notes,
          client_op_id: entry.op_id,
        }),
      };
    case "new_place":
      return {
        name: "add_place",
        arguments: prune({
          trip_id: payload.trip_id,
          name: payload.name,
          category: payload.category,
          address: payload.address,
          latitude: payload.latitude,
          longitude: payload.longitude,
          // A point captured from the phone's own GPS is the one case the companion can honestly
          // call `provided`; anything typed from memory keeps the `estimated` default.
          coordinate_source: payload.coordinate_source,
          trip_status: payload.trip_status,
          client_op_id: entry.op_id,
        }),
      };
    case "preference":
      return {
        name: "remember_preference",
        arguments: prune({
          trip_id: payload.trip_id,
          memory_type: payload.memory_type ?? "preference",
          content: payload.content,
          // The traveller typed it into their own trip, so it is explicit — which is what makes it
          // `confirmed` on arrival rather than a candidate waiting for adjudication.
          provenance: "explicit",
          client_op_id: entry.op_id,
        }),
      };
    default:
      throw new Error(`${entry.kind} has no tool.`);
  }
}

const prune = (args) =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ""));

/**
 * Show a queued write in the views that would show it once it lands.
 *
 * Optimism here is not decoration: a note that vanishes for four hours until the signal returns
 * reads as a note that was lost. The optimistic row is given a `pending:` id so every view can tell
 * the difference between what Travel Brain has and what this phone is still carrying, and so
 * {@link applyResult} can find it again and swap in the real row.
 */
export function applyOperation(snapshot, entry) {
  const payload = entry.payload;
  const id = `${PENDING_PREFIX}${entry.op_id}`;
  switch (entry.kind) {
    case "itinerary_status":
      return {
        ...snapshot,
        itinerary: snapshot.itinerary.map((item) =>
          item.id === payload.itinerary_item_id
            ? {
                ...item,
                status: payload.status,
                actual_start: payload.actual_start ?? item.actual_start,
                actual_end: payload.actual_end ?? item.actual_end,
              }
            : item
        ),
      };
    case "journal_note":
      return {
        ...snapshot,
        journal: [
          {
            id,
            itinerary_item_id: payload.itinerary_item_id ?? null,
            place_id: payload.place_id ?? null,
            captured_at: payload.captured_at,
            raw_note: payload.raw_note,
            generated_summary: null,
            reaction: payload.reaction ?? null,
            visibility: "private",
          },
          ...snapshot.journal,
        ],
      };
    case "place_visit":
      return {
        ...snapshot,
        visits: [
          ...snapshot.visits,
          {
            id,
            place_id: payload.place_id,
            itinerary_item_id: payload.itinerary_item_id ?? null,
            arrived_at: payload.arrived_at ?? null,
            departed_at: payload.departed_at ?? null,
            rating: payload.rating ?? null,
            would_return: payload.would_return ?? null,
            recommendation: payload.recommendation ?? "none",
            notes: payload.notes ?? null,
          },
        ],
        // The server marks the trip place visited as a side effect of the visit; the phone shows the
        // same thing rather than waiting a sync to agree with itself.
        places: snapshot.places.map((link) =>
          link.place_id === payload.place_id ? { ...link, status: "visited" } : link
        ),
      };
    case "new_place":
      return {
        ...snapshot,
        places: [
          ...snapshot.places,
          {
            trip_id: payload.trip_id,
            place_id: payload.local_id,
            status: payload.trip_status ?? "shortlist",
            priority: 3,
            note: null,
            places: {
              id: payload.local_id,
              name: payload.name,
              category: payload.category ?? null,
              address: payload.address ?? null,
              locality: null,
              region: null,
              country_code: null,
              latitude: payload.latitude ?? null,
              longitude: payload.longitude ?? null,
              coordinate_source: payload.latitude != null ? payload.coordinate_source ?? "estimated" : null,
              external_ids: {},
              metadata: {},
            },
          },
        ],
      };
    case "preference":
      return {
        ...snapshot,
        preferences: [
          ...snapshot.preferences,
          {
            id,
            memory_type: payload.memory_type ?? "preference",
            content: payload.content,
            confidence: 1,
            status: "confirmed",
            provenance: "explicit",
          },
        ],
      };
    default:
      return snapshot;
  }
}

/**
 * Replace the optimistic row with the one Travel Brain actually stored.
 *
 * The row that comes back is authoritative — a replay returns the original insert, so this is also
 * how a duplicate send converges rather than doubling. A new place additionally reports its
 * `mapping`, which is what lets the note captured beside it stop pointing at a local id.
 */
export function applyResult(snapshot, entry, result) {
  const id = `${PENDING_PREFIX}${entry.op_id}`;
  switch (entry.kind) {
    case "journal_note": {
      const row = result?.journal_entry;
      if (!row) return { snapshot, mapping: null };
      return {
        snapshot: { ...snapshot, journal: snapshot.journal.map((entryRow) => (entryRow.id === id ? { ...entryRow, ...row } : entryRow)) },
        mapping: null,
      };
    }
    case "place_visit": {
      const row = result?.visit;
      if (!row) return { snapshot, mapping: null };
      return {
        snapshot: { ...snapshot, visits: snapshot.visits.map((visit) => (visit.id === id ? { ...visit, ...row } : visit)) },
        mapping: null,
      };
    }
    case "preference": {
      const row = result?.memory;
      if (!row) return { snapshot, mapping: null };
      return {
        snapshot: { ...snapshot, preferences: snapshot.preferences.map((memory) => (memory.id === id ? { ...memory, ...row } : memory)) },
        mapping: null,
      };
    }
    case "new_place": {
      const row = result?.place;
      const local = entry.payload.local_id;
      if (!row) return { snapshot, mapping: null };
      return {
        snapshot: {
          ...snapshot,
          places: snapshot.places.map((link) =>
            link.place_id === local ? { ...link, place_id: row.id, places: { ...link.places, ...row } } : link
          ),
          journal: snapshot.journal.map((note) => (note.place_id === local ? { ...note, place_id: row.id } : note)),
          visits: snapshot.visits.map((visit) => (visit.place_id === local ? { ...visit, place_id: row.id } : visit)),
        },
        mapping: [local, row.id],
      };
    }
    case "itinerary_status": {
      const row = result?.itinerary_item;
      if (!row) return { snapshot, mapping: null };
      return {
        snapshot: { ...snapshot, itinerary: snapshot.itinerary.map((item) => (item.id === row.id ? { ...item, ...row } : item)) },
        mapping: null,
      };
    }
    default:
      return { snapshot, mapping: null };
  }
}

/** Roll a failed attempt forward, and stop retrying once it has clearly stopped being transient. */
export function recordFailure(entry, error, limit = MAX_ATTEMPTS) {
  const attempts = entry.attempts + 1;
  const message = error instanceof Error ? error.message : String(error ?? "Send failed.");
  return attempts >= limit
    ? { ...entry, attempts, last_error: message, state: "attention", attention_reason: "rejected" }
    : { ...entry, attempts, last_error: message };
}

/** Park an entry the trip has outrun, with the reason the traveller will be shown. */
export const flagForAttention = (entry, reason) => ({ ...entry, state: "attention", attention_reason: reason });

/** Local ids still waiting for their `add_place` — the dependency set `resolveOperation` reads. */
export const pendingPlaceIds = (entries) =>
  new Set(entries.filter((entry) => entry.kind === "new_place" && isQueued(entry)).map((entry) => entry.payload.local_id));

/**
 * Why an entry is sitting in needs-attention, in the traveller's terms. Deliberately concrete: a
 * queue that says "failed" teaches people to clear it without reading, and the whole reason these
 * are kept is that the words in them are worth more than the queue is.
 */
export const ATTENTION_REASONS = {
  item_gone: "That itinerary item is no longer in the plan, so this status could not be applied.",
  place_gone: "That saved place is no longer on the trip, so the visit could not be recorded.",
  place_never_saved: "The place this was attached to was never saved, so it has nothing to point at.",
  rejected: "Travel Brain would not accept this write.",
};

export const attentionMessage = (entry) =>
  ATTENTION_REASONS[entry.attention_reason] ?? entry.last_error ?? "This write could not be sent.";
