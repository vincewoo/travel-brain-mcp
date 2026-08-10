import { createClient } from '@supabase/supabase-js';

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
    supabase: clientFactory(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${authInfo.token}` } }
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

export async function tripAccess(ctx, tripId, edit = false) {
  const { supabase, actorId } = ctx;
  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .select('id, owner_id')
    .eq('id', tripId)
    .maybeSingle();
  fail(tripError, 'tripAccess trip');
  if (!trip) throw new Error('Trip not found.');
  if (trip.owner_id === actorId) return { role: 'owner' };

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
  return membership;
}

async function itemTripId(ctx, itemId) {
  const { supabase } = ctx;
  const { data, error } = await supabase
    .from('itinerary_items')
    .select('trip_id')
    .eq('id', itemId)
    .single();
  fail(error, 'itemTripId');
  return data.trip_id;
}

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
    journal: queries[5].data ?? [],
    research: queries[6].data ?? [],
    recommendations: queries[7].data ?? []
  };
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
    metadata: input.metadata ?? {}
  };
  if (input.latitude != null && input.longitude != null) {
    record.location = `POINT(${input.longitude} ${input.latitude})`;
  }

  const { data: place, error } = await supabase.from('places').insert(record).select('*').single();
  fail(error, 'addPlace');

  if (input.trip_id) {
    const { error: linkError } = await supabase.from('trip_places').upsert({
      trip_id: input.trip_id,
      place_id: place.id,
      status: input.trip_status ?? 'saved'
    }, { onConflict: 'trip_id,place_id' });
    fail(linkError, 'addPlace trip link');
  }
  return place;
}

export async function addItineraryItem(ctx, input) {
  const { supabase } = ctx;
  await tripAccess(ctx, input.trip_id, true);
  const { data, error } = await supabase
    .from('itinerary_items')
    .insert({
      trip_id: input.trip_id,
      place_id: input.place_id ?? null,
      title: input.title,
      item_type: input.item_type ?? 'activity',
      planned_start: input.planned_start ?? null,
      planned_end: input.planned_end ?? null,
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
  const tripId = await itemTripId(ctx, input.itinerary_item_id);
  await tripAccess(ctx, tripId, true);
  const allowed = ['planned_start', 'planned_end', 'actual_start', 'actual_end', 'flexibility', 'priority', 'status', 'notes'];
  const patch = Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  const { data, error } = await supabase
    .from('itinerary_items')
    .update(patch)
    .eq('id', input.itinerary_item_id)
    .select('*')
    .single();
  fail(error, 'updateItineraryItem');
  return data;
}

export async function saveResearchFinding(ctx, input) {
  const { supabase, actorId } = ctx;
  if (input.trip_id) await tripAccess(ctx, input.trip_id, true);
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
    valid_as_of: input.valid_as_of ?? new Date().toISOString(),
    expires_at: input.expires_at ?? null,
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
      retrieved_at: s.retrieved_at ?? new Date().toISOString(),
      note: s.note ?? null
    }));
    const { error: sourceError } = await supabase.from('research_sources').insert(rows);
    fail(sourceError, 'saveResearchFinding sources');
  }
  return item;
}

export async function recordJournalNote(ctx, input) {
  const { supabase, actorId } = ctx;
  await tripAccess(ctx, input.trip_id, true);
  const record = {
    trip_id: input.trip_id,
    author_id: actorId,
    itinerary_item_id: input.itinerary_item_id ?? null,
    place_id: input.place_id ?? null,
    captured_at: input.captured_at ?? new Date().toISOString(),
    raw_note: input.raw_note,
    reaction: input.reaction ?? null,
    visibility: input.visibility ?? 'private',
    metadata: input.metadata ?? {}
  };
  if (input.latitude != null && input.longitude != null) {
    record.location = `POINT(${input.longitude} ${input.latitude})`;
  }
  const { data, error } = await supabase.from('journal_entries').insert(record).select('*').single();
  fail(error, 'recordJournalNote');
  return data;
}

export async function markPlaceVisited(ctx, input) {
  const { supabase } = ctx;
  await tripAccess(ctx, input.trip_id, true);
  if (input.itinerary_item_id) {
    const itineraryTripId = await itemTripId(ctx, input.itinerary_item_id);
    if (itineraryTripId !== input.trip_id) {
      throw new Error('The itinerary item does not belong to this trip.');
    }
  }
  const { data: visit, error } = await supabase.from('place_visits').insert({
    trip_id: input.trip_id,
    place_id: input.place_id,
    itinerary_item_id: input.itinerary_item_id ?? null,
    arrived_at: input.arrived_at ?? null,
    departed_at: input.departed_at ?? null,
    rating: input.rating ?? null,
    would_return: input.would_return ?? null,
    recommendation: input.recommendation ?? 'none',
    notes: input.notes ?? null
  }).select('*').single();
  fail(error, 'markPlaceVisited');

  const { error: linkError } = await supabase.from('trip_places').upsert({
    trip_id: input.trip_id,
    place_id: input.place_id,
    status: 'visited'
  }, { onConflict: 'trip_id,place_id' });
  fail(linkError, 'markPlaceVisited trip_place');

  if (input.itinerary_item_id) {
    const patch = { status: 'completed' };
    if (input.arrived_at) patch.actual_start = input.arrived_at;
    if (input.departed_at) patch.actual_end = input.departed_at;
    const { error: itemError } = await supabase.from('itinerary_items').update(patch).eq('id', input.itinerary_item_id);
    fail(itemError, 'markPlaceVisited itinerary');
  }
  return visit;
}

export async function rememberPreference(ctx, input) {
  const { supabase, actorId } = ctx;
  if (input.trip_id) await tripAccess(ctx, input.trip_id, false);
  const { data, error } = await supabase.from('memories').insert({
    owner_id: actorId,
    trip_id: input.trip_id ?? null,
    memory_type: input.memory_type ?? 'preference',
    content: input.content,
    confidence: input.confidence ?? (input.provenance === 'inferred' ? 0.6 : 1.0),
    status: input.status ?? (input.provenance === 'inferred' ? 'candidate' : 'confirmed'),
    provenance: input.provenance ?? 'explicit',
    metadata: input.metadata ?? {},
    last_confirmed_at: (input.status === 'confirmed' || (!input.status && input.provenance !== 'inferred')) ? new Date().toISOString() : null
  }).select('*').single();
  fail(error, 'rememberPreference');
  return data;
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
