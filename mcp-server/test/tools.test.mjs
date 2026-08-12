import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTools } from '../src/tools.mjs';

const expectedTools = [
  'list_trips',
  'create_trip',
  'get_trip',
  'get_trip_tasks',
  'add_trip_task',
  'update_trip_task',
  'add_place',
  'update_place',
  'add_itinerary_item',
  'update_itinerary_item',
  'remove_itinerary_item',
  'save_research_finding',
  'record_journal_note',
  'mark_place_visited',
  'remember_preference',
  'recommend_place',
  'search_travel_brain',
  'get_today',
  'get_current_context',
  'update_current_trip_state',
  'get_nearby_saved_places',
  'get_plan_overview',
  'get_places_overview',
  'get_recent_journal',
  'get_recommendations',
  'get_trip_lessons',
  'get_offline_snapshot',
  'propose_itinerary_change',
  'commit_itinerary_change'
];

test('the full Travel Brain MCP tool surface remains registered', () => {
  const names = [];
  const server = {
    registerTool(name) {
      names.push(name);
    }
  };
  registerTools(server, async () => ({}));
  assert.deepEqual(names, expectedTools);
});
