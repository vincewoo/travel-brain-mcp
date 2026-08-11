import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { zonedInstant, zonedInstants } from './instants.mjs';
import {
  activeScheduledItems,
  dateRange,
  localDateTime,
  overlapIssues,
  researchFreshness,
  schedulePosition,
  sortedTimeline,
  stableIssueId,
  timelineInstant,
  validInstant
} from './trip-clock.mjs';

/** Timestamps a caller may send as a trip-local wall clock rather than as an absolute instant. */
const ITINERARY_INSTANTS = ['planned_start', 'planned_end', 'actual_start', 'actual_end'];

export function createDbContext(config, authInfo, clientFactory = createClient) {
  if (!authInfo || typeof authInfo.token !== 'string') {
    throw new Error('Authenticated request context is required.');
  }

  if (config.authMode === 'static') {
    if (authInfo.extra?.authMode !== 'static' || authInfo.extra?.actorId !== config.actorId) {
      throw new Error('Static authentication identity mismatch.');
    }
    return {
      actorId: config.actorId,
      authInfo,
      authMode: 'static',
      locationFreshnessMinutes: config.locationFreshnessMinutes,
      supabase: clientFactory(config.supabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      })
    };
  }

  const actorId = authInfo.extra?.actorId;
  if (
    authInfo.extra?.authMode !== 'supabase_oauth' ||
    authInfo.extra?.issuer !== config.supabaseOAuthIssuer ||
    typeof actorId !== 'string'
  ) {
    throw new Error('Supabase OAuth identity is missing or invalid.');
  }
  return {
    actorId,
    authInfo,
    authMode: 'supabase_oauth',
    locationFreshnessMinutes: config.locationFreshnessMinutes,
    supabase: clientFactory(config.supabaseUrl, config.publishableKey, {
      // Treat the caller's OAuth JWT as the request-scoped Supabase session token.
      // This guarantees Data API requests derive Authorization from the verified
      // user JWT rather than client auth state or the API-key fallback.
      accessToken: async () => authInfo.token
    })
  };
}

function fail(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function ensureProfile(ctx) {
  const { supabase, actorId } = ctx;
  const { error } = await supabase.from('profiles').upsert({ id: actorId }, { onConflict: 'id' });
  fail(error, 'ensureProfile');
}

/**
 * Access check for a trip. It also hands back the trip's timezone, because every writer that
 * stores a timestamp needs the trip's clock to read naive values against, and this is the one
 * lookup they all already make.
 */
export async function tripAccess(ctx, tripId, edit = false) {
  const { supabase, actorId } = ctx;
  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .select('id, owner_id, timezone')
    .eq('id', tripId)
    .maybeSingle();
  fail(tripError, 'tripAccess trip');
  if (!trip) throw new Error('Trip not found.');
  if (trip.owner_id === actorId) return { role: 'owner', timezone: trip.timezone ?? 'UTC' };

  const { data: membership, error: memberError } = await supabase
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', actorId)
    .maybeSingle();
  fail(memberError, 'tripAccess membership');
  if (!membership) throw new Error('Not authorized for this trip.');
  if (edit && !['owner', 'editor'].includes(membership.role)) {
    throw new Error('Trip access is read-only.');
  }
  return { ...membership, timezone: trip.timezone ?? 'UTC' };
}

/** The trip an itinerary item belongs to, plus the item's own zone override when it has one. */
async function itemClock(ctx, itemId) {
  const { supabase } = ctx;
  const { data, error } = await supabase
    .from('itinerary_items')
    .select('trip_id, timezone')
    .eq('id', itemId)
    .single();
  fail(error, 'itemTripId');
  return data;
}

const itemTripId = async (ctx, itemId) => (await itemClock(ctx, itemId)).trip_id;

export async function listTrips(ctx) {
  const { supabase, actorId } = ctx;
  const [{ data: owned, error: ownedError }, { data: memberships, error: memberError }] = await Promise.all([
    supabase.from('trips').select('*').eq('owner_id', actorId),
    supabase.from('trip_members').select('trip_id, role').eq('user_id', actorId)
  ]);
  fail(ownedError, 'listTrips owned');
  fail(memberError, 'listTrips memberships');

  const ownedIds = new Set((owned ?? []).map((t) => t.id));
  const otherIds = (memberships ?? []).map((m) => m.trip_id).filter((id) => !ownedIds.has(id));
  let shared = [];
  if (otherIds.length) {
    const { data, error } = await supabase.from('trips').select('*').in('id', otherIds);
    fail(error, 'listTrips shared');
    shared = data ?? [];
  }
  return [...(owned ?? []), ...shared].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));
}

export async function createTrip(ctx, input) {
  const { supabase, actorId } = ctx;
  const { data: trip, error } = await supabase
    .from('trips')
    .insert({ ...input, owner_id: actorId })
    .select('*')
    .single();
  fail(error, 'createTrip');

  const { error: memberError } = await supabase
    .from('trip_members')
    .upsert({ trip_id: trip.id, user_id: actorId, role: 'owner' }, { onConflict: 'trip_id,user_id' });
  fail(memberError, 'createTrip membership');
  return trip;
}

export async function getTrip(ctx, tripId) {
  const { supabase } = ctx;
  await tripAccess(ctx, tripId, false);
  const queries = await Promise.all([
    supabase.from('trips').select('*').eq('id', tripId).single(),
    supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('planned_start', { ascending: true }),
    supabase.from('reservations').select('*').eq('trip_id', tripId),
    supabase.from('trip_places').select('*, places(*)').eq('trip_id', tripId),
    supabase.from('place_visits').select('*').eq('trip_id', tripId),
    supabase.from('journal_entries').select('*').eq('trip_id', tripId).order('captured_at', { ascending: true }),
    supabase.from('research_items').select('*, research_sources(*)').eq('trip_id', tripId),
    supabase.from('recommendations').select('*').eq('trip_id', tripId)
  ]);
  for (const result of queries) fail(result.error, 'getTrip');
  return {
    trip: queries[0].data,
    itinerary: queries[1].data ?? [],
    reservations: queries[2].data ?? [],
    places: queries[3].data ?? [],
    visits: queries[4].data ?? [],
    journal: (queries[5].data ?? []).filter(
      (entry) => entry.author_id === ctx.actorId || entry.visibility !== 'private'
    ),
    research: queries[6].data ?? [],
    recommendations: queries[7].data ?? []
  };
}

