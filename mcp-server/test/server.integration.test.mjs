import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

const networkTest = process.env.TRAVEL_BRAIN_NETWORK_TESTS === '1' ? test : test.skip;

networkTest('health is public and MCP requires the configured bearer token', async (t) => {
  const token = '0123456789abcdef0123456789abcdef';
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'static',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRAVEL_BRAIN_USER_ID: '11111111-1111-4111-8111-111111111111',
    MCP_BEARER_TOKEN: token,
    HOST: '127.0.0.1',
    PORT: '3000'
  });
  const application = await createApplication(config);
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const consent = await fetch(`${baseUrl}/oauth/consent`);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await consent.text(), /Continue with Google/);

  const unconfiguredConsent = await fetch(`${baseUrl}/oauth/consent/config`);
  assert.equal(unconfiguredConsent.status, 503);

  const missing = await fetch(`${baseUrl}/mcp`);
  assert.equal(missing.status, 401);
  const invalid = await fetch(`${baseUrl}/mcp`, { headers: { authorization: 'Bearer invalid-token' } });
  assert.equal(invalid.status, 401);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'travel-brain-test', version: '1.0.0' }
      }
    })
  });
  assert.equal(initialize.status, 200);

  const toolsList = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  assert.equal(toolsList.status, 200);
  const toolsBody = await toolsList.text();
  for (const name of ['list_trips', 'get_today', 'commit_itinerary_change']) {
    assert.match(toolsBody, new RegExp(`"name":"${name}"`));
  }
});

networkTest('OAuth mode advertises protected-resource metadata and protects MCP', async (t) => {
  const actorId = '11111111-1111-4111-8111-111111111111';
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'supabase_oauth',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    PUBLIC_BASE_URL: 'https://travel.example.com',
    HOST: '127.0.0.1',
    PORT: '3000'
  });
  const oauthMetadata = {
    issuer: config.supabaseOAuthIssuer,
    authorization_endpoint: `${config.supabaseOAuthIssuer}/authorize`,
    token_endpoint: `${config.supabaseOAuthIssuer}/token`,
    registration_endpoint: `${config.supabaseOAuthIssuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256']
  };
  const application = await createApplication(config, {
    loadOAuthMetadata: async () => oauthMetadata,
    createOAuthVerifier: () => ({
      verifyAccessToken: async (token) => {
        if (token !== 'oauth-access-token') throw new Error('invalid token');
        return {
          token,
          clientId: 'oauth-client-id',
          scopes: ['openid'],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          extra: { actorId, authMode: 'supabase_oauth', issuer: config.supabaseOAuthIssuer }
        };
      }
    })
  });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).authorization_servers, [config.supabaseOAuthIssuer]);

  const consentConfig = await fetch(`${baseUrl}/oauth/consent/config`);
  assert.equal(consentConfig.status, 200);
  assert.deepEqual(await consentConfig.json(), {
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'sb_publishable_test'
  });

  const unauthorized = await fetch(`${baseUrl}/mcp`);
  assert.equal(unauthorized.status, 401);
  assert.match(
    unauthorized.headers.get('www-authenticate'),
    /resource_metadata="https:\/\/travel\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/
  );

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer oauth-access-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'travel-brain-oauth-test', version: '1.0.0' }
      }
    })
  });
  assert.equal(initialize.status, 200);
});
