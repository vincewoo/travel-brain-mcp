import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('trip select policy evaluates the inserted owner row directly for RETURNING', async () => {
  const migrationUrl = new URL('../../supabase/migrations/202608100005_trip_insert_returning.sql', import.meta.url);
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\s+/g, ' ').toLowerCase();

  assert.match(sql, /create policy trips_member_select/);
  assert.match(sql, /owner_id = auth\.uid\(\) or public\.is_trip_member\(id\)/);
});