/**
 * Append-only writes replayed from an offline queue.
 *
 * A companion app that captures a journal note in a tunnel sends it when the signal returns, and
 * if the response is lost on the way back it will send it again. `insert` alone would write the
 * note twice. When the caller supplies a `client_op_id` these writes become idempotent: the
 * operation is looked up first, and the unique indexes from `202608110003_offline_snapshot.sql`
 * catch the concurrent case where two replays race. Either way the original row is what comes
 * back, so a replay is indistinguishable from the first call — which is the point.
 *
 * Callers that pass no `client_op_id` (the planning agent, mostly) skip the lookup entirely and
 * keep the single-insert query sequence they always had.
 */
function clientOpMetadata(input) {
  const metadata = input.metadata ?? {};
  return input.client_op_id ? { ...metadata, client_op_id: input.client_op_id } : metadata;
}

async function findClientOp(ctx, table, clientOpId, scope, context) {
  let query = ctx.supabase.from(table).select('*').eq('metadata->>client_op_id', clientOpId);
  for (const [column, value] of Object.entries(scope)) query = query.eq(column, value);
  const { data, error } = await query.maybeSingle();
  fail(error, context);
  return data ?? null;
}

async function insertOnce(ctx, table, record, input, scope, context) {
  const clientOpId = input.client_op_id ?? null;
  if (clientOpId) {
    const existing = await findClientOp(ctx, table, clientOpId, scope, `${context} replay lookup`);
    if (existing) return existing;
  }
  const { data, error } = await ctx.supabase.from(table).insert(record).select('*').single();
  // 23505 is the unique-violation the client-op index raises when a concurrent replay of the same
  // operation committed between the lookup above and this insert. Its row is the answer.
  if (error?.code === '23505' && clientOpId) {
    const raced = await findClientOp(ctx, table, clientOpId, scope, `${context} replay lookup`);
    if (raced) return raced;
  }
  fail(error, context);
  return data;
}

export async function addPlace(ctx, input) {
  const { supabase, actorId } = ctx;
  if (input.trip_id) await tripAccess(ctx, input.trip_id, true);
  const record = {
    created_by: actorId,
    name: input.name,
    normalized_name: input.normalized_name ?? input.name.toLowerCase().trim(),
    category: input.category ?? null,
    address: input.address ?? null,
    locality: input.locality ?? null,
    region: input.region ?? null,
    country_code: input.country_code ?? null,
    external_ids: input.external_ids ?? {},
    metadata: clientOpMetadata(input)
  };
  if (input.latitude != null && input.longitude != null) {
    record.location = `POINT(${input.longitude} ${input.latitude})`;
  }

  const place = await insertOnce(ctx, 'places', record, input, { created_by: actorId }, 'addPlace');

  if (input.trip_id) {
    const { error: linkError } = await supabase.from('trip_places').upsert({
      trip_id: input.trip_id,
      place_id: place.id,
      status: input.trip_status ?? 'shortlist'
    }, { onConflict: 'trip_id,place_id' });
    fail(linkError, 'addPlace trip link');
  }
  return place;
}

export async function addItineraryItem(ctx, input) {
  const { supabase } = ctx;
  const access = await tripAccess(ctx, input.trip_id, true);
  // The item's own zone wins when it has one: a Guilin day inside a Hong Kong trip is planned
  // on Guilin's clock.
  const zone = input.timezone ?? access.timezone;
  const timed = zonedInstants(input, ITINERARY_INSTANTS, zone);
  const { data, error } = await supabase
    .from('itinerary_items')
    .insert({
      trip_id: input.trip_id,
      place_id: input.place_id ?? null,
      title: input.title,
      item_type: input.item_type ?? 'activity',
      planned_start: timed.planned_start ?? null,
      planned_end: timed.planned_end ?? null,
      timezone: input.timezone ?? null,
      flexibility: input.flexibility ?? 'flexible',
      priority: input.priority ?? 3,
      status: input.status ?? 'planned',
      notes: input.notes ?? null,
      metadata: input.metadata ?? {}
    })
    .select('*')
    .single();
  fail(error, 'addItineraryItem');
  return data;
}

export async function updateItineraryItem(ctx, input) {
  const { supabase } = ctx;
  const item = await itemClock(ctx, input.itinerary_item_id);
  const access = await tripAccess(ctx, item.trip_id, true);
  const allowed = [...ITINERARY_INSTANTS, 'flexibility', 'priority', 'status', 'notes'];
  const patch = zonedInstants(
    Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.includes(key) && value !== undefined)),
    ITINERARY_INSTANTS,
    item.timezone ?? access.timezone
  );
  const { data, error } = await supabase
    .from('itinerary_items')
    .update(patch)
    .eq('id', input.itinerary_item_id)
    .select('*')
    .single();
  fail(error, 'updateItineraryItem');
  return data;
}

/**
 * Fields that make an itinerary row evidence rather than intent. The RPC re-checks these
 * plus every table that points at the item; this local copy only exists to reject the
 * obvious cases early, with the same wording.
 */
function livedItemReasons(item) {
  const reasons = [];
  if (['in_progress', 'completed'].includes(item.status)) reasons.push('lived_status');
  if (item.actual_start || item.actual_end) reasons.push('actual_times');
  return reasons;
}

export async function removeItineraryItem(ctx, input) {
  const { data: existing, error: lookupError } = await ctx.supabase
    .from('itinerary_items')
    .select('trip_id')
    .eq('id', input.itinerary_item_id)
    .maybeSingle();
  fail(lookupError, 'removeItineraryItem lookup');
  // Removing an item that is already gone is the end state the caller asked for.
  if (!existing) return { status: 'deleted', itinerary_item: null, idempotent_replay: true };
  await tripAccess(ctx, existing.trip_id, true);
  const { data, error } = await ctx.supabase.rpc('delete_itinerary_item', {
    p_itinerary_item_id: input.itinerary_item_id,
    p_actor_id: ctx.actorId
  });
  fail(error, 'removeItineraryItem');
  return data;
}

