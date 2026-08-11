import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPlace,
  getOfflineSnapshot,
  markPlaceVisited,
  recordJournalNote,
  rememberPreference
} from '../src/db.mjs';
import { createScriptedSupabase } from './support/scripted-supabase.mjs';
import { haversineMeters, localDateTime, sortedTimeline } from '../src/trip-clock.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const trip = {
  id: tripId,
  owner_id: ownerId,
  title: 'Hong Kong',
  timezone: 'Asia/Hong_Kong',
  status: 'active',
  start_date: '2026-12-20',
  end_date: '2026-12-21',
  metadata: {}
};

function context(steps, actorId = ownerId) {
  const supabase = createScriptedSupabase(steps);
  return {
    ctx: { actorId, supabase, authMode: 'static', authInfo: {}, locationFreshnessMinutes: 30 },
    supabase
  };
}

/** The full happy-path query script for one snapshot, in the order db.mjs issues it. */
function snapshotSteps(overrides = {}) {
  return [
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'trips', data: trip },
    { table: 'itinerary_items', data: overrides.itinerary ?? [] },
    { table: 'reservations', data: overrides.reservations ?? [] },
    { rpc: 'trip_offline_places', data: overrides.places ?? [] },
    { table: 'place_visits', data: overrides.visits ?? [] },
    { table: 'journal_entries', data: overrides.journal ?? [] },
    { table: 'research_items', data: overrides.research ?? [] },
    { table: 'recommendations', data: overrides.recommendations ?? [] },
    { table: 'memories', data: overrides.memories ?? [] },
    { table: 'current_trip_state', data: overrides.currentState ?? null }
  ];
}

test('the offline snapshot carries a whole trip in one call', async () => {
  const scripted = context(snapshotSteps({
    itinerary: [{ id: 'item-1', title: 'Star Ferry', planned_start: '2026-12-20T02:00:00Z' }],
    reservations: [{ id: 'reservation-1', confirmation_code: 'ABC123' }],
    visits: [{ id: 'visit-1', place_id: placeId }],
    research: [{ id: 'research-1', place_id: placeId, research_sources: [] }],
    recommendations: [{ id: 'recommendation-1', place_id: placeId }]
  }));

  const snapshot = await getOfflineSnapshot(scripted.ctx, tripId);

  assert.equal(snapshot.trip.id, tripId);
  assert.equal(snapshot.itinerary.length, 1);
  assert.equal(snapshot.reservations[0].confirmation_code, 'ABC123');
  assert.equal(snapshot.visits.length, 1);
  assert.equal(snapshot.research.length, 1);
  assert.equal(snapshot.recommendations.length, 1);
  assert.ok(snapshot.server_time);
  assert.ok(snapshot.snapshot_etag);
  // One tool call, and the traveller has the trip. That is the entire offline read protocol.
  assert.equal(scripted.supabase.calls.filter((call) => call.table === 'trips').length, 2);
});

test('the snapshot resolves place coordinates the geography column cannot express', async () => {
  const scripted = context(snapshotSteps({
    places: [{
      trip_id: tripId,
      place_id: placeId,
      status: 'planned',
      priority: 4,
      note: 'Go at dusk',
      place_name: 'Victoria Peak',
      category: 'viewpoint',
      address: '1 Lugard Road',
      latitude: 22.2759,
      longitude: 114.145,
      external_ids: {},
      place_metadata: { address_local: '山頂道' }
    }]
  }));

  const snapshot = await getOfflineSnapshot(scripted.ctx, tripId);

  const [entry] = snapshot.places;
  assert.equal(entry.place_id, placeId);
  assert.equal(entry.status, 'planned');
  assert.equal(entry.places.name, 'Victoria Peak');
  assert.equal(entry.places.latitude, 22.2759);
  assert.equal(entry.places.longitude, 114.145);
  assert.equal(entry.places.metadata.address_local, '山頂道');
  assert.equal(scripted.supabase.calls[4].rpc, 'trip_offline_places');
});

test('the snapshot separates stored lessons from preferences and never invents them', async () => {
  const scripted = context(snapshotSteps({
    memories: [
      { id: 'lesson-1', memory_type: 'trip_lesson', trip_id: tripId, content: 'Two sights a day is plenty' },
      { id: 'preference-1', memory_type: 'preference', trip_id: null, content: 'No shellfish', status: 'confirmed' },
      { id: 'other-1', memory_type: 'trip_lesson', trip_id: 'other-trip', content: 'Belongs to another trip' }
    ]
  }));

  const snapshot = await getOfflineSnapshot(scripted.ctx, tripId);

  assert.deepEqual(snapshot.lessons.map((entry) => entry.id), ['lesson-1']);
  assert.deepEqual(snapshot.preferences.map((entry) => entry.id), ['preference-1']);
});

