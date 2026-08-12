import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTripTask,
  addPlace,
  markPlaceVisited,
  recommendPlace,
  recordJournalNote,
  rememberPreference,
  saveResearchFinding,
  tripAccess,
  updatePlace,
  updateTripTask
} from '../src/db.mjs';
import { createScriptedSupabase } from './support/scripted-supabase.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const editorId = '22222222-2222-4222-8222-222222222222';
const viewerId = '33333333-3333-4333-8333-333333333333';
const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const taskId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function context(actorId, steps) {
  const supabase = createScriptedSupabase(steps);
  return { ctx: { actorId, supabase, authMode: 'static', authInfo: {} }, supabase };
}

test('owner and editor can edit; viewer and unrelated user cannot', async () => {
  const owner = context(ownerId, [{ table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } }]);
  assert.deepEqual(await tripAccess(owner.ctx, tripId, true), { role: 'owner', timezone: 'Asia/Hong_Kong' });

  const editor = context(editorId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } },
    { table: 'trip_members', data: { role: 'editor' } }
  ]);
  assert.deepEqual(await tripAccess(editor.ctx, tripId, true), { role: 'editor', timezone: 'Asia/Hong_Kong' });

  const viewer = context(viewerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'trip_members', data: { role: 'viewer' } }
  ]);
  await assert.rejects(() => tripAccess(viewer.ctx, tripId, true), /read-only/);

  const unrelated = context(viewerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'trip_members', data: null }
  ]);
  await assert.rejects(() => tripAccess(unrelated.ctx, tripId, false), /Not authorized/);
});

test('trip tasks preserve deadline versus opening-date semantics', async () => {
  const scripted = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } },
    { table: 'trip_tasks', data: { id: taskId, title: 'Buy train tickets' } }
  ]);
  await addTripTask(scripted.ctx, {
    trip_id: tripId,
    title: 'Buy train tickets',
    due_date: '2026-11-20',
    date_kind: 'opens'
  });
  assert.deepEqual(scripted.supabase.calls[1].value, {
    trip_id: tripId,
    title: 'Buy train tickets',
    notes: null,
    due_date: '2026-11-20',
    date_kind: 'opens',
    created_by: ownerId
  });
});

test('trip task completion records the actor and can be unchecked directly', async () => {
  const completedAt = '2026-08-12T18:30:00.000Z';
  const completing = context(ownerId, [
    { table: 'trip_tasks', data: { id: taskId, trip_id: tripId, completed_at: null } },
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } },
    { table: 'trip_tasks', data: { id: taskId, completed_at: completedAt, completed_by: ownerId } }
  ]);
  await updateTripTask(completing.ctx, { trip_task_id: taskId, completed: true }, completedAt);
  assert.deepEqual(completing.supabase.calls[2].value, {
    completed_at: completedAt,
    completed_by: ownerId
  });

  const reopening = context(ownerId, [
    { table: 'trip_tasks', data: { id: taskId, trip_id: tripId, completed_at: completedAt, completed_by: ownerId } },
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } },
    { table: 'trip_tasks', data: { id: taskId, completed_at: null, completed_by: null } }
  ]);
  await updateTripTask(reopening.ctx, { trip_task_id: taskId, completed: false });
  assert.deepEqual(reopening.supabase.calls[2].value, { completed_at: null, completed_by: null });
});

test('repeating the same trip task completion is an idempotent read', async () => {
  const task = { id: taskId, trip_id: tripId, completed_at: '2026-08-12T18:30:00.000Z', completed_by: ownerId };
  const scripted = context(ownerId, [
    { table: 'trip_tasks', data: task },
    { table: 'trips', data: { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' } }
  ]);
  assert.equal(await updateTripTask(scripted.ctx, { trip_task_id: taskId, completed: true }), task);
  assert.equal(scripted.supabase.calls.some((call) => call.operation === 'update'), false);
});

test('firsthand recommendation requires a recorded visit', async () => {
  const noVisit = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'place_visits', data: null }
  ]);
  await assert.rejects(() => recommendPlace(noVisit.ctx, {
    trip_id: tripId,
    place_id: placeId,
    provenance: 'firsthand'
  }), /requires a recorded visit/);

  const withVisit = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'place_visits', data: { id: 'visit-id' } },
    { table: 'recommendations', data: { id: 'recommendation-id', provenance: 'firsthand' } }
  ]);
  const recommendation = await recommendPlace(withVisit.ctx, {
    trip_id: tripId,
    place_id: placeId,
    provenance: 'firsthand'
  });
  assert.equal(recommendation.provenance, 'firsthand');
});