export async function saveResearchFinding(ctx, input) {
  const { supabase, actorId } = ctx;
  // Research can be trip-less, and then there is no traveller's clock to read a bare
  // timestamp against; UTC is the only defensible reading left.
  const zone = input.trip_id ? (await tripAccess(ctx, input.trip_id, true)).timezone : 'UTC';
  const dated = zonedInstants(input, ['valid_as_of', 'expires_at'], zone);
  const { data: item, error } = await supabase.from('research_items').insert({
    owner_id: actorId,
    trip_id: input.trip_id ?? null,
    place_id: input.place_id ?? null,
    topic: input.topic,
    finding: input.finding,
    summary: input.summary ?? null,
    volatility: input.volatility ?? 'semi_volatile',
    confidence: input.confidence ?? 0.8,
    status: 'active',
    valid_as_of: dated.valid_as_of ?? new Date().toISOString(),
    expires_at: dated.expires_at ?? null,
    metadata: input.metadata ?? {}
  }).select('*').single();
  fail(error, 'saveResearchFinding');

  if (input.sources?.length) {
    const rows = input.sources.map((s) => ({
      research_item_id: item.id,
      source_url: s.source_url,
      source_title: s.source_title ?? null,
      publisher: s.publisher ?? null,
      source_kind: s.source_kind ?? 'web',
      retrieved_at: zonedInstant(s.retrieved_at, zone) ?? new Date().toISOString(),
      note: s.note ?? null
    }));
    const { error: sourceError } = await supabase.from('research_sources').insert(rows);
    fail(sourceError, 'saveResearchFinding sources');
  }
  return item;
}

export async function recordJournalNote(ctx, input) {
  const { actorId } = ctx;
  const access = await tripAccess(ctx, input.trip_id, true);
  const record = {
    trip_id: input.trip_id,
    author_id: actorId,
    itinerary_item_id: input.itinerary_item_id ?? null,
    place_id: input.place_id ?? null,
    captured_at: zonedInstant(input.captured_at, access.timezone) ?? new Date().toISOString(),
    raw_note: input.raw_note,
    reaction: input.reaction ?? null,
    visibility: input.visibility ?? 'private',
    metadata: clientOpMetadata(input)
  };
  if (input.latitude != null && input.longitude != null) {
    record.location = `POINT(${input.longitude} ${input.latitude})`;
  }
  return insertOnce(
    ctx,
    'journal_entries',
    record,
    input,
    { trip_id: input.trip_id, author_id: actorId },
    'recordJournalNote'
  );
}

export async function markPlaceVisited(ctx, input) {
  const { supabase } = ctx;
  const access = await tripAccess(ctx, input.trip_id, true);
  let zone = access.timezone;
  if (input.itinerary_item_id) {
    const item = await itemClock(ctx, input.itinerary_item_id);
    if (item.trip_id !== input.trip_id) {
      throw new Error('The itinerary item does not belong to this trip.');
    }
    zone = item.timezone ?? zone;
  }
  const visited = zonedInstants(input, ['arrived_at', 'departed_at'], zone);
  const record = {
    trip_id: input.trip_id,
    place_id: input.place_id,
    itinerary_item_id: input.itinerary_item_id ?? null,
    arrived_at: visited.arrived_at ?? null,
    departed_at: visited.departed_at ?? null,
    rating: input.rating ?? null,
    would_return: input.would_return ?? null,
    recommendation: input.recommendation ?? 'none',
    notes: input.notes ?? null
  };
  if (input.client_op_id || input.metadata) record.metadata = clientOpMetadata(input);
  // The trip-place and itinerary updates below stay outside the replay check on purpose: they are
  // upserts and same-value updates, so re-running them after a half-completed first attempt is
  // how the visit's side effects converge rather than something to skip.
  const visit = await insertOnce(
    ctx,
    'place_visits',
    record,
    input,
    { trip_id: input.trip_id, place_id: input.place_id },
    'markPlaceVisited'
  );

  const { error: linkError } = await supabase.from('trip_places').upsert({
    trip_id: input.trip_id,
    place_id: input.place_id,
    status: 'visited'
  }, { onConflict: 'trip_id,place_id' });
  fail(linkError, 'markPlaceVisited trip_place');

  if (input.itinerary_item_id) {
    const patch = { status: 'completed' };
    if (visited.arrived_at) patch.actual_start = visited.arrived_at;
    if (visited.departed_at) patch.actual_end = visited.departed_at;
    const { error: itemError } = await supabase.from('itinerary_items').update(patch).eq('id', input.itinerary_item_id);
    fail(itemError, 'markPlaceVisited itinerary');
  }
  return visit;
}

export async function rememberPreference(ctx, input) {
  const { actorId } = ctx;
  if (input.trip_id) await tripAccess(ctx, input.trip_id, false);
  const record = {
    owner_id: actorId,
    trip_id: input.trip_id ?? null,
    memory_type: input.memory_type ?? 'preference',
    content: input.content,
    confidence: input.confidence ?? (input.provenance === 'inferred' ? 0.6 : 1.0),
    status: input.status ?? (input.provenance === 'inferred' ? 'candidate' : 'confirmed'),
    provenance: input.provenance ?? 'explicit',
    metadata: clientOpMetadata(input),
    last_confirmed_at: (input.status === 'confirmed' || (!input.status && input.provenance !== 'inferred')) ? new Date().toISOString() : null
  };
  return insertOnce(ctx, 'memories', record, input, { owner_id: actorId }, 'rememberPreference');
}

export async function recommendPlace(ctx, input) {
  const { supabase, actorId } = ctx;
  await tripAccess(ctx, input.trip_id, true);
  if (input.provenance === 'firsthand') {
    const { data: visit, error } = await supabase
      .from('place_visits')
      .select('id')
      .eq('trip_id', input.trip_id)
      .eq('place_id', input.place_id)
      .limit(1)
      .maybeSingle();
    fail(error, 'recommendPlace visit check');
    if (!visit) throw new Error('A firsthand recommendation requires a recorded visit for this trip/place.');
  }
  const { data, error } = await supabase.from('recommendations').insert({
    trip_id: input.trip_id,
    author_id: actorId,
    place_id: input.place_id,
    provenance: input.provenance,
    level: input.level ?? 'recommend',
    shareable_note: input.shareable_note ?? null,
    caveats: input.caveats ?? null,
    best_for: input.best_for ?? [],
    metadata: input.metadata ?? {}
  }).select('*').single();
  fail(error, 'recommendPlace');
  return data;
}

