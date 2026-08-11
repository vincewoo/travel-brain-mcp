import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { KEY, deleteValue, readValue, writeValue } from "./store";

/**
 * The companion is a first-class OAuth client, not a signed-in web page.
 *
 * The MCP server's verifier requires a Supabase OAuth 2.1 access token carrying `client_id` and
 * the `/auth/v1` issuer, which a plain Supabase Auth session token does not have. So this runs the
 * real authorization-code + PKCE flow, either against a pre-registered client id
 * (`VITE_OAUTH_CLIENT_ID`) or by registering dynamically when the Supabase project allows it.
 *
 * Tokens live in IndexedDB alongside the trip cache. The PKCE verifier and the discovery state go
 * to sessionStorage because they only have to outlive a redirect in the same tab, and leaving a
 * verifier behind after a half-finished sign-in is pointless risk.
 */

const STATIC_CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID as string | undefined;
const VERIFIER_KEY = "oauth:code_verifier";

export const redirectUri = new URL("/app/callback", location.origin).href;

/** Raised instead of navigating away, when a sign-in was not asked for. */
export class SignInRequiredError extends Error {
  constructor() {
    super("Sign in to sync this trip.");
    this.name = "SignInRequiredError";
  }
}

export class CompanionAuthProvider implements OAuthClientProvider {
  /**
   * Whether this provider may navigate the page to the authorization server.
   *
   * A background sync must never do that. Opening the app with an expired session would otherwise
   * throw the traveller at a login page instead of the trip already cached on the phone — in a
   * tunnel, that is the app failing at the one job it exists for. Only the Sign in button
   * constructs an interactive provider; a refresh token still renews silently either way, because
   * that path does not redirect.
   */
  constructor(private readonly interactive = false) {}

  get redirectUrl(): string {
    return redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Travel Brain Companion",
      client_uri: new URL("/app/", location.origin).href,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (STATIC_CLIENT_ID) return { client_id: STATIC_CLIENT_ID };
    return readValue<StoredOAuthClientInformation>(KEY.clientInformation);
  }

  async saveClientInformation(information: StoredOAuthClientInformation): Promise<void> {
    if (STATIC_CLIENT_ID) return;
    await writeValue(KEY.clientInformation, information);
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return readValue<StoredOAuthTokens>(KEY.tokens);
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await writeValue(KEY.tokens, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.interactive) throw new SignInRequiredError();
    location.assign(authorizationUrl.href);
  }

  saveCodeVerifier(codeVerifier: string): void {
    sessionStorage.setItem(VERIFIER_KEY, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) throw new Error("This sign-in did not start in this tab. Try signing in again.");
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    sessionStorage.setItem(KEY.discovery, JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const stored = sessionStorage.getItem(KEY.discovery);
    return stored ? (JSON.parse(stored) as OAuthDiscoveryState) : undefined;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "tokens") await deleteValue(KEY.tokens);
    if ((scope === "all" || scope === "client") && !STATIC_CLIENT_ID) {
      await deleteValue(KEY.clientInformation);
    }
    if (scope === "all" || scope === "verifier") sessionStorage.removeItem(VERIFIER_KEY);
    if (scope === "all" || scope === "discovery") sessionStorage.removeItem(KEY.discovery);
  }
}

/**
 * Whether a token is on file at all. Deliberately not "is the token valid": reading the cache must
 * never wait on the network, so an expired token still opens the app and only blocks syncing.
 */
export async function hasStoredCredentials(): Promise<boolean> {
  return Boolean(await readValue<StoredOAuthTokens>(KEY.tokens));
}
