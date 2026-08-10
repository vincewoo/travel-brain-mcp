import * as z from 'zod/v4';
import {
  addItineraryItem,
  addPlace,
  createTrip,
  commitItineraryChange,
  getCurrentContext,
  getNearbySavedPlaces,
  getPlacesOverview,
  getPlanOverview,
  getRecentJournal,
  getRecommendations,
  getToday,
  getTrip,
  getTripLessons,
  listTrips,
  markPlaceVisited,
  recommendPlace,
  recordJournalNote,
  rememberPreference,
  proposeItineraryChange,
  saveResearchFinding,
  searchTravelBrain,
  updateItineraryItem,
  updateCurrentTripState
} from './db.mjs';

const textResult = (data, message = 'Done.') => ({
  structuredContent: data,
  content: [{ type: 'text', text: `${message}\n${JSON.stringify(data, null, 2)}` }]
});

function contextualTool(name, resolveRequestContext, handler) {
  return async (input, handlerContext) => {
    const startedAt = performance.now();
    try {
      const requestContext = await resolveRequestContext(handlerContext);
      const result = await handler(input, requestContext);
      console.info(`tool=${name} status=ok duration_ms=${Math.round(performance.now() - startedAt)}`);
      return result;
    } catch (error) {
      console.error(
        `tool=${name} status=error duration_ms=${Math.round(performance.now() - startedAt)} error=${error.message}`
      );
      throw error;
    }
  };
}

