import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createClient } from '@supabase/supabase-js';

function invalidToken() {
  return new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token.');
}

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function scopesFromClaims(claims) {
  if (typeof claims.scope === 'string') return claims.scope.split(' ').filter(Boolean);
  if (Array.isArray(claims.scopes)) return claims.scopes.filter((scope) => typeof scope === 'string');
  return [];
}

export function createStaticTokenVerifier(config) {
  const expected = tokenDigest(config.bearerToken);
  return {
    async verifyAccessToken(token) {
      if (typeof token !== 'string' || !timingSafeEqual(tokenDigest(token), expected)) {
        throw invalidToken();
      }
      return {
        token,
        clientId: 'travel-brain-static',
        scopes: ['mcp'],
        expiresAt: Number.MAX_SAFE_INTEGER,
        extra: { actorId: config.actorId, authMode: 'static' }
      };
    }
  };
}

export function createSupabaseTokenVerifier(config, clientFactory = createClient) {
  const validationClient = clientFactory(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  return {
    async verifyAccessToken(token) {
      let result;
      try {
        result = await validationClient.auth.getClaims(token);
      } catch {
        throw invalidToken();
      }
      const claims = result?.data?.claims;
      if (result?.error || !claims) throw invalidToken();
      if (
        typeof claims.sub !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub) ||
        typeof claims.exp !== 'number' ||
        typeof claims.client_id !== 'string' ||
        claims.client_id.length === 0 ||
        claims.iss !== config.supabaseOAuthIssuer ||
        claims.role !== 'authenticated'
      ) {
        throw invalidToken();
      }
      return {
        token,
        clientId: claims.client_id,
        scopes: scopesFromClaims(claims),
        expiresAt: claims.exp,
        extra: {
          actorId: claims.sub,
          authMode: 'supabase_oauth',
          issuer: claims.iss
        }
      };
    }
  };
}

export async function loadSupabaseOAuthMetadata(config, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(config.supabaseOAuthDiscoveryUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new Error(`Unable to load Supabase OAuth metadata: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Unable to load Supabase OAuth metadata: HTTP ${response.status}. Is the OAuth 2.1 server enabled?`);
  }
  const metadata = await response.json();
  if (
    metadata?.issuer !== config.supabaseOAuthIssuer ||
    typeof metadata.authorization_endpoint !== 'string' ||
    typeof metadata.token_endpoint !== 'string'
  ) {
    throw new Error('Supabase OAuth metadata is incomplete or has an unexpected issuer.');
  }
  return metadata;
}
