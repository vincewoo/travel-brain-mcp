import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOperation,
  applyResult,
  attentionMessage,
  isPendingId,
  MAX_ATTEMPTS,
  pendingId,
  pendingPlaceIds,
  queueOperation,
  recordFailure,
  resolveOperation,
  sortQueue,
  toolRequest
} from '../ui/travel-companion/src/outbox-queue.mjs';

/**
 * The capture queue's rules, exercised without a browser.
 *
 * These are the decisions that only show themselves when something has gone wrong — a signal lost
 * mid-send, an itinerary item deleted while the phone was dark, a place that exists on the device
 * and nowhere else. Every one of them is a rule about not losing what the traveller wrote.
 */

const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const snapshotOf = (overrides = {}) => ({
  trip: { id: tripId, timezone: 'Asia/Hong_Kong' },
  itinerary: overrides.itinerary ?? [{ id: itemId, title: 'Star Ferry', status: 'planned', actual_start: null, actual_end: null }],
  tasks: [],
  reservations: [],
  places: overrides.places ?? [{ trip_id: tripId, place_id: placeId, status: 'shortlist', priority: 3, note: null, places: { id: placeId, name: 'Tai Cheong Bakery' } }],
  visits: overrides.visits ?? [],
  journal: overrides.journal ?? [],
  research: [],
  recommendations: [],
  lessons: [],
  preferences: overrides.preferences ?? [],
  current_state: null,
  location: { status: 'missing' },
  server_time: '2026-12-28T04:00:00Z',
  snapshot_etag: 'etag'
});

const note = (payload = {}) => queueOperation('journal_note', {
  trip_id: tripId,
  raw_note: 'The egg tarts were worth the queue.',
  captured_at: '2026-12-28T04:05:00Z',
  ...payload
});

test('replay is FIFO, so a place saved offline reaches the server before the note about it', () => {
  const first = queueOperation('new_place', { trip_id: tripId, local_id: pendingId(), name: 'Noodle stall' }, new Date('2026-12-28T04:00:00Z'));
  const second = queueOperation('journal_note', {
    trip_id: tripId,
    raw_note: 'Best thing I ate all week.',
    captured_at: '2026-12-28T04:01:00Z',
    place_id: first.payload.local_id
  }, new Date('2026-12-28T04:01:00Z'));

  assert.deepEqual(sortQueue([second, first]).map((entry) => entry.kind), ['new_place', 'journal_note']);
});

test('the four inserting tools carry an idempotency key and the idempotent one does not', () => {
  const appends = [
    [note(), 'record_journal_note'],
    [queueOperation('place_visit', { trip_id: tripId, place_id: placeId, rating: 5 }), 'mark_place_visited'],
    [queueOperation('new_place', { trip_id: tripId, local_id: pendingId(), name: 'Noodle stall' }), 'add_place'],
    [queueOperation('preference', { trip_id: tripId, content: 'One museum a day.' }), 'remember_preference']
  ];
  for (const [entry, name] of appends) {
    const request = toolRequest(entry);
    assert.equal(request.name, name);
    // A reply lost on the way back is the case this exists for: the replay returns the original row
    // rather than writing the note, the visit or the place a second time.
    assert.equal(request.arguments.client_op_id, entry.op_id);
  }

  const status = queueOperation('itinerary_status', { trip_id: tripId, itinerary_item_id: itemId, status: 'completed', title: 'Star Ferry', actual_end: '2026-12-28T05:00:00Z' });
  const request = toolRequest(status);
  assert.equal(request.name, 'update_itinerary_item');
  assert.ok(!('client_op_id' in request.arguments), 'setting the same fields again needs no key');
  // Actuals only. Replaying this must never restate the plan's own timing.
  assert.deepEqual(Object.keys(request.arguments).sort(), ['actual_end', 'itinerary_item_id', 'status']);
});

test('a status update for an item that is gone is parked rather than guessed at another item', () => {
  const entry = queueOperation('itinerary_status', { trip_id: tripId, itinerary_item_id: itemId, status: 'completed', title: 'Star Ferry' });
  const resolution = resolveOperation(entry, { snapshot: snapshotOf({ itinerary: [] }) });

  assert.equal(resolution.action, 'attention');
  assert.equal(resolution.reason, 'item_gone');
  assert.match(attentionMessage({ ...entry, attention_reason: resolution.reason }), /no longer in the plan/);
});

test('a journal note whose itinerary item is gone loses the pointer and keeps the words', () => {
  const entry = note({ itinerary_item_id: itemId });
  const resolution = resolveOperation(entry, { snapshot: snapshotOf({ itinerary: [] }) });

  assert.equal(resolution.action, 'send');
  assert.ok(!('itinerary_item_id' in resolution.request.arguments));
  assert.equal(resolution.request.arguments.raw_note, 'The egg tarts were worth the queue.');
});

