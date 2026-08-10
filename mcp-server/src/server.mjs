import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  createStaticTokenVerifier,
  createSupabaseTokenVerifier,
  loadSupabaseOAuthMetadata
} from './auth.mjs';
import { loadConfig } from './config.mjs';
import { createDbContext, ensureProfile } from './db.mjs';
import { installOAuthConsentRoutes } from './oauth-consent.mjs';
import { registerTools } from './tools.mjs';

const SERVER_INFO = { name: 'travel-brain', version: '0.1.0' };

function createAppOptions(config) {
  const options = { host: config.host };
  if (config.allowedHosts.length > 0) options.allowedHosts = config.allowedHosts;
  if (config.allowedOrigins.length > 0) options.allowedOrigins = config.allowedOrigins;
  return options;
}

function requestLogger(req, res, next) {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const path = req.originalUrl.split('?')[0];
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    console.info(
      `request_id=${requestId} method=${req.method} path=${path} status=${res.statusCode} duration_ms=${Math.round(performance.now() - startedAt)}`
    );
  });
  next();
}

function createRequestContextResolver(config, factoryContext) {
  let contextPromise;
  return async (handlerContext) => {
    const authInfo = handlerContext?.http?.authInfo ?? factoryContext.authInfo;
    if (!authInfo) throw new Error('Authenticated MCP handler context is required.');
    if (factoryContext.authInfo && factoryContext.authInfo.token !== authInfo.token) {
      throw new Error('MCP handler authentication context mismatch.');
    }
    contextPromise ??= (async () => {
      const dbContext = createDbContext(config, authInfo);
      await ensureProfile(dbContext);
      return dbContext;
    })();
    return contextPromise;
  };
}

function createTravelBrainMcpHandler(config) {
  return createMcpHandler((factoryContext) => {
    const server = new McpServer(
      SERVER_INFO,
      {
        instructions:
          'Travel Brain is authoritative. Distinguish planned from visited, firsthand from research, and raw journal notes from generated summaries. Prefer flexible itinerary items when replanning.'
      }
    );
    registerTools(server, createRequestContextResolver(config, factoryContext));
    return server;
  });
}

export async function createApplication(config, dependencies = {}) {
  const app = createMcpExpressApp(createAppOptions(config));
  app.disable('x-powered-by');
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'travel-brain-mcp', version: SERVER_INFO.version });
  });
  installOAuthConsentRoutes(app, config);

  let resourceMetadataUrl;
  let verifier;
  if (config.authMode === 'supabase_oauth') {
    const oauthMetadata = await (dependencies.loadOAuthMetadata ?? loadSupabaseOAuthMetadata)(config);
    app.use(mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: config.resourceServerUrl,
      resourceName: 'Travel Brain MCP'
    }));
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.resourceServerUrl);
    verifier = (dependencies.createOAuthVerifier ?? createSupabaseTokenVerifier)(config);
  } else {
    verifier = (dependencies.createStaticVerifier ?? createStaticTokenVerifier)(config);
  }

  const handler = (dependencies.createHandler ?? createTravelBrainMcpHandler)(config);
  const nodeHandler = toNodeHandler(handler, {
    onerror(error) {
      console.error(`mcp_adapter_error=${error.message}`);
    }
  });
  const bearerAuth = requireBearerAuth({
    verifier,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {})
  });

  app.all('/mcp', bearerAuth, (req, res) => void nodeHandler(req, res, req.body));

  app.use((error, _req, res, _next) => {
    console.error(`http_error=${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  });

  return {
    app,
    async close() {
      await handler.close();
    }
  };
}

export async function startServer(config = loadConfig()) {
  const application = await createApplication(config);
  const httpServer = await new Promise((resolveServer, reject) => {
    const candidate = application.app.listen(config.port, config.host, () => resolveServer(candidate));
    candidate.once('error', reject);
  });
  console.info(
    `Travel Brain MCP started auth_mode=${config.authMode} host=${config.host} port=${config.port} endpoint=/mcp`
  );
  return {
    ...application,
    httpServer,
    async stop() {
      await new Promise((resolveClose, reject) => {
        httpServer.close((error) => error ? reject(error) : resolveClose());
      });
      await application.close();
    }
  };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const runtime = await startServer();
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      console.info(`shutdown signal=${signal}`);
      try {
        await runtime.stop();
        process.exitCode = 0;
      } catch (error) {
        console.error(`shutdown_error=${error.message}`);
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    console.error(`startup_error=${error.message}`);
    process.exitCode = 1;
  }
}
