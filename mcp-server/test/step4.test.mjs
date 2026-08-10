import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitItineraryChange,
  getCurrentContext,
  getNearbySavedPlaces,
  getPlacesOverview,
  getPlanOverview,
  getRecentJournal,
  getRecommendations,
  getToday,
  getTripLessons,
  proposeItineraryChange,
  updateCurrentTripState
} from '../src/db.mjs';
import { createScriptedSupabase } from './support/scripted-supabase.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const viewerId = '33333333-3333-4333-8333-333333333333';
const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const proposalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const trip = {
  id: tripId,
  owner_id: ownerId,
  title: 'Japan',
  timezone: 'Asia/Tokyo',
  status: 'active',
  start_date: '2026-10-14',
  end_date: '2026-10-15',
  metadata: {}
};

function context(steps, actorId = ownerId) {
  const supabase = createScriptedSupabase(steps);
  return {
    ctx: { actorId, supabase, authMode: 'static', authInfo: {}, locationFreshnessMinutes: 30 },
    supabase
  };
}

function ownerAccessAndTrip() {
  return [
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'trips', data: trip }
  ];
}

test('get_today groups late-night itinerary by the trip timezone rather than UTC', async () => {
  const tokyoLate = { id: itemId, title: 'Late ramen', planned_start: '2026-10-14T14:30:00Z', planned_end: '2026-10-14T15:00:00Z', status: 'planned', flexibility: 'flexible' };
  const tokyoNextDay = { id: proposalId, title: 'Night walk', planned_start: '2026-10-14T15:30:00Z', planned_end: '2026-10-14T16:00:00Z', status: 'planned', flexibility: 'flexible' };
  const scripted = context([
    ...ownerAccessAndTrip(),
    { table: 'itinerary_items', data: [tokyoLate, tokyoNextDay] },
    { table: 'reservations', data: [] },
    { table: 'place_visits', data: [] }
  ]);
  const today = await getToday(scripted.ctx, tripId, '2026-10-14', new Date('2026-10-14T05:00:00Z'));
  assert.deepEqual(today.timeline.map((item) => item.title), ['Late ramen']);
  assert.equal(today.date, '2026-10-14');
  assert.equal(today.timezone, 'Asia/Tokyo');
  scripted.supabase.assertComplete();
});

test('current context labels missing, fresh, and stale locations explicitly', async () => {
  async function statusFor(state, atTime) {
    const scripted = context([
      ...ownerAccessAndTrip(),
      { table: 'current_trip_state', data: state },
      { table: 'itinerary_items', data: [] },
      { table: 'reservations', data: [] },
      { table: 'itinerary_change_proposals', data: null }
    ]);
    return (await getCurrentContext(scripted.ctx, tripId, atTime)).location.status;
  }
  assert.equal(await statusFor(null, '2026-10-14T04:00:00Z'), 'missing');
  assert.equal(await statusFor({
    last_location: { type: 'Point', coordinates: [139, 35] },
    location_observed_at: '2026-10-14T03:45:00Z'
  }, '2026-10-14T04:00:00Z'), 'fresh');
  assert.equal(await statusFor({
    last_location: { type: 'Point', coordinates: [139, 35] },
    location_observed_at: '2026-10-14T03:00:00Z'
  }, '2026-10-14T04:00:00Z'), 'stale');
});

