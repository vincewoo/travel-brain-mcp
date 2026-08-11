import assert from 'node:assert/strict';
import test from 'node:test';
import { knownZone, zonedInstant, zonedInstants } from '../src/instants.mjs';
import { addItineraryItem, markPlaceVisited, proposeItineraryChange, updateItineraryItem } from '../src/db.mjs';
import { createScriptedSupabase } from './support/scripted-supabase.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const placeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function context(actorId, steps) {
  const supabase = createScriptedSupabase(steps);
  return { ctx: { actorId, supabase, authMode: 'static', authInfo: {} }, supabase };
}

const hongKongTrip = { id: tripId, owner_id: ownerId, timezone: 'Asia/Hong_Kong' };

test('a wall-clock time is read on the given zone, not as UTC', () => {
  // The bug this guards: 09:00 in Guilin stored as 09:00Z, which is 5pm on the traveller's clock.
  assert.equal(zonedInstant('2026-12-28T09:00', 'Asia/Hong_Kong'), '2026-12-28T01:00:00.000Z');
  assert.equal(zonedInstant('2026-12-28T09:00:00', 'Asia/Hong_Kong'), '2026-12-28T01:00:00.000Z');
  assert.equal(zonedInstant('2026-12-28 09:00', 'Asia/Hong_Kong'), '2026-12-28T01:00:00.000Z');
  assert.equal(zonedInstant('2026-12-28T09:00:00.500', 'Asia/Hong_Kong'), '2026-12-28T01:00:00.500Z');
  assert.equal(zonedInstant('2026-12-28', 'Asia/Hong_Kong'), '2026-12-27T16:00:00.000Z');
});

test('an explicit offset is left exactly as the caller wrote it', () => {
  for (const value of ['2026-12-28T09:00:00+08:00', '2026-12-28T01:00:00Z', '2026-12-28T09:00:00+0800']) {
    assert.equal(zonedInstant(value, 'Asia/Hong_Kong'), value);
  }
});

test('a wall clock resolves against the offset in force on its own side of a DST change', () => {
  assert.equal(zonedInstant('2026-01-15T09:00', 'America/Los_Angeles'), '2026-01-15T17:00:00.000Z');
  assert.equal(zonedInstant('2026-07-15T09:00', 'America/Los_Angeles'), '2026-07-15T16:00:00.000Z');
  // 02:30 on a spring-forward morning never happens; it must still land on a real instant.
  assert.equal(zonedInstant('2026-03-08T02:30', 'America/Los_Angeles'), '2026-03-08T10:30:00.000Z');
});

test('values with nothing to resolve pass through untouched', () => {
  assert.equal(zonedInstant(null, 'Asia/Hong_Kong'), null);
  assert.equal(zonedInstant(undefined, 'Asia/Hong_Kong'), undefined);
  assert.equal(zonedInstant('not a timestamp', 'Asia/Hong_Kong'), 'not a timestamp');
  const date = new Date('2026-12-28T01:00:00Z');
  assert.equal(zonedInstant(date, 'Asia/Hong_Kong'), date);
  // An unusable zone is no reason to invent an instant: leave the value for Postgres to read.
  assert.equal(zonedInstant('2026-12-28T09:00', 'Mars/Olympus_Mons'), '2026-12-28T09:00');
  assert.equal(knownZone('Mars/Olympus_Mons'), false);
  assert.equal(knownZone('Asia/Hong_Kong'), true);
});

test('zonedInstants converts only the named keys and leaves absent ones absent', () => {
  const result = zonedInstants(
    { planned_start: '2026-12-28T09:00', title: 'Li River Cruise' },
    ['planned_start', 'planned_end'],
    'Asia/Hong_Kong'
  );
  assert.deepEqual(result, { planned_start: '2026-12-28T01:00:00.000Z', title: 'Li River Cruise' });
  assert.equal('planned_end' in result, false);
});