test('another member private journal entry is never cached onto the traveller device', async () => {
  const scripted = context(snapshotSteps({
    journal: [
      { id: 'mine', author_id: ownerId, visibility: 'private', raw_note: 'Mine' },
      { id: 'theirs', author_id: otherId, visibility: 'private', raw_note: 'Not mine' },
      { id: 'shared', author_id: otherId, visibility: 'trip', raw_note: 'Shared' }
    ]
  }));

  const snapshot = await getOfflineSnapshot(scripted.ctx, tripId);

  assert.deepEqual(snapshot.journal.map((entry) => entry.id), ['mine', 'shared']);
});

test('the snapshot qualifies the cached location as fresh, stale, or missing', async () => {
  const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const fresh = context(snapshotSteps({
    currentState: {
      trip_id: tripId,
      last_location: { type: 'Point', coordinates: [114.15, 22.28] },
      location_observed_at: observedAt,
      running_late_minutes: 0
    }
  }));
  const freshSnapshot = await getOfflineSnapshot(fresh.ctx, tripId);
  assert.equal(freshSnapshot.location.status, 'fresh');
  assert.equal(freshSnapshot.location.latitude, 22.28);

  const missing = context(snapshotSteps());
  const missingSnapshot = await getOfflineSnapshot(missing.ctx, tripId);
  assert.equal(missingSnapshot.location.status, 'missing');
});

test('the snapshot etag changes when trip content changes and holds when it does not', async () => {
  const rows = { itinerary: [{ id: 'item-1', updated_at: '2026-12-01T00:00:00Z' }] };
  const first = await getOfflineSnapshot(context(snapshotSteps(rows)).ctx, tripId);
  const same = await getOfflineSnapshot(context(snapshotSteps(rows)).ctx, tripId);
  const moved = await getOfflineSnapshot(
    context(snapshotSteps({ itinerary: [{ id: 'item-1', updated_at: '2026-12-02T00:00:00Z' }] })).ctx,
    tripId
  );

  assert.equal(first.snapshot_etag, same.snapshot_etag);
  assert.notEqual(first.snapshot_etag, moved.snapshot_etag);
});

test('a journal note without a client op id still writes with a single insert', async () => {
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'journal_entries', data: { id: 'journal-1' } }
  ]);

  await recordJournalNote(scripted.ctx, { trip_id: tripId, raw_note: 'Ferry at dusk' });

  // The interactive path is unchanged: no lookup, no extra round trip.
  assert.equal(scripted.supabase.calls.length, 2);
  assert.equal(scripted.supabase.calls[1].operation, 'insert');
  assert.equal(scripted.supabase.calls[1].value.metadata.client_op_id, undefined);
});

test('replaying a queued journal note returns the original row instead of duplicating it', async () => {
  const existing = { id: 'journal-1', raw_note: 'Ferry at dusk', metadata: { client_op_id: 'op-abc-123' } };
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'journal_entries', data: existing }
  ]);

  const entry = await recordJournalNote(scripted.ctx, {
    trip_id: tripId,
    raw_note: 'Ferry at dusk',
    client_op_id: 'op-abc-123'
  });

  assert.equal(entry.id, 'journal-1');
  // The lookup is the only journal query: nothing was inserted a second time.
  assert.equal(scripted.supabase.calls.length, 2);
  assert.equal(scripted.supabase.calls[1].operation, 'select');
  assert.deepEqual(scripted.supabase.calls[1].filters, [
    ['eq', 'metadata->>client_op_id', 'op-abc-123'],
    ['eq', 'trip_id', tripId],
    ['eq', 'author_id', ownerId]
  ]);
});

test('a first-time queued write inserts once and records the client op id', async () => {
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'journal_entries', data: null },
    { table: 'journal_entries', data: { id: 'journal-1' } }
  ]);

  await recordJournalNote(scripted.ctx, {
    trip_id: tripId,
    raw_note: 'Ferry at dusk',
    client_op_id: 'op-abc-123'
  });

  assert.equal(scripted.supabase.calls[2].operation, 'insert');
  assert.equal(scripted.supabase.calls[2].value.metadata.client_op_id, 'op-abc-123');
});

