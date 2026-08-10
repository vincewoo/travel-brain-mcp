import assert from 'node:assert/strict';
import test from 'node:test';
import {
  markPlaceVisited,
  recommendPlace,
  recordJournalNote,
  rememberPreference,
  saveResearchFinding,
  tripAccess
} from '../src/db.mjs';
import { createScriptedSupabase } from './support/scripted-supabase.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const editorId = '22222222-2222-4222-8222-222222222222';
const viewerId = '33333333-3333-4333-8333-333333333333';
const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function context(actorId, steps) {
  const supabase = createScriptedSupabase(steps);
  return { ctx: { actorId, supabase, authMode: 'static', authInfo: {} }, supabase };
}

test('owner and editor can edit; viewer and unrelated user cannot', async () => {
  const owner = context(ownerId, [{ table: 'trips', data: { id: tripId, owner_id: ownerId } }]);
  assert.deepEqual(await tripAccess(owner.ctx, tripId, true), { role: 'owner' });

  const editor = context(editorId, [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'trip_members', data: { role: 'editor' } }
  ]);
  assert.deepEqual(await tripAccess(editor.ctx, tripId, true), { role: 'editor' });

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