test('current trip location is overwritten in its singleton row and identical state is idempotent', async () => {
  const locationA = {
    trip_id: tripId,
    updated_by: ownerId,
    last_location: { type: 'Point', coordinates: [139, 35] },
    location_observed_at: '2026-10-14T03:00:00Z',
    running_late_minutes: 0,
    state: {}
  };
  const locationB = { ...locationA, last_location: { type: 'Point', coordinates: [139.1, 35.1] }, location_observed_at: '2026-10-14T03:10:00Z' };
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'current_trip_state', data: locationA },
    { table: 'current_trip_state', data: locationB }
  ]);
  await updateCurrentTripState(scripted.ctx, {
    trip_id: tripId,
    latitude: 35.1,
    longitude: 139.1,
    location_observed_at: '2026-10-14T03:10:00Z'
  });
  assert.equal(scripted.supabase.calls[2].operation, 'update');
  assert.equal(scripted.supabase.calls[2].value.last_location, 'POINT(139.1 35.1)');
  assert.deepEqual(new Set(scripted.supabase.calls.map((call) => call.table)), new Set(['trips', 'current_trip_state']));

  const identical = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'current_trip_state', data: locationB }
  ]);
  const result = await updateCurrentTripState(identical.ctx, {
    trip_id: tripId,
    latitude: 35.1,
    longitude: 139.1,
    location_observed_at: '2026-10-14T03:10:00Z'
  });
  assert.equal(result, locationB);
  assert.equal(identical.supabase.calls.some((call) => call.operation === 'update'), false);
});

test('nearby saved places preserve PostGIS distance order for explicit and current-state origins', async () => {
  const nearbyRows = [
    { place_id: placeId, name: 'Near', category: 'cafe', trip_status: 'saved', priority: 3, distance_meters: 125.4 },
    { place_id: itemId, name: 'Farther', category: 'cafe', trip_status: 'planned', priority: 2, distance_meters: 900.2 }
  ];
  const contextSteps = [
    { table: 'itinerary_items', data: [] },
    { table: 'place_visits', data: [] },
    { table: 'recommendations', data: [] },
    { table: 'research_items', data: [] }
  ];
  const explicit = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { rpc: 'nearby_trip_places', data: nearbyRows },
    ...contextSteps
  ]);
  const explicitResult = await getNearbySavedPlaces(explicit.ctx, {
    trip_id: tripId, latitude: 35, longitude: 139, radius_meters: 1500, limit: 10
  });
  assert.deepEqual(explicitResult.places.map((place) => place.distance_meters), [125, 900]);
  assert.equal(explicitResult.distance_kind, 'geographic');
  assert.equal(explicitResult.origin.source, 'provided');

  const current = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'current_trip_state', data: { last_location: { type: 'Point', coordinates: [139, 35] } } },
    { rpc: 'nearby_trip_places', data: [] }
  ]);
  const currentResult = await getNearbySavedPlaces(current.ctx, {
    trip_id: tripId, use_current_location: true, radius_meters: 1500, limit: 10
  });
  assert.equal(currentResult.origin.source, 'current_trip_state');

  const missing = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'current_trip_state', data: null }
  ]);
  await assert.rejects(() => getNearbySavedPlaces(missing.ctx, {
    trip_id: tripId, use_current_location: true
  }), /Current trip location is missing/);
});

test('plan overview reports overlaps, unscheduled priority places, and stale volatile research without scheduling places', async () => {
  const place2 = proposalId;
  const items = [
    { id: itemId, title: 'Fixed tour', place_id: placeId, planned_start: '2026-10-14T01:00:00Z', planned_end: '2026-10-14T03:00:00Z', status: 'confirmed', flexibility: 'fixed' },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Overlap', planned_start: '2026-10-14T02:00:00Z', planned_end: '2026-10-14T04:00:00Z', status: 'planned', flexibility: 'flexible' }
  ];
  const saved = { trip_id: tripId, place_id: place2, status: 'saved', priority: 5, places: { id: place2, name: 'Must try', locality: 'Shibuya' } };
  const scripted = context([
    ...ownerAccessAndTrip(),
    { table: 'itinerary_items', data: items },
    { table: 'reservations', data: [] },
    { table: 'trip_places', data: [
      { trip_id: tripId, place_id: placeId, status: 'planned', priority: 3, places: { id: placeId, name: 'Tour', locality: 'Minato' } },
      saved
    ] },
    { table: 'research_items', data: [{ place_id: placeId, volatility: 'volatile', status: 'active', valid_as_of: '2026-01-01T00:00:00Z' }] }
  ]);
  const overview = await getPlanOverview(scripted.ctx, tripId, '2026-10-14T05:00:00Z');
  assert.ok(overview.issues.some((issue) => issue.type === 'overlap'));
  assert.ok(overview.issues.some((issue) => issue.type === 'high_priority_unscheduled'));
  assert.ok(overview.issues.some((issue) => issue.type === 'stale_volatile_research'));
  assert.deepEqual(overview.unscheduled_places, [saved]);
  assert.equal(overview.scheduled_count, 2);
});