test('a replay that loses the insert race resolves to the row the winner wrote', async () => {
  const winner = { id: 'journal-1', metadata: { client_op_id: 'op-abc-123' } };
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'journal_entries', data: null },
    { table: 'journal_entries', error: { code: '23505', message: 'duplicate key value' } },
    { table: 'journal_entries', data: winner }
  ]);

  const entry = await recordJournalNote(scripted.ctx, {
    trip_id: tripId,
    raw_note: 'Ferry at dusk',
    client_op_id: 'op-abc-123'
  });

  assert.equal(entry.id, 'journal-1');
});

test('a replayed visit does not create a second visit record', async () => {
  const existing = { id: 'visit-1', place_id: placeId, metadata: { client_op_id: 'op-visit-1' } };
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: trip.timezone } },
    { table: 'place_visits', data: existing },
    { table: 'trip_places', data: null }
  ]);

  const visit = await markPlaceVisited(scripted.ctx, {
    trip_id: tripId,
    place_id: placeId,
    rating: 5,
    client_op_id: 'op-visit-1'
  });

  assert.equal(visit.id, 'visit-1');
  assert.equal(scripted.supabase.calls[1].operation, 'select');
  // A duplicate visit is not just clutter: a visit is the evidence a firsthand recommendation is
  // checked against, so two of them would overstate the record.
  assert.equal(scripted.supabase.calls.filter((call) => call.operation === 'insert').length, 0);
  // The trip-place status still converges, which is why it sits outside the replay check.
  assert.equal(scripted.supabase.calls[2].operation, 'upsert');
});

test('replayed places and preferences are deduplicated per writer', async () => {
  const place = context([
    { table: 'places', data: { id: placeId, name: 'Tai Cheong Bakery' } }
  ]);
  await addPlace(place.ctx, { name: 'Tai Cheong Bakery', client_op_id: 'op-place-1' });
  assert.deepEqual(place.supabase.calls[0].filters, [
    ['eq', 'metadata->>client_op_id', 'op-place-1'],
    ['eq', 'created_by', ownerId]
  ]);

  const memory = context([
    { table: 'memories', data: { id: 'memory-1', content: 'Queues before 9am are shorter' } }
  ]);
  await rememberPreference(memory.ctx, {
    content: 'Queues before 9am are shorter',
    client_op_id: 'op-memory-1'
  });
  assert.deepEqual(memory.supabase.calls[0].filters, [
    ['eq', 'metadata->>client_op_id', 'op-memory-1'],
    ['eq', 'owner_id', ownerId]
  ]);
});

/**
 * The companion imports these same functions to rebuild Today on the phone, so their behaviour is
 * now a contract between two codebases rather than an implementation detail of the read models.
 * The cases that matter are the ones either side of local midnight, where a UTC reading of the
 * same instant lands on the wrong day.
 */
test('day grouping stays on the trip clock across local midnight', () => {
  const zone = 'Asia/Hong_Kong';
  // 23:40 in Hong Kong on the 20th is already 15:40 UTC the same day...
  assert.equal(localDateTime('2026-12-20T15:40:00Z', zone).date, '2026-12-20');
  assert.equal(localDateTime('2026-12-20T15:40:00Z', zone).time, '23:40');
  // ...and 00:20 on the 21st is 16:20 UTC on the 20th, which a UTC reading would file a day early.
  assert.equal(localDateTime('2026-12-20T16:20:00Z', zone).date, '2026-12-21');
  assert.equal(localDateTime('2026-12-20T16:20:00Z', zone).time, '00:20');
});

test('a timeline orders by actual time when it exists and planned time otherwise', () => {
  const ordered = sortedTimeline([
    { id: 'c', planned_start: '2026-12-20T04:00:00Z' },
    { id: 'a', planned_start: '2026-12-20T01:00:00Z', actual_start: '2026-12-20T05:00:00Z' },
    { id: 'b', planned_start: '2026-12-20T02:00:00Z' },
    { id: 'd', planned_start: null }
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['b', 'c', 'a', 'd']);
});

test('offline distances are straight-line metres from the same coordinates the snapshot carries', () => {
  const peak = { latitude: 22.2759, longitude: 114.145 };
  const ferry = { latitude: 22.2937, longitude: 114.1685 };
  const distance = haversineMeters(peak, ferry);
  // Roughly 3.1 km across the harbour side of Hong Kong Island.
  assert.ok(distance > 2_900 && distance < 3_300, `unexpected distance ${distance}`);
  assert.equal(haversineMeters(peak, { latitude: null, longitude: null }), null);
  assert.equal(haversineMeters(null, ferry), null);
});
