import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/202608110002_itinerary_removal.sql', import.meta.url);
const sql = (await readFile(migrationUrl, 'utf8')).replace(/\s+/g, ' ').toLowerCase();

test('history reasons cover every table that can make an itinerary item evidence', () => {
  const reasons = sql.slice(sql.indexOf('create or replace function public.itinerary_item_history_reasons'), sql.indexOf('create or replace function public.delete_itinerary_item'));
  for (const source of ['journal_entries', 'place_visits', 'reservations', 'media_assets', 'current_trip_state']) {
    assert.match(reasons, new RegExp(`public\\.${source}`));
  }
  assert.match(reasons, /status in \('in_progress', 'completed'\)/);
  assert.match(reasons, /actual_start is not null or actual_end is not null/);
});

test('the delete RPC checks the actor, locks the row, refuses history, and replays idempotently', () => {
  const remove = sql.slice(sql.indexOf('create or replace function public.delete_itinerary_item'), sql.indexOf('create or replace function public.commit_itinerary_change_proposal'));
  assert.match(remove, /actor identity does not match the authenticated user/);
  assert.match(remove, /where id = p_itinerary_item_id for update/);
  assert.match(remove, /tm\.role in \('owner', 'editor'\)/);
  assert.match(remove, /'error_code', 'item_has_history'/);
  assert.match(remove, /'idempotent_replay', true/);
  assert.match(remove, /delete from public\.itinerary_items where id = p_itinerary_item_id/);
});

test('the commit RPC removes only unversioned, history-free items and still reports what it deleted', () => {
  const commit = sql.slice(sql.indexOf('create or replace function public.commit_itinerary_change_proposal'));
  assert.match(commit, /v_operation->>'op' = 'remove'/);
  // Removals share the update path's locking, optimistic version, and all-or-nothing checks.
  assert.match(commit, /where i\.id = any\(v_changed_ids \|\| v_removed_ids\) order by i\.id for update/);
  assert.match(commit, /expected_updated_at/);
  assert.match(commit, /'error_code', 'stale_proposal'/);
  assert.match(commit, /'error_code', 'item_has_history'/);
  assert.match(commit, /itinerary_item_history_reasons\(v_item_id\)/);
  assert.match(commit, /delete from public\.itinerary_items where id = v_item_id and trip_id = v_proposal\.trip_id/);
  assert.match(commit, /'removed_items', v_removed_items/);
  assert.match(commit, /'removed_item_ids', to_jsonb\(v_removed_ids\)/);
});

test('the one-time cleanup sweeps only history-free cancelled and skipped rows', () => {
  const cleanup = sql.slice(sql.indexOf('one-time cleanup of the cruft'));
  assert.match(cleanup, /i\.status in \('cancelled', 'skipped'\)/);
  assert.match(cleanup, /cardinality\(public\.itinerary_item_history_reasons\(i\.id\)\) = 0/);
  assert.match(cleanup, /delete from public\.itinerary_items target using cruft where target\.id = cruft\.id/);
  // Anything still planned or confirmed is a live plan, not cruft.
  assert.doesNotMatch(cleanup, /'planned'|'confirmed'/);
});

test('the removal functions stay locked down to trip editors', () => {
  assert.match(sql, /revoke all on function public\.delete_itinerary_item\(uuid, uuid\) from public/);
  assert.match(sql, /grant execute on function public\.delete_itinerary_item\(uuid, uuid\) to authenticated, service_role/);
  assert.match(sql, /revoke all on function public\.itinerary_item_history_reasons\(uuid\) from public/);
});