function searchPattern(query) {
  return `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export async function searchTravelBrain(ctx, query, tripId = null) {
  const { supabase, actorId } = ctx;
  if (tripId) await tripAccess(ctx, tripId, false);
  const pattern = searchPattern(query);

  let memoriesQuery = supabase.from('memories').select('*').eq('owner_id', actorId).ilike('content', pattern).limit(10);
  let researchQuery = supabase.from('research_items').select('*, research_sources(*)').eq('owner_id', actorId).ilike('finding', pattern).limit(10);
  let journalQuery = supabase.from('journal_entries').select('*').eq('author_id', actorId).ilike('raw_note', pattern).limit(10);
  let recommendationsQuery = supabase.from('recommendations').select('*').eq('author_id', actorId).ilike('shareable_note', pattern).limit(10);

  if (tripId) {
    memoriesQuery = memoriesQuery.or(`trip_id.eq.${tripId},trip_id.is.null`);
    researchQuery = researchQuery.eq('trip_id', tripId);
    journalQuery = journalQuery.eq('trip_id', tripId);
    recommendationsQuery = recommendationsQuery.eq('trip_id', tripId);
  }

  const results = await Promise.all([memoriesQuery, researchQuery, journalQuery, recommendationsQuery]);
  for (const result of results) fail(result.error, 'searchTravelBrain');
  return {
    memories: results[0].data ?? [],
    research: results[1].data ?? [],
    journal: results[2].data ?? [],
    recommendations: results[3].data ?? []
  };
}

function parsePoint(location) {
  if (!location) return null;
  if (typeof location === 'string') {
    try {
      return parsePoint(JSON.parse(location));
    } catch {
      const match = location.match(/^POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/i);
      return match ? { longitude: Number(match[1]), latitude: Number(match[2]) } : null;
    }
  }
  const point = location.geometry ?? location;
  if (point.type === 'Point' && Array.isArray(point.coordinates)) {
    return { longitude: Number(point.coordinates[0]), latitude: Number(point.coordinates[1]) };
  }
  return null;
}

function locationView(currentState, atTime, freshnessMinutes) {
  const point = parsePoint(currentState?.last_location);
  if (!point || !currentState?.location_observed_at) return { status: 'missing' };
  const observedAt = validInstant(currentState.location_observed_at, 'location_observed_at');
  const ageMinutes = Math.max(0, (atTime - observedAt) / 60_000);
  return {
    status: ageMinutes <= freshnessMinutes ? 'fresh' : 'stale',
    latitude: point.latitude,
    longitude: point.longitude,
    observed_at: currentState.location_observed_at,
    age_minutes: Math.round(ageMinutes)
  };
}

async function loadTrip(ctx, tripId, edit = false) {
  await tripAccess(ctx, tripId, edit);
  const { data, error } = await ctx.supabase.from('trips').select('*').eq('id', tripId).single();
  fail(error, 'loadTrip');
  return data;
}

export async function getToday(ctx, tripId, requestedDate = null, atTime = new Date()) {
  const trip = await loadTrip(ctx, tripId);
  const instant = validInstant(zonedInstant(atTime, trip.timezone), 'at_time');
  const localNow = localDateTime(instant, trip.timezone);
  const date = requestedDate ?? localNow.date;
  const results = await Promise.all([
    ctx.supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('planned_start', { ascending: true }),
    ctx.supabase.from('reservations').select('*').eq('trip_id', tripId).order('reserved_start', { ascending: true }),
    ctx.supabase.from('place_visits').select('*').eq('trip_id', tripId).order('arrived_at', { ascending: true })
  ]);
  for (const result of results) fail(result.error, 'getToday');
  const onDate = (value) => value && localDateTime(value, trip.timezone).date === date;
  const timeline = sortedTimeline((results[0].data ?? []).filter((item) => onDate(timelineInstant(item))));
  const reservations = (results[1].data ?? []).filter((reservation) => onDate(reservation.reserved_start));
  const visits = (results[2].data ?? []).filter((visit) => onDate(visit.arrived_at ?? visit.created_at));
  const alerts = overlapIssues(timeline, trip.timezone);
  const position = date === localNow.date ? schedulePosition(timeline, instant) : { now: null, next: null, then: null };
  return {
    trip: { id: trip.id, title: trip.title, timezone: trip.timezone, status: trip.status },
    date,
    timezone: trip.timezone,
    local_time: localNow.time,
    timeline,
    reservations,
    fixed_anchors: [...timeline.filter((item) => item.flexibility === 'fixed'), ...reservations],
    visits,
    alerts,
    ...position
  };
}

export async function getCurrentContext(ctx, tripId, atTime = new Date()) {
  const trip = await loadTrip(ctx, tripId);
  const instant = validInstant(zonedInstant(atTime, trip.timezone), 'at_time');
  const local = localDateTime(instant, trip.timezone);
  const results = await Promise.all([
    ctx.supabase.from('current_trip_state').select('*').eq('trip_id', tripId).maybeSingle(),
    ctx.supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('planned_start', { ascending: true }),
    ctx.supabase.from('reservations').select('*').eq('trip_id', tripId).order('reserved_start', { ascending: true }),
    ctx.supabase.from('itinerary_change_proposals').select('*').eq('trip_id', tripId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  for (const result of results) fail(result.error, 'getCurrentContext');
  const currentState = results[0].data;
  const today = (results[1].data ?? []).filter((item) => {
    const itemInstant = timelineInstant(item);
    return itemInstant && localDateTime(itemInstant, trip.timezone).date === local.date;
  });
  const position = schedulePosition(today, instant, currentState?.current_itinerary_item_id);
  const nextFixed = [
    ...activeScheduledItems(results[1].data ?? []).filter((item) => item.flexibility === 'fixed').map((item) => ({ value: item, at: item.planned_start })),
    ...(results[2].data ?? []).map((reservation) => ({ value: reservation, at: reservation.reserved_start }))
  ].filter((candidate) => candidate.at && new Date(candidate.at) > instant)
    .sort((a, b) => new Date(a.at) - new Date(b.at))[0]?.value ?? null;
  return {
    trip: { id: trip.id, title: trip.title, timezone: trip.timezone, status: trip.status },
    local_date: local.date,
    local_time: local.time,
    current_state: currentState,
    location: locationView(currentState, instant, ctx.locationFreshnessMinutes ?? 30),
    ...position,
    next_fixed: nextFixed,
    running_late_minutes: currentState?.running_late_minutes ?? 0,
    alerts: overlapIssues(today, trip.timezone),
    timeline: sortedTimeline(today),
    pending_proposal: results[3].data ?? null
  };
}

function sameJson(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

export async function updateCurrentTripState(ctx, input) {
  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) throw new Error('latitude and longitude must be supplied together.');
  if (input.location_observed_at !== undefined && !hasLatitude) {
    throw new Error('location_observed_at requires latitude and longitude.');
  }
  const access = await tripAccess(ctx, input.trip_id, true);
  if (input.current_itinerary_item_id) {
    const linkedTripId = await itemTripId(ctx, input.current_itinerary_item_id);
    if (linkedTripId !== input.trip_id) throw new Error('The itinerary item does not belong to this trip.');
  }
  const { data: existing, error: readError } = await ctx.supabase
    .from('current_trip_state').select('*').eq('trip_id', input.trip_id).maybeSingle();
  fail(readError, 'updateCurrentTripState read');
  const patch = { updated_by: ctx.actorId };
  if (input.current_itinerary_item_id !== undefined) patch.current_itinerary_item_id = input.current_itinerary_item_id;
  if (input.running_late_minutes !== undefined) patch.running_late_minutes = input.running_late_minutes;
  if (input.state !== undefined) patch.state = input.state;
  if (hasLatitude) {
    patch.last_location = `POINT(${input.longitude} ${input.latitude})`;
    patch.location_observed_at = zonedInstant(input.location_observed_at, access.timezone) ?? new Date().toISOString();
  }

  if (existing) {
    const point = parsePoint(existing.last_location);
    const unchanged =
      (patch.current_itinerary_item_id === undefined || patch.current_itinerary_item_id === existing.current_itinerary_item_id) &&
      (patch.running_late_minutes === undefined || patch.running_late_minutes === existing.running_late_minutes) &&
      (patch.state === undefined || sameJson(patch.state, existing.state)) &&
      (!hasLatitude || (
        point?.latitude === input.latitude && point?.longitude === input.longitude &&
        new Date(patch.location_observed_at).getTime() === new Date(existing.location_observed_at).getTime()
      ));
    if (unchanged && existing.updated_by === ctx.actorId) return existing;
    const { data, error } = await ctx.supabase.from('current_trip_state').update(patch)
      .eq('trip_id', input.trip_id).select('*').single();
    fail(error, 'updateCurrentTripState update');
    return data;
  }

  const { data, error } = await ctx.supabase.from('current_trip_state').insert({
    trip_id: input.trip_id,
    running_late_minutes: 0,
    state: {},
    ...patch
  }).select('*').single();
  fail(error, 'updateCurrentTripState insert');
  return data;
}

export async function getNearbySavedPlaces(ctx, input) {
  await tripAccess(ctx, input.trip_id, false);
  let latitude = input.latitude;
  let longitude = input.longitude;
  let source = 'provided';
  let sourceLocation = null;
  if (input.use_current_location) {
    const { data, error } = await ctx.supabase.from('current_trip_state').select('last_location, location_observed_at')
      .eq('trip_id', input.trip_id).maybeSingle();
    fail(error, 'getNearbySavedPlaces current state');
    const point = parsePoint(data?.last_location);
    if (!point) throw new Error('Current trip location is missing; provide latitude and longitude.');
    ({ latitude, longitude } = point);
    source = 'current_trip_state';
    sourceLocation = locationView(data, new Date(), ctx.locationFreshnessMinutes ?? 30);
  }
  if (latitude === undefined || longitude === undefined) {
    throw new Error('Provide latitude and longitude, or set use_current_location to true.');
  }
  const { data: rows, error: nearbyError } = await ctx.supabase.rpc('nearby_trip_places', {
    p_trip_id: input.trip_id,
    p_latitude: latitude,
    p_longitude: longitude,
    p_radius_meters: input.radius_meters ?? 1500,
    p_category: input.category ?? null,
    p_statuses: input.statuses ?? null,
    p_limit: input.limit ?? 25
  });
  fail(nearbyError, 'getNearbySavedPlaces');
  const placeIds = (rows ?? []).map((row) => row.place_id);
  const origin = {
    latitude,
    longitude,
    source,
    ...(sourceLocation ? { location_status: sourceLocation.status, observed_at: sourceLocation.observed_at } : {})
  };
  if (!placeIds.length) return { origin, radius_meters: input.radius_meters ?? 1500, distance_kind: 'geographic', places: [] };
  const results = await Promise.all([
    ctx.supabase.from('itinerary_items').select('id, place_id, status').eq('trip_id', input.trip_id).in('place_id', placeIds),
    ctx.supabase.from('place_visits').select('*').eq('trip_id', input.trip_id).in('place_id', placeIds),
    ctx.supabase.from('recommendations').select('*').eq('trip_id', input.trip_id).in('place_id', placeIds),
    ctx.supabase.from('research_items').select('*').eq('trip_id', input.trip_id).in('place_id', placeIds)
  ]);
  for (const result of results) fail(result.error, 'getNearbySavedPlaces context');
  const now = new Date();
  return {
    origin,
    radius_meters: input.radius_meters ?? 1500,
    distance_kind: 'geographic',
    places: (rows ?? []).map((row) => ({
      place: {
        id: row.place_id,
        name: row.name,
        category: row.category,
        address: row.address,
        locality: row.locality,
        region: row.region,
        country_code: row.country_code
      },
      distance_meters: Math.round(Number(row.distance_meters)),
      trip_status: row.trip_status,
      priority: row.priority,
      scheduled: (results[0].data ?? []).some((item) => item.place_id === row.place_id && !['cancelled', 'skipped'].includes(item.status)),
      visited: (results[1].data ?? []).some((visit) => visit.place_id === row.place_id),
      recommendation: (results[2].data ?? []).find((recommendation) => recommendation.place_id === row.place_id) ?? null,
      research_freshness: researchFreshness((results[3].data ?? []).filter((research) => research.place_id === row.place_id), now)
    }))
  };
}

export async function getPlanOverview(ctx, tripId, atTime = new Date()) {
  const trip = await loadTrip(ctx, tripId);
  const results = await Promise.all([
    ctx.supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('planned_start', { ascending: true }),
    ctx.supabase.from('reservations').select('*').eq('trip_id', tripId),
    ctx.supabase.from('trip_places').select('*, places(*)').eq('trip_id', tripId),
    ctx.supabase.from('research_items').select('*').eq('trip_id', tripId)
  ]);
  for (const result of results) fail(result.error, 'getPlanOverview');
  const items = results[0].data ?? [];
  const reservations = results[1].data ?? [];
  const tripPlaces = results[2].data ?? [];
  const research = results[3].data ?? [];
  const issues = overlapIssues(items, trip.timezone);
  for (const item of activeScheduledItems(items)) {
    if (['planned', 'confirmed'].includes(item.status) && !item.planned_start) {
      issues.push({
        id: stableIssueId('missing_start', [item.id]), type: 'missing_start', severity: 'warning',
        title: 'Planned item has no start time', detail: `${item.title} is not placed on a day.`, date: null, item_ids: [item.id]
      });
    }
  }
  const scheduledPlaceIds = new Set(activeScheduledItems(items).filter((item) => item.place_id).map((item) => item.place_id));
  const unscheduledPlaces = tripPlaces.filter((link) => link.status === 'shortlist' && !scheduledPlaceIds.has(link.place_id));
  for (const link of unscheduledPlaces.filter((place) => place.priority === 5)) {
    issues.push({
      id: stableIssueId('high_priority_unscheduled', [link.place_id]), type: 'high_priority_unscheduled', severity: 'warning',
      title: 'High-priority saved place is unscheduled', detail: `${link.places?.name ?? 'Saved place'} is not on the itinerary.`,
      date: null, item_ids: [], place_ids: [link.place_id]
    });
  }
  for (const placeId of scheduledPlaceIds) {
    const placeResearch = research.filter((entry) => entry.place_id === placeId);
    if (placeResearch.some((entry) => entry.volatility === 'volatile') && researchFreshness(placeResearch, validInstant(atTime, 'at_time')) === 'stale') {
      const itemIds = items.filter((item) => item.place_id === placeId).map((item) => item.id);
      issues.push({
        id: stableIssueId('stale_volatile_research', itemIds), type: 'stale_volatile_research', severity: 'warning',
        title: 'Planned place has stale volatile research', detail: 'Time-sensitive research should be refreshed before relying on it.',
        date: null, item_ids: itemIds, place_ids: [placeId]
      });
    }
  }
  const configuredBuffer = Number(trip.metadata?.minimum_buffer_minutes);
  if (Number.isFinite(configuredBuffer) && configuredBuffer > 0) {
    const timed = sortedTimeline(activeScheduledItems(items)).filter((item) => item.planned_start && item.planned_end);
    for (let index = 0; index < timed.length - 1; index += 1) {
      const gap = (new Date(timed[index + 1].planned_start) - new Date(timed[index].planned_end)) / 60_000;
      if (gap >= 0 && gap < configuredBuffer) {
        const date = localDateTime(timed[index].planned_start, trip.timezone).date;
        issues.push({
          id: stableIssueId('insufficient_buffer', [timed[index].id, timed[index + 1].id], date),
          type: 'insufficient_buffer', severity: 'warning', title: 'Configured schedule buffer is too short',
          detail: `${Math.round(gap)} minutes is below the configured ${configuredBuffer}-minute minimum.`,
          date, item_ids: [timed[index].id, timed[index + 1].id]
        });
      }
    }
  }
  const itemDates = items.filter((item) => item.planned_start).map((item) => localDateTime(item.planned_start, trip.timezone).date);
  const dates = dateRange(trip.start_date, trip.end_date);
  for (const date of itemDates) if (!dates.includes(date)) dates.push(date);
  dates.sort();
  const placeById = new Map(tripPlaces.map((link) => [link.place_id, link.places]));
  const days = dates.map((date) => {
    const dayItems = items.filter((item) => item.planned_start && localDateTime(item.planned_start, trip.timezone).date === date);
    const areas = [...new Set(dayItems.map((item) => placeById.get(item.place_id)?.locality ?? placeById.get(item.place_id)?.region).filter(Boolean))];
    const fixedReservations = reservations.filter((reservation) => reservation.reserved_start && localDateTime(reservation.reserved_start, trip.timezone).date === date);
    return {
      date,
      area: areas.length ? areas.join(' / ') : null,
      items: sortedTimeline(dayItems),
      fixed_anchors: [...dayItems.filter((item) => item.flexibility === 'fixed'), ...fixedReservations],
      issue_count: issues.filter((issue) => issue.date === date || issue.item_ids?.some((id) => dayItems.some((item) => item.id === id))).length
    };
  });
  return {
    trip: { id: trip.id, title: trip.title, timezone: trip.timezone, status: trip.status, start_date: trip.start_date, end_date: trip.end_date },
    total_days: dates.length,
    scheduled_count: activeScheduledItems(items).length,
    days,
    issues,
    unscheduled_places: unscheduledPlaces
  };
}

export async function getPlacesOverview(ctx, input, atTime = new Date()) {
  const trip = await loadTrip(ctx, input.trip_id, false);
  const results = await Promise.all([
    ctx.supabase.from('trip_places').select('*, places(*)').eq('trip_id', input.trip_id),
    ctx.supabase.from('itinerary_items').select('*').eq('trip_id', input.trip_id),
    ctx.supabase.from('place_visits').select('*').eq('trip_id', input.trip_id),
    ctx.supabase.from('recommendations').select('*').eq('trip_id', input.trip_id),
    ctx.supabase.from('research_items').select('*').eq('trip_id', input.trip_id)
  ]);
  for (const result of results) fail(result.error, 'getPlacesOverview');
  let links = results[0].data ?? [];
  if (input.statuses?.length) links = links.filter((link) => input.statuses.includes(link.status));
  if (input.category) links = links.filter((link) => link.places?.category === input.category);
  const now = validInstant(atTime, 'at_time');
  let places = links.map((link) => {
    const itinerary = (results[1].data ?? []).filter((item) => item.place_id === link.place_id && !['cancelled', 'skipped'].includes(item.status));
    const visits = (results[2].data ?? []).filter((visit) => visit.place_id === link.place_id);
    const recommendations = (results[3].data ?? []).filter((recommendation) => recommendation.place_id === link.place_id);
    const research = (results[4].data ?? []).filter((entry) => entry.place_id === link.place_id);
    const latestResearch = [...research].sort((a, b) => new Date(b.valid_as_of) - new Date(a.valid_as_of))[0] ?? null;
    const latestVisit = [...visits].sort((a, b) => new Date(b.arrived_at ?? b.created_at) - new Date(a.arrived_at ?? a.created_at))[0] ?? null;
    const recommendation = [...recommendations].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ?? null;
    return {
      place: link.places,
      trip_status: link.status,
      priority: link.priority,
      note: link.note,
      researched: research.length > 0,
      research_count: research.length,
      latest_research: latestResearch,
      research_freshness: researchFreshness(research, now),
      scheduled: itinerary.length > 0,
      itinerary_item_ids: itinerary.map((item) => item.id),
      itinerary_dates: [...new Set(itinerary.filter((item) => item.planned_start).map(
        (item) => localDateTime(item.planned_start, trip.timezone).date
      ))],
      visited: visits.length > 0,
      visit: latestVisit,
      recommendation
    };
  });
  if (input.researched !== undefined) places = places.filter((place) => place.researched === input.researched);
  if (input.scheduled !== undefined) places = places.filter((place) => place.scheduled === input.scheduled);
  if (input.visited !== undefined) places = places.filter((place) => place.visited === input.visited);
  return { places: places.slice(0, input.limit ?? 100) };
}

export async function getRecentJournal(ctx, input) {
  await tripAccess(ctx, input.trip_id, false);
  let query = ctx.supabase.from('journal_entries').select('*, places(*), itinerary_items(*)')
    .eq('trip_id', input.trip_id).order('captured_at', { ascending: false }).limit(input.limit ?? 25);
  if (input.since) query = query.gte('captured_at', input.since);
  if (input.visibility) query = query.eq('visibility', input.visibility);
  const { data, error } = await query;
  fail(error, 'getRecentJournal');
  return {
    entries: (data ?? []).filter(
      (entry) => entry.author_id === ctx.actorId || entry.visibility !== 'private'
    )
  };
}

export async function getRecommendations(ctx, input) {
  await tripAccess(ctx, input.trip_id, false);
  const results = await Promise.all([
    ctx.supabase.from('recommendations').select('*, places(*)').eq('trip_id', input.trip_id),
    ctx.supabase.from('place_visits').select('*').eq('trip_id', input.trip_id),
    ctx.supabase.from('research_items').select('*, research_sources(*)').eq('trip_id', input.trip_id)
  ]);
  for (const result of results) fail(result.error, 'getRecommendations');
  let recommendations = results[0].data ?? [];
  if (input.provenance?.length) recommendations = recommendations.filter((row) => input.provenance.includes(row.provenance));
  const levels = input.levels?.length ? input.levels : (input.level ? [input.level] : null);
  if (levels) recommendations = recommendations.filter((row) => levels.includes(row.level));
  if (input.place_id) recommendations = recommendations.filter((row) => row.place_id === input.place_id);
  if (input.category) recommendations = recommendations.filter((row) => row.places?.category === input.category);
  if (input.shareable_only) recommendations = recommendations.filter((row) => Boolean(row.shareable_note));
  return {
    recommendations: recommendations.slice(0, input.limit ?? 100).map((recommendation) => {
      const visit = ['firsthand', 'mixed'].includes(recommendation.provenance)
        ? (results[1].data ?? []).find((entry) => entry.place_id === recommendation.place_id) ?? null
        : null;
      return {
        recommendation: Object.fromEntries(Object.entries(recommendation).filter(([key]) => key !== 'places')),
        place: recommendation.places,
        visit,
        research: (results[2].data ?? []).filter((entry) => entry.place_id === recommendation.place_id)
      };
    })
  };
}

export async function getTripLessons(ctx, input) {
  await tripAccess(ctx, input.trip_id, false);
  let query = ctx.supabase.from('memories').select('*').eq('owner_id', ctx.actorId);
  query = input.include_global_preferences
    ? query.or(`trip_id.eq.${input.trip_id},trip_id.is.null`)
    : query.eq('trip_id', input.trip_id);
  const { data, error } = await query;
  fail(error, 'getTripLessons');
  const memories = data ?? [];
  return {
    lessons: memories.filter((memory) => memory.memory_type === 'trip_lesson' && memory.trip_id === input.trip_id),
    preferences: memories.filter((memory) => memory.memory_type === 'preference')
  };
}

const PROPOSAL_UPDATE_FIELDS = new Set(['planned_start', 'planned_end', 'status', 'flexibility', 'priority', 'notes']);

function validatePlannedRange(start, end, context) {
  if (start != null) validInstant(start, `${context}.planned_start`);
  if (end != null) validInstant(end, `${context}.planned_end`);
  if (start != null && end != null && new Date(end) < new Date(start)) {
    throw new Error(`${context} planned_end must not be before planned_start.`);
  }
}

export async function proposeItineraryChange(ctx, input) {
  const trip = await loadTrip(ctx, input.trip_id, true);
  const { data: currentItems, error: itemError } = await ctx.supabase.from('itinerary_items').select('*').eq('trip_id', input.trip_id);
  fail(itemError, 'proposeItineraryChange items');
  const itemById = new Map((currentItems ?? []).map((item) => [item.id, item]));
  const referencedPlaceIds = new Set();
  const enriched = input.operations.map((operation, index) => {
    if (operation.op === 'update') {
      const item = itemById.get(operation.itinerary_item_id);
      if (!item) throw new Error(`operations[${index}] references an itinerary item outside this trip.`);
      for (const key of Object.keys(operation.patch)) {
        if (!PROPOSAL_UPDATE_FIELDS.has(key)) throw new Error(`operations[${index}].patch.${key} is not allowed.`);
      }
      // Resolve the clock before validating and storing: the proposal is what commit replays,
      // and the diff the traveller approves has to show the instants they will actually get.
      const patch = zonedInstants(operation.patch, ['planned_start', 'planned_end'], item.timezone ?? trip.timezone);
      validatePlannedRange(
        patch.planned_start !== undefined ? patch.planned_start : item.planned_start,
        patch.planned_end !== undefined ? patch.planned_end : item.planned_end,
        `operations[${index}]`
      );
      return { ...operation, patch, expected_updated_at: item.updated_at };
    }
    if (operation.op === 'remove') {
      const item = itemById.get(operation.itinerary_item_id);
      if (!item) throw new Error(`operations[${index}] references an itinerary item outside this trip.`);
      const reasons = livedItemReasons(item);
      if (reasons.length) {
        throw new Error(`operations[${index}] removes an itinerary item with recorded history (${reasons.join(', ')}); cancel or skip it instead.`);
      }
      return { ...operation, expected_updated_at: item.updated_at };
    }
    const proposed = zonedInstants(operation.item, ['planned_start', 'planned_end'], operation.item.timezone ?? trip.timezone);
    validatePlannedRange(proposed.planned_start ?? null, proposed.planned_end ?? null, `operations[${index}]`);
    if (proposed.place_id) referencedPlaceIds.add(proposed.place_id);
    return { ...operation, item: { ...proposed, id: randomUUID() } };
  });
  if (referencedPlaceIds.size) {
    const { data: links, error } = await ctx.supabase.from('trip_places').select('place_id')
      .eq('trip_id', input.trip_id).in('place_id', [...referencedPlaceIds]);
    fail(error, 'proposeItineraryChange places');
    const linked = new Set((links ?? []).map((row) => row.place_id));
    const missing = [...referencedPlaceIds].filter((id) => !linked.has(id));
    if (missing.length) throw new Error(`Proposal references place(s) not saved to this trip: ${missing.join(', ')}.`);
  }
  const projected = (currentItems ?? []).map((item) => ({ ...item }));
  const diff = [];
  for (const operation of enriched) {
    if (operation.op === 'update') {
      const index = projected.findIndex((item) => item.id === operation.itinerary_item_id);
      const before = projected[index];
      projected[index] = { ...before, ...operation.patch };
      diff.push({ op: 'update', itinerary_item_id: before.id, title: before.title, before: operation.patch && Object.fromEntries(Object.keys(operation.patch).map((key) => [key, before[key]])), after: operation.patch });
    } else if (operation.op === 'remove') {
      const index = projected.findIndex((item) => item.id === operation.itinerary_item_id);
      const [before] = projected.splice(index, 1);
      diff.push({
        op: 'remove',
        itinerary_item_id: before.id,
        title: before.title,
        before: { planned_start: before.planned_start, planned_end: before.planned_end, status: before.status },
        after: null
      });
    } else {
      projected.push({ trip_id: input.trip_id, status: 'planned', flexibility: 'flexible', priority: 3, ...operation.item });
      diff.push({ op: 'add', itinerary_item_id: operation.item.id, after: operation.item });
    }
  }
  const conflicts = overlapIssues(projected, trip.timezone);
  const validation = { valid: true, warnings: conflicts.map((issue) => issue.title), conflicts };
  const expiresAt = new Date(Date.now() + (input.expires_in_minutes ?? 60) * 60_000).toISOString();
  const { data: proposal, error } = await ctx.supabase.from('itinerary_change_proposals').insert({
    trip_id: input.trip_id,
    created_by: ctx.actorId,
    status: 'pending',
    summary: input.summary,
    rationale: input.rationale ?? null,
    operations: enriched,
    validation,
    expires_at: expiresAt
  }).select('*').single();
  fail(error, 'proposeItineraryChange');
  return { proposal, diff };
}

/**
 * Rebuild the `trip_places` + joined `places` shape the other read models return, from the flat
 * rows `trip_offline_places` hands back. Same shape as `getTrip`, with the point the geography
 * column cannot express over PostgREST.
 */
function offlinePlaceRow(row) {
  return {
    trip_id: row.trip_id,
    place_id: row.place_id,
    status: row.status,
    priority: row.priority,
    note: row.note,
    first_researched_at: row.first_researched_at,
    last_researched_at: row.last_researched_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    places: {
      id: row.place_id,
      name: row.place_name,
      normalized_name: row.normalized_name,
      category: row.category,
      address: row.address,
      locality: row.locality,
      region: row.region,
      country_code: row.country_code,
      latitude: row.latitude,
      longitude: row.longitude,
      external_ids: row.external_ids,
      metadata: row.place_metadata,
      created_at: row.place_created_at,
      updated_at: row.place_updated_at
    }
  };
}

/**
 * The most recent `updated_at` across everything in the snapshot, plus a row count. A companion
 * comparing two snapshots can skip rewriting its store when this is unchanged; it is a cache
 * validator, not a version number, and nothing branches on it server-side.
 */
function snapshotEtag(collections) {
  let latest = '';
  let rows = 0;
  for (const collection of collections) {
    for (const row of collection) {
      rows += 1;
      for (const stamp of [row.updated_at, row.created_at, row.captured_at]) {
        if (typeof stamp === 'string' && stamp > latest) latest = stamp;
      }
    }
  }
  return `${rows}-${latest || 'empty'}`;
}

/**
 * One trip, whole, in a single round trip — the offline companion's entire read protocol.
 *
 * On a connection that drops halfway through a Guangzhou metro tunnel, one request that either
 * lands or does not is worth more than seven that each might. This is `getTrip` plus the three
 * things a cached copy needs and that call cannot give: real coordinates, the traveller's stored
 * lessons and preferences, and the live-state row. It stays a read model — no derived day
 * grouping, no now/next — because the phone recomputes those from these rows as its clock moves,
 * and a cached "today" is wrong by morning.
 */
export async function getOfflineSnapshot(ctx, tripId, atTime = new Date()) {
  const trip = await loadTrip(ctx, tripId);
  const queries = await Promise.all([
    ctx.supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('planned_start', { ascending: true }),
    ctx.supabase.from('reservations').select('*').eq('trip_id', tripId).order('reserved_start', { ascending: true }),
    ctx.supabase.rpc('trip_offline_places', { p_trip_id: tripId }),
    ctx.supabase.from('place_visits').select('*').eq('trip_id', tripId),
    ctx.supabase.from('journal_entries').select('*').eq('trip_id', tripId).order('captured_at', { ascending: false }),
    ctx.supabase.from('research_items').select('*, research_sources(*)').eq('trip_id', tripId),
    ctx.supabase.from('recommendations').select('*').eq('trip_id', tripId),
    ctx.supabase.from('memories').select('*').eq('owner_id', ctx.actorId).or(`trip_id.eq.${tripId},trip_id.is.null`),
    ctx.supabase.from('current_trip_state').select('*').eq('trip_id', tripId).maybeSingle()
  ]);
  for (const result of queries) fail(result.error, 'getOfflineSnapshot');

  const itinerary = queries[0].data ?? [];
  const reservations = queries[1].data ?? [];
  const places = (queries[2].data ?? []).map(offlinePlaceRow);
  const visits = queries[3].data ?? [];
  // Same visibility rule as getTrip: another member's private notes are not the caller's to cache.
  const journal = (queries[4].data ?? []).filter(
    (entry) => entry.author_id === ctx.actorId || entry.visibility !== 'private'
  );
  const research = queries[5].data ?? [];
  const recommendations = queries[6].data ?? [];
  const memories = queries[7].data ?? [];
  const currentState = queries[8].data ?? null;
  const instant = validInstant(atTime, 'at_time');

  return {
    trip,
    itinerary,
    reservations,
    places,
    visits,
    journal,
    research,
    recommendations,
    lessons: memories.filter((memory) => memory.memory_type === 'trip_lesson' && memory.trip_id === tripId),
    preferences: memories.filter((memory) => memory.memory_type === 'preference'),
    current_state: currentState,
    location: locationView(currentState, instant, ctx.locationFreshnessMinutes ?? 30),
    // The phone renders every time in the trip's zone, so it needs to know how far its own clock
    // has drifted before it trusts itself to say what is happening now.
    server_time: instant.toISOString(),
    snapshot_etag: snapshotEtag([
      [trip], itinerary, reservations, places, visits, journal, research, recommendations, memories
    ])
  };
}

export async function commitItineraryChange(ctx, proposalId) {
  const { data: proposal, error: proposalError } = await ctx.supabase.from('itinerary_change_proposals')
    .select('id, trip_id, status').eq('id', proposalId).single();
  fail(proposalError, 'commitItineraryChange proposal');
  await tripAccess(ctx, proposal.trip_id, true);
  const { data, error } = await ctx.supabase.rpc('commit_itinerary_change_proposal', {
    p_proposal_id: proposalId,
    p_actor_id: ctx.actorId
  });
  fail(error, 'commitItineraryChange');
  return data;
}
