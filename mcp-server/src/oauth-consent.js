(() => {
  'use strict';

  const authorizationStorageKey = 'travel-brain.oauth.authorization-id';
  const requestedAuthorizationId = new URLSearchParams(window.location.search).get('authorization_id');
  if (requestedAuthorizationId && requestedAuthorizationId.length <= 512) {
    window.sessionStorage.setItem(authorizationStorageKey, requestedAuthorizationId);
  }
  const authorizationId = requestedAuthorizationId || window.sessionStorage.getItem(authorizationStorageKey);
  const status = document.querySelector('#status');
  const login = document.querySelector('#login');
  const consent = document.querySelector('#consent');
  const loginForm = document.querySelector('#login-form');
  const googleLogin = document.querySelector('#google-login');
  const magicLink = document.querySelector('#magic-link');
  const approve = document.querySelector('#approve');
  const deny = document.querySelector('#deny');
  const signOut = document.querySelector('#sign-out');
  let client;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function working(active) {
    for (const button of document.querySelectorAll('button')) button.disabled = active;
  }

  function showLogin() {
    consent.hidden = true;
    login.hidden = false;
    message('Sign in to review this authorization request.');
  }

  function redirectToClient(redirectUrl) {
    if (typeof redirectUrl !== 'string' || redirectUrl.length === 0) {
      throw new Error('Supabase did not return a client redirect URL.');
    }
    window.sessionStorage.removeItem(authorizationStorageKey);
    window.location.replace(redirectUrl);
  }

  function renderDetails(details) {
    login.hidden = true;
    consent.hidden = false;
    document.querySelector('#client-name').textContent = details.client?.name || 'An unnamed application';
    document.querySelector('#client-uri').textContent = details.client?.uri || 'Not provided';
    document.querySelector('#user-email').textContent = details.user?.email || 'Authenticated account';
    document.querySelector('#redirect-uri').textContent = details.redirect_uri || 'Not provided';
    const scopes = document.querySelector('#scopes');
    scopes.replaceChildren();
    for (const scope of (details.scope || '').split(/\s+/).filter(Boolean)) {
      const item = document.createElement('li');
      item.textContent = scope;
      scopes.append(item);
    }
    if (!scopes.childElementCount) {
      const item = document.createElement('li');
      item.textContent = 'No identity scopes were specified';
      scopes.append(item);
    }
    message('Review the request before deciding.');
  }

  async function loadAuthorization() {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData?.user) {
      showLogin();
      return;
    }
    message('Loading authorization details…');
    const { data, error } = await client.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !data) throw new Error(error?.message || 'Invalid or expired authorization request.');
    if (!('authorization_id' in data)) {
      redirectToClient(data.redirect_url);
      return;
    }
    renderDetails(data);
  }

  async function decide(decision) {
    working(true);
    message(decision === 'approve' ? 'Approving access…' : 'Denying access…');
    try {
      const result = decision === 'approve'
        ? await client.auth.oauth.approveAuthorization(authorizationId)
        : await client.auth.oauth.denyAuthorization(authorizationId);
      if (result.error || !result.data) throw new Error(result.error?.message || 'Unable to record your decision.');
      redirectToClient(result.data.redirect_url);
    } catch (error) {
      message(error.message, true);
      working(false);
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(loginForm);
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');
    if (!password) {
      message('Enter your password or request a magic link.', true);
      return;
    }
    working(true);
    message('Signing in…');
    const result = await client.auth.signInWithPassword({ email, password });
    working(false);
    if (result.error) {
      message(result.error.message, true);
      return;
    }
    await loadAuthorization();
  });

  googleLogin.addEventListener('click', async () => {
    working(true);
    message('Redirecting to Google…');
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: new URL('/oauth/consent', window.location.origin).href }
    });
    if (error) {
      working(false);
      message(error.message, true);
    }
  });

  magicLink.addEventListener('click', async () => {
    const email = document.querySelector('#email').value.trim();
    if (!email) {
      message('Enter your email address first.', true);
      return;
    }
    working(true);
    message('Sending a magic link…');
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: new URL('/oauth/consent', window.location.origin).href
      }
    });
    working(false);
    message(error ? error.message : 'Check your email and return with the sign-in link.', Boolean(error));
  });

  approve.addEventListener('click', () => void decide('approve'));
  deny.addEventListener('click', () => void decide('deny'));
  signOut.addEventListener('click', async () => {
    working(true);
    await client.auth.signOut();
    working(false);
    showLogin();
  });

  async function start() {
    if (!authorizationId || authorizationId.length > 512) {
      message('Missing or invalid authorization_id. Start authorization from your MCP client.', true);
      return;
    }
    try {
      const response = await fetch('/oauth/consent/config', { headers: { accept: 'application/json' } });
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || 'OAuth consent is not configured.');
      client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      await loadAuthorization();
    } catch (error) {
      message(error.message, true);
    }
  }

  void start();
})();
