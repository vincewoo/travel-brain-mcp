import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/202608120001_place_coordinates.sql', import.meta.url);
const raw = await readFile(migrationUrl, 'utf8');
const sql = raw.replace(/\s+/g, ' ').toLowerCase();

test('a stored point and its source can only exist together', () => {
  // The whole point of the column is that a coordinate is never anonymous. A point with no source
  // would be indistinguishable on the map from a surveyed one, and a source with no point is a
  // claim about nothing — so the database refuses both rather than tidying up on read.
  assert.match(sql, /coordinate_source in \('provided', 'estimated', 'geocoded'\)/);
  assert.match(
    sql,
    /\(location is null and coordinate_source is null\) or \(location is not null and coordinate_source is not null\)/
  );
});

test('geocoded is declared before anything uses it, so adding one later is not another migration', () => {
  // Nothing writes 'geocoded' today; it is in the constraint so that a future geocoding path is a
  // code change rather than an ALTER against a live table.
  assert.match(sql, /'geocoded'/);
  assert.equal(/insert .*'geocoded'|update .*'geocoded'/.test(sql), false);
});

test('trip_offline_places is dropped before it is recreated carrying the source', () => {
  // A function's OUT columns cannot change under CREATE OR REPLACE, so the order here is load
  // bearing: replacing it in place would fail against a deployed database.
  const dropAt = sql.indexOf('drop function if exists public.trip_offline_places(uuid)');
  const createAt = sql.indexOf('create function public.trip_offline_places(p_trip_id uuid)');
  assert.ok(dropAt !== -1, 'the old function must be dropped');
  assert.ok(createAt > dropAt, 'the new function must be created after the drop');

  const fn = sql.slice(createAt);
  assert.match(fn, /coordinate_source text/);
  assert.match(fn, /p\.coordinate_source/);
  // The companion reads places through this function, so the phone only learns a point is an
  // estimate if the source travels with it.
  assert.match(fn, /security invoker/);
  assert.match(fn, /grant execute on function public\.trip_offline_places\(uuid\) to authenticated, service_role/);
});

test('every point that predates the column is given a conservative source before the constraint', () => {
  assert.match(sql, /add column if not exists coordinate_source text/);

  // `places` is global, not per-trip: a place saved for any trip can already carry a point. The
  // first version of this migration assumed otherwise and was rejected in production by
  // places_coordinate_source_requires_point. The backfill is what makes the constraint addable.
  const backfill = sql.slice(sql.indexOf('update public.places'), sql.indexOf('drop constraint if exists places_coordinate_source_requires_point'));
  assert.ok(backfill.includes('update public.places'), 'pre-existing points must be backfilled');
  assert.match(backfill, /set coordinate_source = 'estimated'/);
  // Scoped so it can neither invent a source for a place that has no point nor overwrite one that
  // already has a source.
  assert.match(backfill, /where location is not null and coordinate_source is null/);

  // Conservative on purpose: the provenance of these points is unrecoverable, and calling them
  // 'provided' would assert a precision the data cannot support.
  assert.equal(/set coordinate_source = 'provided'/.test(sql), false);
});

test('the backfill runs before the constraint that would reject the rows it fixes', () => {
  const backfillAt = sql.indexOf('update public.places');
  const constraintAt = sql.indexOf('add constraint places_coordinate_source_requires_point');
  assert.ok(backfillAt !== -1 && constraintAt !== -1);
  assert.ok(backfillAt < constraintAt, 'the constraint must be added after the rows are fixed');
});