test('a visit keeps its rating when the item is gone, and is parked when the place is', () => {
  const visit = queueOperation('place_visit', { trip_id: tripId, place_id: placeId, itinerary_item_id: itemId, rating: 5 });

  const detached = resolveOperation(visit, { snapshot: snapshotOf({ itinerary: [] }) });
  assert.equal(detached.action, 'send');
  assert.equal(detached.request.arguments.rating, 5);
  assert.ok(!('itinerary_item_id' in detached.request.arguments));

  // A visit to a place the trip no longer has is not a visit to anything, and a visit is the
  // evidence a firsthand recommendation is checked against — so it is reported, never re-pointed.
  const orphaned = resolveOperation(visit, { snapshot: snapshotOf({ places: [] }) });
  assert.equal(orphaned.action, 'attention');
  assert.equal(orphaned.reason, 'place_gone');
});

test('a note about a place saved offline waits for it, then points at the real row', () => {
  const local = pendingId();
  assert.ok(isPendingId(local));
  const place = queueOperation('new_place', { trip_id: tripId, local_id: local, name: 'Noodle stall' });
  const attached = note({ place_id: local });
  const snapshot = snapshotOf();

  const waiting = resolveOperation(attached, { snapshot, pending: pendingPlaceIds([place, attached]) });
  assert.equal(waiting.action, 'hold');

  const idMap = new Map([[local, placeId]]);
  const ready = resolveOperation(attached, { snapshot, idMap, pending: new Set() });
  assert.equal(ready.action, 'send');
  assert.equal(ready.request.arguments.place_id, placeId);

  // The creator failed for good and was discarded: the dependent is reported rather than sent at a
  // place that will never exist.
  const orphaned = resolveOperation(attached, { snapshot, pending: new Set() });
  assert.equal(orphaned.action, 'attention');
  assert.equal(orphaned.reason, 'place_never_saved');
});

test('a queued capture shows up immediately, marked as still on this phone', () => {
  const entry = note();
  const applied = applyOperation(snapshotOf(), entry);

  assert.equal(applied.journal.length, 1);
  assert.equal(applied.journal[0].raw_note, 'The egg tarts were worth the queue.');
  // The `pending:` id is how every view tells what Travel Brain has from what this phone is still
  // carrying — and how the real row finds its optimistic placeholder later.
  assert.ok(isPendingId(applied.journal[0].id));
  assert.equal(applied.journal[0].generated_summary, null);
});

test('marking an item done locally records the actual end without touching the plan', () => {
  const entry = queueOperation('itinerary_status', {
    trip_id: tripId,
    itinerary_item_id: itemId,
    status: 'completed',
    title: 'Star Ferry',
    actual_end: '2026-12-28T05:00:00Z'
  });
  const applied = applyOperation(snapshotOf({
    itinerary: [{ id: itemId, title: 'Star Ferry', status: 'planned', planned_start: '2026-12-28T01:00:00Z', actual_start: null, actual_end: null }]
  }), entry);

  assert.equal(applied.itinerary[0].status, 'completed');
  assert.equal(applied.itinerary[0].actual_end, '2026-12-28T05:00:00Z');
  assert.equal(applied.itinerary[0].planned_start, '2026-12-28T01:00:00Z');
  assert.equal(applied.itinerary[0].actual_start, null, 'an actual start nobody gave must not be invented');
});

test('a queued visit marks the place visited the way the server will', () => {
  const entry = queueOperation('place_visit', { trip_id: tripId, place_id: placeId, rating: 4 });
  const applied = applyOperation(snapshotOf(), entry);

  assert.equal(applied.visits.length, 1);
  assert.equal(applied.visits[0].rating, 4);
  assert.equal(applied.places[0].status, 'visited');
});

test('the row Travel Brain stored replaces the optimistic one, and rewrites what pointed at it', () => {
  const local = pendingId();
  const place = queueOperation('new_place', { trip_id: tripId, local_id: local, name: 'Noodle stall', latitude: 22.28, longitude: 114.15, coordinate_source: 'provided' });
  const attached = note({ place_id: local });

  let snapshot = applyOperation(snapshotOf(), place);
  snapshot = applyOperation(snapshot, attached);
  assert.equal(snapshot.places.at(-1).places.coordinate_source, 'provided');

  const settled = applyResult(snapshot, place, { place: { id: placeId, name: 'Noodle stall', coordinate_source: 'provided' } });
  assert.deepEqual(settled.mapping, [local, placeId]);
  assert.ok(!settled.snapshot.places.some((link) => isPendingId(link.place_id)));
  assert.equal(settled.snapshot.journal[0].place_id, placeId, 'the note follows the place to its real id');
});

test('a write that keeps being rejected stops being retried and starts being reported', () => {
  let entry = note();
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    entry = recordFailure(entry, new Error('Travel Brain said no.'));
    assert.equal(entry.state, 'queued', `gave up after ${attempt} of ${MAX_ATTEMPTS}`);
  }
  entry = recordFailure(entry, new Error('Travel Brain said no.'));

  assert.equal(entry.state, 'attention');
  assert.equal(entry.attempts, MAX_ATTEMPTS);
  assert.equal(entry.last_error, 'Travel Brain said no.');
  // Still readable, still holding the traveller's words — the queue reports, it never discards.
  assert.equal(entry.payload.raw_note, 'The egg tarts were worth the queue.');
});

test('nothing needing judgement or a fresh read can be queued at all', () => {
  for (const kind of ['itinerary_move', 'update_current_trip_state', 'commit_itinerary_change']) {
    assert.throws(() => queueOperation(kind, {}), /not a queueable operation/);
  }
});
