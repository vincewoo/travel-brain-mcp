import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import {
  registerTravelDashboardUi,
  TRAVEL_DASHBOARD_RESOURCE_URI
} from '../src/dashboard-ui.mjs';

test('unified dashboard launcher keeps view optional and serves one MCP App resource', async () => {
  let tool;
  let resource;
  const server = {
    registerTool(name, config, handler) {
      tool = { name, config, handler };
      return {};
    },
    registerResource(name, uri, config, handler) {
      resource = { name, uri, config, handler };
      return {};
    }
  };

  registerTravelDashboardUi(server, {
    readDashboardHtml: async () => '<!doctype html><title>Travel Brain</title>'
  });

  assert.equal(tool.name, 'show_travel_dashboard');
  assert.equal(tool.config._meta.ui.resourceUri, TRAVEL_DASHBOARD_RESOURCE_URI);
  assert.deepEqual(tool.config._meta.ui.visibility, ['model']);

  const adaptive = await tool.handler({ trip_id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(adaptive.structuredContent, {
    dashboard: { trip_id: '11111111-1111-4111-8111-111111111111' }
  });
  assert.equal('view' in adaptive.structuredContent.dashboard, false);

  const explicit = await tool.handler({ view: 'plan', date: '2026-10-14' });
  assert.deepEqual(explicit.structuredContent.dashboard, { view: 'plan', date: '2026-10-14' });

  assert.equal(resource.uri, TRAVEL_DASHBOARD_RESOURCE_URI);
  const read = await resource.handler(new URL(TRAVEL_DASHBOARD_RESOURCE_URI));
  assert.equal(read.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.match(read.contents[0].text, /Travel Brain/);
  assert.equal(read.contents[0]._meta.ui.prefersBorder, true);
});
