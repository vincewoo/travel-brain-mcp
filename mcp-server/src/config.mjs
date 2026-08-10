const AUTH_MODES = new Set(['static', 'supabase_oauth']);
const NODE_ENVS = new Set(['development', 'test', 'production']);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseUrl(value, name, { allowPath = false, production = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (production && url.protocol !== 'https:' && !local) {
    throw new Error(`${name} must use https outside localhost in production.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, a query, or a fragment.`);
  }
  if (!allowPath && url.pathname !== '/') {
    throw new Error(`${name} must be an origin URL without a path.`);
  }
  return url;
}

function parseList(value) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseHostnameList(value, name) {
  const hostnames = parseList(value);
  for (const hostname of hostnames) {
    if (
      hostname.includes('://') ||
      hostname.includes('/') ||
      hostname.includes('?') ||
      hostname.includes('#') ||
      (/:[0-9]+$/.test(hostname) && !hostname.startsWith('['))
    ) {
      throw new Error(`${name} entries must be hostnames without schemes, paths, or ports.`);
    }
    try {
      const parsed = new URL(`http://${hostname}`);
      if (parsed.port || parsed.pathname !== '/' || hostname.includes('*')) throw new Error('invalid');
    } catch {
      throw new Error(`${name} contains an invalid hostname: ${hostname}.`);
    }
  }
  return hostnames;
}

function parsePort(value) {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parsePositiveInteger(value, name, defaultValue) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function requireUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value;
}

function rejectPlaceholder(value, name) {
  if (/YOUR_|CHANGE_ME|REPLACE_ME/i.test(value)) {
    throw new Error(`${name} still contains an example placeholder.`);
  }
  return value;
}

function publishableKey(value) {
  const key = rejectPlaceholder(value, 'SUPABASE_PUBLISHABLE_KEY');
  if (/^sb_secret_/i.test(key) || /service_role/i.test(key) || jwtRole(key) === 'service_role') {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must not be a service-role/secret key.');
  }
  return key;
}

function jwtRole(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env) {
  const nodeEnv = (env.NODE_ENV ?? 'development').trim();
  if (!NODE_ENVS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  const authMode = (env.MCP_AUTH_MODE ?? 'static').trim();
  if (!AUTH_MODES.has(authMode)) {
    throw new Error('MCP_AUTH_MODE must be static or supabase_oauth.');
  }

  const supabaseUrl = parseUrl(
    rejectPlaceholder(required(env, 'SUPABASE_URL'), 'SUPABASE_URL'),
    'SUPABASE_URL',
    { production: nodeEnv === 'production' }
  );
  const host = (env.HOST ?? '127.0.0.1').trim();
  if (!host) throw new Error('HOST must not be empty.');

  const base = {
    nodeEnv,
    authMode,
    supabaseUrl: supabaseUrl.origin,
    supabaseOAuthIssuer: new URL('/auth/v1', supabaseUrl).href.replace(/\/$/, ''),
    supabaseOAuthDiscoveryUrl: new URL('/.well-known/oauth-authorization-server/auth/v1', supabaseUrl).href,
    host,
    port: parsePort(env.PORT),
    allowedHosts: parseHostnameList(env.ALLOWED_HOSTS, 'ALLOWED_HOSTS'),
    allowedOrigins: parseHostnameList(env.ALLOWED_ORIGINS, 'ALLOWED_ORIGINS'),
    locationFreshnessMinutes: parsePositiveInteger(
      env.LOCATION_FRESHNESS_MINUTES,
      'LOCATION_FRESHNESS_MINUTES',
      30
    )
  };

  if (authMode === 'static') {
    const serviceRoleKey = rejectPlaceholder(
      required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      'SUPABASE_SERVICE_ROLE_KEY'
    );
    if (/^sb_publishable_/i.test(serviceRoleKey)) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is a publishable key; a service-role/secret key is required in static mode.');
    }
    const serviceJwtRole = jwtRole(serviceRoleKey);
    if (serviceJwtRole && serviceJwtRole !== 'service_role') {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY JWT does not have the service_role role.');
    }
    const bearerToken = rejectPlaceholder(required(env, 'MCP_BEARER_TOKEN'), 'MCP_BEARER_TOKEN');
    if (Buffer.byteLength(bearerToken, 'utf8') < 32) {
      throw new Error('MCP_BEARER_TOKEN must be at least 32 bytes; generate a high-entropy token.');
    }
    return Object.freeze({
      ...base,
      serviceRoleKey,
      actorId: requireUuid(required(env, 'TRAVEL_BRAIN_USER_ID'), 'TRAVEL_BRAIN_USER_ID'),
      bearerToken,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY?.trim()
        ? publishableKey(env.SUPABASE_PUBLISHABLE_KEY.trim())
        : null,
      publicBaseUrl: null,
      resourceServerUrl: null
    });
  }

  const oauthPublishableKey = publishableKey(required(env, 'SUPABASE_PUBLISHABLE_KEY'));
  const publicBaseUrl = parseUrl(
    rejectPlaceholder(required(env, 'PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL'),
    'PUBLIC_BASE_URL',
    { production: nodeEnv === 'production' }
  );
  const resourceServerUrl = new URL('/mcp', publicBaseUrl);

  return Object.freeze({
    ...base,
    serviceRoleKey: null,
    actorId: null,
    bearerToken: null,
    publishableKey: oauthPublishableKey,
    publicBaseUrl: publicBaseUrl.origin,
    resourceServerUrl
  });
}
