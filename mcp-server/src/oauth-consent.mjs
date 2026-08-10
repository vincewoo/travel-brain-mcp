import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const consentHtml = resolve(sourceDirectory, 'oauth-consent.html');
const consentCss = resolve(sourceDirectory, 'oauth-consent.css');
const consentJs = resolve(sourceDirectory, 'oauth-consent.js');
const supabaseBrowserBundle = resolve(
  sourceDirectory,
  '../node_modules/@supabase/supabase-js/dist/umd/supabase.js'
);

function setConsentSecurityHeaders(res, supabaseUrl) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      "base-uri 'none'",
      `connect-src 'self' ${supabaseUrl}`,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'"
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
}

export function installOAuthConsentRoutes(app, config) {
  const secure = (_req, res, next) => {
    setConsentSecurityHeaders(res, config.supabaseUrl);
    next();
  };

  app.get('/oauth/consent', secure, (_req, res) => {
    res.type('html').sendFile(consentHtml);
  });

  app.get('/oauth/consent/config', secure, (_req, res) => {
    if (!config.publishableKey) {
      res.status(503).json({
        error: 'OAuth consent is not configured. Set SUPABASE_PUBLISHABLE_KEY.'
      });
      return;
    }
    res.json({
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.publishableKey
    });
  });

  app.get('/oauth/consent/app.css', secure, (_req, res) => {
    res.type('css').sendFile(consentCss);
  });
  app.get('/oauth/consent/app.js', secure, (_req, res) => {
    res.type('js').sendFile(consentJs);
  });
  app.get('/oauth/consent/supabase.js', secure, (_req, res) => {
    res.type('js').sendFile(supabaseBrowserBundle);
  });
}
