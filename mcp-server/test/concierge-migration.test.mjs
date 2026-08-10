import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/202608100006_concierge.sql', import.meta.url);
const sql = (await readFile(migrationUrl, 'utf8')).replace(/\s+/g, ' ').toLowerCase();

test('concierge migration reuses singleton current state and creates no location history table', () => {
  assert.doesNotMatch(sql, /create table (?:if not exists )?public\.(?:location_history|trip_locations|location_events)/);
  assert.match(sql, /create table public\.itinerary_change_proposals/);
});

test('nearby RPC uses PostGIS geography distance and radius filtering', () => {
  assert.match(sql, /extensions\.st_distance/);
  assert.match(sql, /extensions\.st_dwithin/);
  assert.match(sql, /order by distance_meters asc/);
});

test('commit RPC locks, checks optimistic versions, applies no deletes, and is idempotent', () => {
  assert.match(sql, /for update/);
  assert.match(sql, /expected_updated_at/);
  assert.match(sql, /'error_code', 'stale_proposal'/);
  assert.match(sql, /if v_proposal\.status = 'committed'/);
  assert.match(sql, /idempotent_replay/);
  assert.doesNotMatch(sql, /delete from public\.itinerary_items/);
  assert.match(sql, /update public\.itinerary_change_proposals set status = 'committed'/);
});

test('proposal RLS permits member reads and editor inserts but no direct mutation policy', () => {
  assert.match(sql, /using \(public\.is_trip_member\(trip_id\)\)/);
  assert.match(sql, /created_by = auth\.uid\(\).*status = 'pending'.*committed_at is null.*public\.can_edit_trip\(trip_id\)/);
  assert.doesNotMatch(sql, /create policy itinerary_change_[a-z_]+ on public\.itinerary_change_proposals for update/);
});
