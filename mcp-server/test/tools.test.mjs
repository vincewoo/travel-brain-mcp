import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTools } from '../src/tools.mjs';

const expectedTools = [
  'list_trips',
  'create_trip',
  'get_trip',
  'add_place',
  'add_itinerary_item',
  'update_itinerary_item',
  'save_research_finding',
  'record_journal_note',
  'mark_place_visited',
  'remember_preference',
  'recommend_place',
  'search_travel_brain'
];

test('all 12 compatible MCP tool names remain registered', () => {
  const names = [];
  const server = {
    registerTool(name) {
      names.push(name);
    }
  };
  registerTools(server, async () => ({}));
  assert.deepEqual(names, expectedTools);
});