test('a new itinerary item is stored at the instant the traveller experiences', async () => {
  const scripted = context(ownerId, [
    { table: 'trips', data: hongKongTrip },
    { table: 'itinerary_items', data: { id: itemId } }
  ]);
  await addItineraryItem(scripted.ctx, {
    trip_id: tripId,
    title: 'Li River Cruise (Guilin to Yangshuo)',
    planned_start: '2026-12-28T09:00:00',
    planned_end: '2026-12-28T13:00:00'
  });
  const row = scripted.supabase.calls[1].value;
  assert.equal(row.planned_start, '2026-12-28T01:00:00.000Z');
  assert.equal(row.planned_end, '2026-12-28T05:00:00.000Z');
});

test('an item timezone overrides the trip zone for that item', async () => {
  const scripted = context(ownerId, [
    { table: 'trips', data: { ...hongKongTrip, timezone: 'America/Los_Angeles' } },
    { table: 'itinerary_items', data: { id: itemId } }
  ]);
  await addItineraryItem(scripted.ctx, {
    trip_id: tripId,
    title: 'Elephant Trunk Hill',
    timezone: 'Asia/Hong_Kong',
    planned_start: '2026-12-27T16:00:00'
  });
  assert.equal(scripted.supabase.calls[1].value.planned_start, '2026-12-27T08:00:00.000Z');
});

test('an itinerary update reads its times on the item own clock', async () => {
  const scripted = context(ownerId, [
    { table: 'itinerary_items', data: { trip_id: tripId, timezone: 'Asia/Hong_Kong' } },
    { table: 'trips', data: { ...hongKongTrip, timezone: 'UTC' } },
    { table: 'itinerary_items', data: { id: itemId } }
  ]);
  await updateItineraryItem(scripted.ctx, {
    itinerary_item_id: itemId,
    planned_start: '2026-12-29T14:30',
    status: 'confirmed'
  });
  assert.deepEqual(scripted.supabase.calls[2].value, {
    planned_start: '2026-12-29T06:30:00.000Z',
    status: 'confirmed'
  });
});

test('visit times are read on the trip clock and copied to the item as actuals', async () => {
  const scripted = context(ownerId, [
    { table: 'trips', data: hongKongTrip },
    { table: 'itinerary_items', data: { trip_id: tripId, timezone: null } },
    { table: 'place_visits', data: { id: 'visit-id' } },
    { table: 'trip_places', data: null },
    { table: 'itinerary_items', data: null }
  ]);
  await markPlaceVisited(scripted.ctx, {
    trip_id: tripId,
    place_id: placeId,
    itinerary_item_id: itemId,
    arrived_at: '2026-12-28T09:05',
    departed_at: '2026-12-28T12:40'
  });
  assert.equal(scripted.supabase.calls[2].value.arrived_at, '2026-12-28T01:05:00.000Z');
  assert.deepEqual(scripted.supabase.calls[4].value, {
    status: 'completed',
    actual_start: '2026-12-28T01:05:00.000Z',
    actual_end: '2026-12-28T04:40:00.000Z'
  });
});

test('a proposal stores the resolved instants it will commit', async () => {
  const existing = {
    id: itemId,
    trip_id: tripId,
    title: 'Reed Flute Cave',
    timezone: 'Asia/Hong_Kong',
    planned_start: '2026-12-29T06:30:00+00:00',
    planned_end: '2026-12-29T08:00:00+00:00',
    status: 'planned',
    flexibility: 'semi_flexible',
    updated_at: '2026-08-11T02:00:00+00:00'
  };
  const scripted = context(ownerId, [
    { table: 'trips', data: hongKongTrip },
    { table: 'trips', data: { ...hongKongTrip, title: 'Hong Kong Family Trip' } },
    { table: 'itinerary_items', data: [existing] },
    { table: 'itinerary_change_proposals', data: { id: 'proposal-id' } }
  ]);
  const { diff } = await proposeItineraryChange(scripted.ctx, {
    trip_id: tripId,
    summary: 'Move the cave visit later',
    operations: [{ op: 'update', itinerary_item_id: itemId, patch: { planned_start: '2026-12-29T15:30' } }]
  });
  const stored = scripted.supabase.calls[3].value;
  assert.equal(stored.operations[0].patch.planned_start, '2026-12-29T07:30:00.000Z');
  // The traveller approves the diff, so it has to show the instant the commit will write.
  assert.equal(diff[0].after.planned_start, '2026-12-29T07:30:00.000Z');
});