test('explicit and inferred preference defaults preserve semantic-memory policy', async () => {
  const explicit = context(ownerId, [{ table: 'memories', data: { id: 'explicit-memory' } }]);
  await rememberPreference(explicit.ctx, { content: 'I prefer aisle seats', provenance: 'explicit' });
  const explicitRow = explicit.supabase.calls[0].value;
  assert.equal(explicitRow.status, 'confirmed');
  assert.equal(explicitRow.confidence, 1);
  assert.equal(explicitRow.provenance, 'explicit');
  assert.ok(explicitRow.last_confirmed_at);

  const inferred = context(ownerId, [{ table: 'memories', data: { id: 'inferred-memory' } }]);
  await rememberPreference(inferred.ctx, { content: 'May prefer early starts', provenance: 'inferred' });
  const inferredRow = inferred.supabase.calls[0].value;
  assert.equal(inferredRow.status, 'candidate');
  assert.equal(inferredRow.confidence, 0.6);
  assert.equal(inferredRow.provenance, 'inferred');
  assert.equal(inferredRow.last_confirmed_at, null);
});

test('research findings and semantic memories write to separate stores', async () => {
  const research = context(ownerId, [{ table: 'research_items', data: { id: 'research-id' } }]);
  await saveResearchFinding(research.ctx, { topic: 'hours', finding: 'Opens at 9' });
  assert.equal(research.supabase.calls[0].table, 'research_items');

  const memory = context(ownerId, [{ table: 'memories', data: { id: 'memory-id' } }]);
  await rememberPreference(memory.ctx, { content: 'Likes early visits', provenance: 'explicit' });
  assert.equal(memory.supabase.calls[0].table, 'memories');
});

test('visit completion records actual timing without overwriting planned timing', async () => {
  const scripted = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'itinerary_items', data: { trip_id: tripId } },
    { table: 'place_visits', data: { id: 'visit-id' } },
    { table: 'trip_places', data: null },
    { table: 'itinerary_items', data: null }
  ]);
  await markPlaceVisited(scripted.ctx, {
    trip_id: tripId,
    place_id: placeId,
    itinerary_item_id: itemId,
    arrived_at: '2026-10-13T08:22:00+09:00',
    departed_at: '2026-10-13T09:15:00+09:00'
  });
  const itineraryUpdate = scripted.supabase.calls[4].value;
  assert.deepEqual(itineraryUpdate, {
    status: 'completed',
    actual_start: '2026-10-13T08:22:00+09:00',
    actual_end: '2026-10-13T09:15:00+09:00'
  });
  assert.equal('planned_start' in itineraryUpdate, false);
  assert.equal('planned_end' in itineraryUpdate, false);
});

test('a visit cannot update an itinerary item from another trip', async () => {
  const anotherTripId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const scripted = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'itinerary_items', data: { trip_id: anotherTripId } }
  ]);
  await assert.rejects(() => markPlaceVisited(scripted.ctx, {
    trip_id: tripId,
    place_id: placeId,
    itinerary_item_id: itemId
  }), /does not belong to this trip/);
  assert.equal(scripted.supabase.calls.some((call) => call.table === 'place_visits'), false);
});

test('journal write preserves the raw traveler note verbatim', async () => {
  const rawNote = '  Coming early was worth it — side streets were magical.  ';
  const scripted = context(ownerId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'journal_entries', data: { id: 'journal-id', raw_note: rawNote } }
  ]);
  await recordJournalNote(scripted.ctx, { trip_id: tripId, raw_note: rawNote });
  const journalRow = scripted.supabase.calls[1].value;
  assert.equal(journalRow.raw_note, rawNote);
  assert.equal('generated_summary' in journalRow, false);
});

/**
 * Coordinates carry where they came from.
 *
 * A point recalled by a model and a point someone surveyed render differently on the companion's
 * map, which only works if the two are distinguishable in the row. `estimated` is the default
 * because the common caller is the planning agent working from memory, and the failure worth
 * defaulting against is a guess presented as a fact.
 */