test('places overview independently preserves researched, scheduled, visited, and firsthand state', async () => {
  const researchOnlyId = proposalId;
  const scripted = context([
    ...ownerAccessAndTrip(),
    { table: 'trip_places', data: [
      { trip_id: tripId, place_id: placeId, status: 'visited', priority: 4, places: { id: placeId, name: 'Visited', category: 'restaurant' } },
      { trip_id: tripId, place_id: researchOnlyId, status: 'saved', priority: 3, places: { id: researchOnlyId, name: 'Research only', category: 'museum' } }
    ] },
    { table: 'itinerary_items', data: [{ id: itemId, place_id: placeId, status: 'completed', planned_start: '2026-10-14T03:00:00Z' }] },
    { table: 'place_visits', data: [{ id: 'visit', place_id: placeId, rating: 5, would_return: true, created_at: '2026-10-14T05:00:00Z' }] },
    { table: 'recommendations', data: [{ id: 'recommendation', place_id: placeId, provenance: 'firsthand', level: 'strongly_recommend', created_at: '2026-10-14T06:00:00Z' }] },
    { table: 'research_items', data: [
      { id: 'r1', place_id: placeId, status: 'active', volatility: 'static', valid_as_of: '2026-10-01T00:00:00Z' },
      { id: 'r2', place_id: researchOnlyId, status: 'active', volatility: 'static', valid_as_of: '2026-10-01T00:00:00Z' }
    ] }
  ]);
  const overview = await getPlacesOverview(scripted.ctx, { trip_id: tripId, limit: 100 }, '2026-10-14T00:00:00Z');
  const visited = overview.places.find((place) => place.place.id === placeId);
  const researchedOnly = overview.places.find((place) => place.place.id === researchOnlyId);
  assert.equal(visited.researched, true);
  assert.equal(visited.scheduled, true);
  assert.equal(visited.visited, true);
  assert.equal(visited.recommendation.provenance, 'firsthand');
  assert.equal(researchedOnly.researched, true);
  assert.equal(researchedOnly.visited, false);
});

test('journal reads return raw notes unchanged and recommendations never merge private journal text', async () => {
  const rawNote = '  The tiny counter was perfect — keep this verbatim.  ';
  const journal = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'journal_entries', data: [
      { id: 'journal', author_id: ownerId, raw_note: rawNote, generated_summary: 'Generated', visibility: 'private' },
      { id: 'other-private', author_id: viewerId, raw_note: 'secret', visibility: 'private' },
      { id: 'other-trip', author_id: viewerId, raw_note: 'shared', visibility: 'trip' }
    ] }
  ]);
  const journalResult = await getRecentJournal(journal.ctx, { trip_id: tripId, limit: 25 });
  assert.equal(journalResult.entries[0].raw_note, rawNote);
  assert.equal(journalResult.entries[0].generated_summary, 'Generated');
  assert.deepEqual(journalResult.entries.map((entry) => entry.id), ['journal', 'other-trip']);

  const recommendations = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'recommendations', data: [
      { id: 'rec-1', place_id: placeId, provenance: 'firsthand', shareable_note: 'Share this', places: { id: placeId, name: 'Cafe' } },
      { id: 'rec-2', place_id: proposalId, provenance: 'research', shareable_note: null, places: { id: proposalId, name: 'Museum' } }
    ] },
    { table: 'place_visits', data: [{ id: 'visit', place_id: placeId }] },
    { table: 'research_items', data: [{ id: 'research', place_id: proposalId }] }
  ]);
  const recommendationResult = await getRecommendations(recommendations.ctx, {
    trip_id: tripId, provenance: ['firsthand'], shareable_only: true, limit: 100
  });
  assert.equal(recommendationResult.recommendations.length, 1);
  assert.equal(recommendationResult.recommendations[0].visit.id, 'visit');
  assert.equal('journal' in recommendationResult.recommendations[0], false);
});

