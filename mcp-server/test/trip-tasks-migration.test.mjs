import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/202608120002_trip_tasks.sql', import.meta.url);
const sql = (await readFile(migrationUrl, 'utf8')).replace(/\s+/g, ' ').toLowerCase();

test('trip tasks carry optional dates with explicit deadline or opening semantics', () => {
  assert.match(sql, /create table public\.trip_tasks/);
  assert.match(sql, /due_date date/);
  assert.match(sql, /date_kind text not null default 'due'/);
  assert.match(sql, /date_kind in \('due', 'opens'\)/);
  assert.match(sql, /completed_at timestamptz/);
});

test('trip task access follows trip membership and edit roles', () => {
  assert.match(sql, /trip_tasks_member_select.*public\.is_trip_member\(trip_id\)/);
  assert.match(sql, /trip_tasks_editor_insert.*public\.can_edit_trip\(trip_id\)/);
  assert.match(sql, /trip_tasks_editor_update.*public\.can_edit_trip\(trip_id\)/);
  assert.match(sql, /alter table public\.trip_tasks enable row level security/);
});
