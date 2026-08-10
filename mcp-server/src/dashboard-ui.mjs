import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';

export const TRAVEL_DASHBOARD_RESOURCE_URI = 'ui://travel-brain/dashboard.html';

const REPOSITORY_HTML_PATH = fileURLToPath(
  new URL('../ui/travel-dashboard/dist/mcp-app.html', import.meta.url)
);
const BUNDLED_HTML_PATH = fileURLToPath(
  new URL('../dashboard/mcp-app.html', import.meta.url)
);

async function readDashboardHtml(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [BUNDLED_HTML_PATH, REPOSITORY_HTML_PATH];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    `Travel dashboard build is missing. Expected ${candidates.join(' or ')}.`,
    { cause: lastError }
  );
}

function dashboardPayload(input) {
  return {
    dashboard: Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    )
  };
}

/**
 * Register the single unified Travel Brain MCP App on the existing server.
 * The MCP transport remains the authentication boundary; the UI calls the
 * existing Step 4 tools through its host and owns no credentials or data store.
 */
export function registerTravelDashboardUi(server, options = {}) {
  const loadHtml = options.readDashboardHtml ?? (() => readDashboardHtml(options.htmlPath));

  registerAppTool(
    server,
    'show_travel_dashboard',
    {
      title: 'Show Travel Brain Dashboard',
      description:
        'Open the unified Travel Brain dashboard across Today, Plan, Places, Journal, and Recommendations. ' +
        'Use for a visual trip workspace, itinerary, saved places, journal, or recommendation view.',
      inputSchema: z.object({
        trip_id: z.string().uuid().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        view: z.enum(['today', 'plan', 'places', 'journal', 'recommendations']).optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      },
      _meta: {
        ui: {
          resourceUri: TRAVEL_DASHBOARD_RESOURCE_URI,
          visibility: ['model']
        }
      }
    },
    async (input) => {
      const payload = dashboardPayload(input);
      return {
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload) }]
      };
    }
  );

  registerAppResource(
    server,
    'Travel Brain Dashboard',
    TRAVEL_DASHBOARD_RESOURCE_URI,
    {
      description: 'Unified trip lifecycle dashboard for Travel Brain.',
      _meta: { ui: { prefersBorder: true } }
    },
    async () => {
      const html = await loadHtml();
      return {
        contents: [{
          uri: TRAVEL_DASHBOARD_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { prefersBorder: true } }
        }]
      };
    }
  );
}