test('trip lessons preserve stored confidence, status, and provenance', async () => {
  const explicit = { memory_type: 'preference', content: 'Quiet hotels', confidence: 1, status: 'confirmed', provenance: 'explicit' };
  const inferred = { trip_id: tripId, memory_type: 'trip_lesson', content: 'May enjoy later starts', confidence: 0.6, status: 'candidate', provenance: 'inferred' };
  const scripted = context([
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { table: 'memories', data: [explicit, inferred] }
  ]);
  const result = await getTripLessons(scripted.ctx, { trip_id: tripId, include_global_preferences: true });
  assert.deepEqual(result.preferences, [explicit]);
  assert.deepEqual(result.lessons, [inferred]);
});

test('proposal captures optimistic versions and never mutates itinerary rows', async () => {
  const existing = {
    id: itemId,
    trip_id: tripId,
    title: 'Lunch',
    planned_start: '2026-10-14T03:00:00Z',
    planned_end: '2026-10-14T04:00:00Z',
    status: 'planned',
    flexibility: 'flexible',
    updated_at: '2026-08-10T12:00:00.123456Z'
  };
  const scripted = context([
    ...ownerAccessAndTrip(),
    { table: 'itinerary_items', data: [existing] },
    { table: 'itinerary_change_proposals', data: { id: proposalId, status: 'pending' } }
  ]);
  await proposeItineraryChange(scripted.ctx, {
    trip_id: tripId,
    summary: 'Move lunch',
    expires_in_minutes: 60,
    operations: [{
      op: 'update', itinerary_item_id: itemId,
      patch: { planned_start: '2026-10-14T04:00:00Z', planned_end: '2026-10-14T05:00:00Z' }
    }]
  });
  const insert = scripted.supabase.calls.find((call) => call.table === 'itinerary_change_proposals');
  assert.equal(insert.value.operations[0].expected_updated_at, existing.updated_at);
  assert.equal(scripted.supabase.calls.some((call) => call.table === 'itinerary_items' && call.operation !== 'select'), false);
});

test('commit delegates the approved proposal to one atomic RPC and viewer writes are rejected', async () => {
  const committed = { proposal_id: proposalId, status: 'committed', changed_items: [], added_items: [] };
  const owner = context([
    { table: 'itinerary_change_proposals', data: { id: proposalId, trip_id: tripId, status: 'pending' } },
    { table: 'trips', data: { id: tripId, owner_id: ownerId } },
    { rpc: 'commit_itinerary_change_proposal', data: committed }
  ]);
  assert.deepEqual(await commitItineraryChange(owner.ctx, proposalId), committed);
  assert.deepEqual(owner.supabase.calls[2].args, { p_proposal_id: proposalId, p_actor_id: ownerId });

  const viewer = context([
    ...ownerAccessAndTrip().slice(0, 1),
    { table: 'trip_members', data: { role: 'viewer' } }
  ], viewerId);
  await assert.rejects(() => proposeItineraryChange(viewer.ctx, {
    trip_id: tripId,
    summary: 'Not allowed',
    operations: [{ op: 'update', itinerary_item_id: itemId, patch: { status: 'cancelled' } }]
  }), /read-only/);
  assert.equal(viewer.supabase.calls.some((call) => call.table === 'itinerary_change_proposals'), false);
});