test('a saved point defaults to estimated, and an exact one keeps its claim', async () => {
  const guessed = context(ownerId, [{ table: 'places', data: { id: placeId } }]);
  await addPlace(guessed.ctx, { name: 'Elephant Trunk Hill', latitude: 25.259, longitude: 110.303 });
  assert.equal(guessed.supabase.calls[0].value.coordinate_source, 'estimated');
  assert.equal(guessed.supabase.calls[0].value.location, 'POINT(110.303 25.259)');

  const exact = context(ownerId, [{ table: 'places', data: { id: placeId } }]);
  await addPlace(exact.ctx, { name: 'Star Ferry', latitude: 22.2937, longitude: 114.1685, coordinate_source: 'provided' });
  assert.equal(exact.supabase.calls[0].value.coordinate_source, 'provided');

  // No point, no source: the pair is what the database constraint is about.
  const unplaced = context(ownerId, [{ table: 'places', data: { id: placeId } }]);
  await addPlace(unplaced.ctx, { name: 'Riverside fish restaurants' });
  assert.equal('location' in unplaced.supabase.calls[0].value, false);
  assert.equal('coordinate_source' in unplaced.supabase.calls[0].value, false);
});

test('update_place corrects a place without touching what happened there', async () => {
  const scripted = context(ownerId, [
    { table: 'places', data: { id: placeId, created_by: ownerId, location: null } },
    { table: 'places', data: { id: placeId, coordinate_source: 'estimated' } }
  ]);
  await updatePlace(scripted.ctx, {
    place_id: placeId,
    latitude: 25.2536,
    longitude: 110.2864,
    address: 'Reed Flute Rd, Guilin'
  });
  const patch = scripted.supabase.calls[1].value;
  assert.equal(patch.location, 'POINT(110.2864 25.2536)');
  assert.equal(patch.coordinate_source, 'estimated');
  assert.equal(patch.address, 'Reed Flute Rd, Guilin');
  // Description only. Nothing here reaches a visit, a journal entry, or a recommendation.
  assert.deepEqual(Object.keys(patch).sort(), ['address', 'coordinate_source', 'location']);
  scripted.supabase.assertComplete();
});

test('clearing coordinates drops the point and its source together', async () => {
  const scripted = context(ownerId, [
    { table: 'places', data: { id: placeId, created_by: ownerId, location: '0101000020E6100000' } },
    { table: 'places', data: { id: placeId } }
  ]);
  await updatePlace(scripted.ctx, { place_id: placeId, clear_coordinates: true });
  const patch = scripted.supabase.calls[1].value;
  // A point known to be wrong is worse than none: it is a confident pin in the wrong place.
  assert.equal(patch.location, null);
  assert.equal(patch.coordinate_source, null);
});

test('update_place refuses the corrections that would land as a lie or a silent no-op', async () => {
  // Only the creator, mirroring the places_creator_update RLS policy. Static mode bypasses RLS, so
  // without this check it would be the laxer of the two modes.
  const stranger = context(editorId, [{ table: 'places', data: { id: placeId, created_by: ownerId, location: null } }]);
  await assert.rejects(
    () => updatePlace(stranger.ctx, { place_id: placeId, latitude: 1, longitude: 2 }),
    /Only the traveller who saved a place/
  );

  // Half a coordinate is an incomplete correction, and dropping it silently would look like success.
  const half = context(ownerId, [{ table: 'places', data: { id: placeId, created_by: ownerId, location: null } }]);
  await assert.rejects(
    () => updatePlace(half.ctx, { place_id: placeId, latitude: 22.3 }),
    /Latitude and longitude must be given together/
  );

  // Labelling a point that does not exist. The database would reject it too; this says what to do.
  const unplaced = context(ownerId, [{ table: 'places', data: { id: placeId, created_by: ownerId, location: null } }]);
  await assert.rejects(
    () => updatePlace(unplaced.ctx, { place_id: placeId, coordinate_source: 'provided' }),
    /no coordinates to label/
  );

  const missing = context(ownerId, [{ table: 'places', data: null }]);
  await assert.rejects(() => updatePlace(missing.ctx, { place_id: placeId, latitude: 1, longitude: 2 }), /not found/);
});