export function registerTools(server, resolveRequestContext) {
  if (typeof resolveRequestContext !== 'function') {
    throw new Error('registerTools requires a request-context resolver.');
  }
  const tool = (name, handler) => contextualTool(name, resolveRequestContext, handler);

  server.registerTool('list_trips', {
    title: 'List trips',
    description: 'List trips the current traveler can access.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('list_trips', async (_input, ctx) => {
    const trips = await listTrips(ctx);
    return textResult({ trips }, `Found ${trips.length} trip(s).`);
  }));

  server.registerTool('create_trip', {
    title: 'Create trip',
    description: 'Create a new trip in the Travel Brain.',
    inputSchema: z.object({
      title: z.string().min(1),
      destination_summary: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      timezone: z.string().default('UTC'),
      status: z.enum(['draft', 'planning', 'active', 'completed', 'archived']).default('planning')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('create_trip', async (input, ctx) => textResult({ trip: await createTrip(ctx, input) }, 'Trip created.')));

  server.registerTool('get_trip', {
    title: 'Get trip',
    description: 'Read authoritative trip state, including itinerary, places, visits, journal, research, and recommendations.',
    inputSchema: z.object({ trip_id: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_trip', async ({ trip_id }, ctx) => textResult(await getTrip(ctx, trip_id), 'Trip loaded.')));

  server.registerTool('add_place', {
    title: 'Add place',
    description: 'Save a place to the Travel Brain and optionally associate it with a trip.',
    inputSchema: z.object({
      trip_id: z.string().uuid().optional(),
      name: z.string().min(1),
      normalized_name: z.string().optional(),
      category: z.string().optional(),
      address: z.string().optional(),
      locality: z.string().optional(),
      region: z.string().optional(),
      country_code: z.string().max(3).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      trip_status: z.enum(['candidate', 'saved', 'planned', 'visited', 'rejected']).default('saved'),
      external_ids: z.record(z.string(), z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('add_place', async (input, ctx) => textResult({ place: await addPlace(ctx, input) }, 'Place saved.')));

  server.registerTool('add_itinerary_item', {
    title: 'Add itinerary item',
    description: 'Add a planned activity, meal, transit segment, or other item to a trip.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      place_id: z.string().uuid().optional(),
      title: z.string().min(1),
      item_type: z.string().default('activity'),
      planned_start: z.string().optional(),
      planned_end: z.string().optional(),
      timezone: z.string().optional(),
      flexibility: z.enum(['fixed', 'semi_flexible', 'flexible']).default('flexible'),
      priority: z.number().int().min(1).max(5).default(3),
      status: z.enum(['planned', 'confirmed', 'in_progress', 'completed', 'skipped', 'cancelled']).default('planned'),
      notes: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('add_itinerary_item', async (input, ctx) => textResult({ itinerary_item: await addItineraryItem(ctx, input) }, 'Itinerary item added.')));

  server.registerTool('update_itinerary_item', {
    title: 'Update itinerary item',
    description: 'Update planned or actual itinerary timing/status while preserving the planned-vs-actual distinction.',
    inputSchema: z.object({
      itinerary_item_id: z.string().uuid(),
      planned_start: z.string().optional(),
      planned_end: z.string().optional(),
      actual_start: z.string().optional(),
      actual_end: z.string().optional(),
      flexibility: z.enum(['fixed', 'semi_flexible', 'flexible']).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      status: z.enum(['planned', 'confirmed', 'in_progress', 'completed', 'skipped', 'cancelled']).optional(),
      notes: z.string().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('update_itinerary_item', async (input, ctx) => textResult({ itinerary_item: await updateItineraryItem(ctx, input) }, 'Itinerary item updated.')));

  server.registerTool('save_research_finding', {
    title: 'Save research finding',
    description: 'Store an atomic sourced travel research finding with freshness and volatility metadata.',
    inputSchema: z.object({
      trip_id: z.string().uuid().optional(),
      place_id: z.string().uuid().optional(),
      topic: z.string().min(1),
      finding: z.string().min(1),
      summary: z.string().optional(),
      volatility: z.enum(['static', 'semi_volatile', 'volatile']).default('semi_volatile'),
      confidence: z.number().min(0).max(1).default(0.8),
      valid_as_of: z.string().optional(),
      expires_at: z.string().optional(),
      sources: z.array(z.object({
        source_url: z.string().url(),
        source_title: z.string().optional(),
        publisher: z.string().optional(),
        source_kind: z.string().optional(),
        retrieved_at: z.string().optional(),
        note: z.string().optional()
      })).default([]),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('save_research_finding', async (input, ctx) => textResult({ research_item: await saveResearchFinding(ctx, input) }, 'Research saved.')));

  server.registerTool('record_journal_note', {
    title: 'Record journal note',
    description: 'Capture an on-the-fly raw travel journal note without overwriting it with generated prose.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      itinerary_item_id: z.string().uuid().optional(),
      place_id: z.string().uuid().optional(),
      captured_at: z.string().optional(),
      raw_note: z.string().min(1),
      reaction: z.string().optional(),
      visibility: z.enum(['private', 'trip', 'shareable']).default('private'),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('record_journal_note', async (input, ctx) => textResult({ journal_entry: await recordJournalNote(ctx, input) }, 'Journal note recorded.')));

  server.registerTool('mark_place_visited', {
    title: 'Mark place visited',
    description: 'Record firsthand visit facts and optionally complete the linked itinerary item.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      place_id: z.string().uuid(),
      itinerary_item_id: z.string().uuid().optional(),
      arrived_at: z.string().optional(),
      departed_at: z.string().optional(),
      rating: z.number().min(0).max(5).optional(),
      would_return: z.boolean().optional(),
      recommendation: z.enum(['none', 'mixed', 'recommend', 'strongly_recommend', 'avoid']).default('none'),
      notes: z.string().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('mark_place_visited', async (input, ctx) => textResult({ visit: await markPlaceVisited(ctx, input) }, 'Visit recorded.')));

  server.registerTool('remember_preference', {
    title: 'Remember traveler preference',
    description: 'Store semantic travel memory with confidence, provenance, and confirmation status.',
    inputSchema: z.object({
      trip_id: z.string().uuid().optional(),
      memory_type: z.string().default('preference'),
      content: z.string().min(1),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(['candidate', 'confirmed', 'rejected', 'superseded']).optional(),
      provenance: z.enum(['explicit', 'inferred', 'imported']).default('explicit'),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('remember_preference', async (input, ctx) => textResult({ memory: await rememberPreference(ctx, input) }, 'Memory stored.')));

  server.registerTool('recommend_place', {
    title: 'Recommend place',
    description: 'Store a reusable recommendation with explicit firsthand/research provenance. Firsthand requires a recorded visit.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      place_id: z.string().uuid(),
      provenance: z.enum(['firsthand', 'research', 'mixed']),
      level: z.enum(['none', 'mixed', 'recommend', 'strongly_recommend', 'avoid']).default('recommend'),
      shareable_note: z.string().optional(),
      caveats: z.string().optional(),
      best_for: z.array(z.string()).default([]),
      metadata: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, tool('recommend_place', async (input, ctx) => textResult({ recommendation: await recommendPlace(ctx, input) }, 'Recommendation stored.')));

  server.registerTool('search_travel_brain', {
    title: 'Search Travel Brain',
    description: 'Search traveler memories, research, journal notes, and recommendations. Current v0.1 retrieval is lexical; embeddings can be added later.',
    inputSchema: z.object({
      query: z.string().min(1),
      trip_id: z.string().uuid().optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('search_travel_brain', async ({ query, trip_id }, ctx) => textResult(
    await searchTravelBrain(ctx, query, trip_id ?? null),
    'Travel Brain search complete.'
  )));

  server.registerTool('get_today', {
    title: 'Get today',
    description: 'Read one authoritative local trip day with timeline, reservations, visits, fixed anchors, and schedule alerts.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_today', async ({ trip_id, date }, ctx) => textResult(
    await getToday(ctx, trip_id, date ?? null),
    'Trip day loaded.'
  )));

  server.registerTool('get_current_context', {
    title: 'Get current trip context',
    description: 'Read compact live concierge context, explicitly qualifying the latest location as fresh, stale, or missing.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      at_time: z.string().optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_current_context', async ({ trip_id, at_time }, ctx) => textResult(
    await getCurrentContext(ctx, trip_id, at_time ?? new Date()),
    'Current trip context loaded.'
  )));

  server.registerTool('update_current_trip_state', {
    title: 'Update current trip state',
    description: 'Update ephemeral live-trip state. Location replaces the latest point and does not create passive location history.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      current_itinerary_item_id: z.string().uuid().nullable().optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      location_observed_at: z.string().optional(),
      running_late_minutes: z.number().int().min(0).max(1440).optional(),
      state: z.record(z.string(), z.unknown()).optional()
    }).refine((input) => (input.latitude === undefined) === (input.longitude === undefined), {
      message: 'latitude and longitude must be supplied together.'
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, tool('update_current_trip_state', async (input, ctx) => textResult(
    { current_state: await updateCurrentTripState(ctx, input) },
    'Current trip state updated.'
  )));

  server.registerTool('get_nearby_saved_places', {
    title: 'Get nearby saved places',
    description: 'Find geocoded Travel Brain places within a geographic radius. Distances are straight-line geography distances, not routing times.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      use_current_location: z.boolean().default(false),
      radius_meters: z.number().positive().max(100000).default(1500),
      category: z.string().optional(),
      statuses: z.array(z.enum(['candidate', 'saved', 'planned', 'visited', 'rejected'])).optional(),
      limit: z.number().int().min(1).max(25).default(10)
    }).superRefine((input, context) => {
      if ((input.latitude === undefined) !== (input.longitude === undefined)) {
        context.addIssue({ code: 'custom', message: 'latitude and longitude must be supplied together.' });
      }
      if (!input.use_current_location && input.latitude === undefined) {
        context.addIssue({ code: 'custom', message: 'Provide coordinates or use_current_location.' });
      }
      if (input.use_current_location && input.latitude !== undefined) {
        context.addIssue({ code: 'custom', message: 'Choose current location or explicit coordinates, not both.' });
      }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_nearby_saved_places', async (input, ctx) => textResult(
    await getNearbySavedPlaces(ctx, input),
    'Nearby saved places loaded.'
  )));

  server.registerTool('get_plan_overview', {
    title: 'Get plan overview',
    description: 'Read day-grouped itinerary state, deterministic planning issues, and unscheduled saved places.',
    inputSchema: z.object({ trip_id: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_plan_overview', async ({ trip_id }, ctx) => textResult(
    await getPlanOverview(ctx, trip_id),
    'Plan overview loaded.'
  )));

  server.registerTool('get_places_overview', {
    title: 'Get places overview',
    description: 'Read canonical trip-place state joined with research, schedule, visit, and recommendation evidence.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      statuses: z.array(z.enum(['candidate', 'saved', 'planned', 'visited', 'rejected'])).optional(),
      category: z.string().optional(),
      researched: z.boolean().optional(),
      scheduled: z.boolean().optional(),
      visited: z.boolean().optional(),
      limit: z.number().int().min(1).max(250).default(100)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_places_overview', async (input, ctx) => textResult(
    await getPlacesOverview(ctx, input),
    'Places overview loaded.'
  )));

  server.registerTool('get_recent_journal', {
    title: 'Get recent journal',
    description: 'Read authorized recent journal entries with raw traveler notes preserved unchanged.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(25),
      since: z.string().optional(),
      visibility: z.enum(['private', 'trip', 'shareable']).optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_recent_journal', async (input, ctx) => textResult(
    await getRecentJournal(ctx, input),
    'Recent journal loaded.'
  )));

  server.registerTool('get_recommendations', {
    title: 'Get recommendations',
    description: 'Read stored recommendations with explicit provenance and supporting visit or research evidence; private journal text is excluded.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      provenance: z.array(z.enum(['firsthand', 'research', 'mixed'])).optional(),
      level: z.enum(['none', 'mixed', 'recommend', 'strongly_recommend', 'avoid']).optional(),
      levels: z.array(z.enum(['none', 'mixed', 'recommend', 'strongly_recommend', 'avoid'])).optional(),
      place_id: z.string().uuid().optional(),
      category: z.string().optional(),
      shareable_only: z.boolean().default(false),
      limit: z.number().int().min(1).max(250).default(100)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_recommendations', async (input, ctx) => textResult(
    await getRecommendations(ctx, input),
    'Recommendations loaded.'
  )));

  server.registerTool('get_trip_lessons', {
    title: 'Get trip lessons',
    description: 'Read stored trip lessons and preferences with their original confidence, status, and provenance.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      include_global_preferences: z.boolean().default(true)
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, tool('get_trip_lessons', async (input, ctx) => textResult(
    await getTripLessons(ctx, input),
    'Stored trip lessons loaded.'
  )));

  const proposalUpdate = z.object({
    op: z.literal('update'),
    itinerary_item_id: z.string().uuid(),
    patch: z.object({
      planned_start: z.string().optional(),
      planned_end: z.string().optional(),
      status: z.enum(['planned', 'confirmed', 'skipped', 'cancelled']).optional(),
      flexibility: z.enum(['fixed', 'semi_flexible', 'flexible']).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      notes: z.string().nullable().optional()
    }).refine((patch) => Object.keys(patch).length > 0, { message: 'Update patch must not be empty.' })
  });
  const proposalAdd = z.object({
    op: z.literal('add'),
    item: z.object({
      title: z.string().min(1),
      place_id: z.string().uuid().optional(),
      item_type: z.string().default('activity'),
      planned_start: z.string().optional(),
      planned_end: z.string().optional(),
      timezone: z.string().optional(),
      flexibility: z.enum(['fixed', 'semi_flexible', 'flexible']).default('flexible'),
      priority: z.number().int().min(1).max(5).default(3),
      status: z.enum(['planned', 'confirmed']).default('planned'),
      notes: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    })
  });

  server.registerTool('propose_itinerary_change', {
    title: 'Propose itinerary change',
    description: 'Store a reviewable itinerary diff without changing authoritative itinerary rows.',
    inputSchema: z.object({
      trip_id: z.string().uuid(),
      summary: z.string().min(1),
      rationale: z.string().optional(),
      expires_in_minutes: z.number().int().min(1).max(1440).default(60),
      operations: z.array(z.discriminatedUnion('op', [proposalUpdate, proposalAdd])).min(1).max(50)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, tool('propose_itinerary_change', async (input, ctx) => textResult(
    await proposeItineraryChange(ctx, input),
    'Itinerary change proposed; authoritative itinerary is unchanged.'
  )));

  server.registerTool('commit_itinerary_change', {
    title: 'Commit itinerary change',
    description: 'Atomically commit an approved pending proposal. This can move or cancel authoritative itinerary items.',
    inputSchema: z.object({ proposal_id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, tool('commit_itinerary_change', async ({ proposal_id }, ctx) => textResult(
    await commitItineraryChange(ctx, proposal_id),
    'Itinerary proposal commit processed.'
  )));
}
