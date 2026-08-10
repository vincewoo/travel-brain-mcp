import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createStaticTokenVerifier, createSupabaseTokenVerifier } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDbContext } from '../src/db.mjs';

const actorId = '11111111-1111-4111-8111-111111111111';
const staticToken = '0123456789abcdef0123456789abcdef';

function staticEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'static',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRAVEL_BRAIN_USER_ID: actorId,
    MCP_BEARER_TOKEN: staticToken,
    HOST: '127.0.0.1',
    PORT: '3000',
    ...overrides
  };
}

test('static configuration is validated and normalized', () => {
  const config = loadConfig(staticEnv({
    ALLOWED_HOSTS: 'example.fly.dev,custom.example',
    ALLOWED_ORIGINS: 'chatgpt.com',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test'
  }));
  assert.equal(config.authMode, 'static');
  assert.deepEqual(config.allowedHosts, ['example.fly.dev', 'custom.example']);
  assert.deepEqual(config.allowedOrigins, ['chatgpt.com']);
  assert.equal(config.supabaseOAuthIssuer, 'https://project.supabase.co/auth/v1');
  assert.equal(config.publishableKey, 'sb_publishable_test');
});

test('configuration rejects unsafe static credentials and host entries', () => {
  assert.throws(() => loadConfig(staticEnv({ MCP_BEARER_TOKEN: 'too-short' })), /at least 32 bytes/);
  assert.throws(
    () => loadConfig(staticEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_not-a-service-key' })),
    /publishable key/
  );
  assert.throws(() => loadConfig(staticEnv({ ALLOWED_HOSTS: 'https://example.fly.dev' })), /must be hostnames/);
  assert.throws(() => loadConfig(staticEnv({ ALLOWED_HOSTS: 'not a hostname' })), /invalid hostname/);
  assert.throws(() => loadConfig(staticEnv({ ALLOWED_HOSTS: '*.example.com' })), /invalid hostname/);
  assert.throws(
    () => loadConfig(staticEnv({ SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not-public' })),
    /must not be a service-role\/secret key/
  );
});

test('OAuth configuration does not require a global actor or service-role key', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    MCP_AUTH_MODE: 'supabase_oauth',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    PUBLIC_BASE_URL: 'https://travel.example.com',
    TRAVEL_BRAIN_USER_ID: '99999999-9999-4999-8999-999999999999',
    HOST: '0.0.0.0',
    PORT: '8080'
  });
  assert.equal(config.actorId, null);
  assert.equal(config.serviceRoleKey, null);
  assert.equal(config.resourceServerUrl.href, 'https://travel.example.com/mcp');
});

test('static bearer verification accepts only the configured token', async () => {
  const config = loadConfig(staticEnv());
  const verifier = createStaticTokenVerifier(config);
  const authInfo = await verifier.verifyAccessToken(staticToken);
  assert.equal(authInfo.extra.actorId, actorId);
  await assert.rejects(() => verifier.verifyAccessToken(`${staticToken}x`), /Invalid access token/);
});

test('Supabase verifier maps the verified subject and OAuth client into auth context', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'supabase_oauth',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    PUBLIC_BASE_URL: 'https://travel.example.com'
  });
  const clientFactory = () => ({
    auth: {
      getClaims: async () => ({
        data: {
          claims: {
            sub: actorId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            client_id: 'oauth-client-id',
            iss: config.supabaseOAuthIssuer,
            role: 'authenticated',
            scope: 'openid profile'
          }
        },
        error: null
      })
    }
  });
  const authInfo = await createSupabaseTokenVerifier(config, clientFactory).verifyAccessToken('verified-jwt');
  assert.equal(authInfo.clientId, 'oauth-client-id');
  assert.equal(authInfo.extra.actorId, actorId);
  assert.deepEqual(authInfo.scopes, ['openid', 'profile']);
});

test('OAuth database context is request-scoped and supplies the user JWT as its RLS access token', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'supabase_oauth',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    PUBLIC_BASE_URL: 'https://travel.example.com'
  });
  let clientArgs;
  const clientFactory = (...args) => {
    clientArgs = args;
    return { requestScoped: true };
  };
  const context = createDbContext(config, {
    token: 'user-access-token',
    clientId: 'oauth-client-id',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { actorId, authMode: 'supabase_oauth', issuer: config.supabaseOAuthIssuer }
  }, clientFactory);
  assert.equal(context.actorId, actorId);
  assert.equal(clientArgs[1], 'sb_publishable_test');
  assert.equal(await clientArgs[2].accessToken(), 'user-access-token');
  assert.equal(clientArgs[2].global, undefined);
});

test('OAuth database requests send the verified JWT instead of the publishable key as bearer auth', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_AUTH_MODE: 'supabase_oauth',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    PUBLIC_BASE_URL: 'https://travel.example.com'
  });
  let requestHeaders;
  const context = createDbContext(config, {
    token: 'user-access-token',
    clientId: 'oauth-client-id',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { actorId, authMode: 'supabase_oauth', issuer: config.supabaseOAuthIssuer }
  }, (url, key, options) => createClient(url, key, {
    ...options,
    global: {
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init.headers);
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
  }));

  const { error } = await context.supabase.from('trips').select('id');
  assert.equal(error, null);
  assert.equal(requestHeaders.get('Authorization'), 'Bearer user-access-token');
  assert.equal(requestHeaders.get('apikey'), 'sb_publishable_test');
});
