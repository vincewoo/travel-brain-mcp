import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { CompanionAuthProvider, hasStoredCredentials, SignInRequiredError } from "./auth";
import { KEY, readValue, writeValue } from "./store";
import type { Snapshot, TripListEntry } from "./types";

/**
 * The network half of the companion, and the only part that can fail because of signal.
 *
 * Everything the app displays comes from IndexedDB; this module's whole job is to refill it. One
 * `get_offline_snapshot` call carries a whole trip, which is the point — on a connection that
 * drops in a tunnel, one request that either lands or does not beats seven that each might.
 */

const MCP_URL = new URL("/mcp", location.origin);

/**
 * Background work uses a provider that refuses to navigate away; only the Sign in button uses one
 * that may. Both read and write the same stored credentials, so a silent refresh-token renewal
 * still happens on either path.
 */
const backgroundAuth = new CompanionAuthProvider(false);
const interactiveAuth = new CompanionAuthProvider(true);

function newTransport(authProvider: CompanionAuthProvider = backgroundAuth) {
  return new StreamableHTTPClientTransport(MCP_URL, { authProvider });
}

async function connect(transport = newTransport()): Promise<Client> {
  const client = new Client({ name: "Travel Brain Companion", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function parseResult(result: any): any {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find?.((entry: any) => entry.type === "text")?.text ?? "";
  const start = text.indexOf("{");
  try {
    return start >= 0 ? JSON.parse(text.slice(start)) : null;
  } catch {
    return null;
  }
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as any[])?.find((entry) => entry.type === "text")?.text;
    throw new Error(text || `${name} failed.`);
  }
  return parseResult(result) as T;
}

/** Sign-in is the one thing that must be started deliberately, so it is its own call. */
export async function beginSignIn(): Promise<void> {
  try {
    const client = await connect(newTransport(interactiveAuth));
    await client.close();
  } catch (error) {
    // The provider has already navigated to the authorization server by this point; the throw is
    // how the SDK reports "the user is being sent away", not a failure worth showing.
    if (error instanceof UnauthorizedError) return;
    throw error;
  }
}

/** Finish the redirect leg. Called only on /app/callback. */
export async function completeSignIn(params: URLSearchParams): Promise<void> {
  const transport = newTransport(interactiveAuth);
  await transport.finishAuth(params);
  const client = await connect(transport);
  await client.close();
}

export interface SyncResult {
  snapshot: Snapshot;
  syncedAt: string;
  unchanged: boolean;
}

/**
 * Refill the cache. Picks the same trip as last time when it can, otherwise the one most likely to
 * be the trip in progress — active first, then planning, then whatever exists.
 */
export async function sync(requestedTripId?: string): Promise<SyncResult> {
  // Nothing on file means no session to renew, and attempting one anyway would run discovery and
  // dynamic client registration against the authorization server before failing — network work a
  // signed-out device on a bad connection should never do. The traveller taps Sign in instead.
  if (!(await hasStoredCredentials())) throw new SignInRequiredError();
  const client = await connect();
  try {
    const listed = await callTool<{ trips?: TripListEntry[] }>(client, "list_trips");
    const trips = listed?.trips ?? [];
    await writeValue(KEY.trips, trips);

    const remembered = requestedTripId ?? (await readValue<string>(KEY.tripId));
    const tripId =
      trips.find((trip) => trip.id === remembered)?.id ??
      trips.find((trip) => trip.status === "active")?.id ??
      trips.find((trip) => trip.status === "planning")?.id ??
      trips[0]?.id;
    if (!tripId) throw new Error("There are no trips in this Travel Brain yet.");

    const snapshot = await callTool<Snapshot>(client, "get_offline_snapshot", { trip_id: tripId });
    const previous = await readValue<Snapshot>(KEY.snapshot);
    const unchanged = previous?.snapshot_etag === snapshot.snapshot_etag;
    const syncedAt = new Date().toISOString();

    await writeValue(KEY.snapshot, snapshot);
    await writeValue(KEY.syncedAt, syncedAt);
    await writeValue(KEY.tripId, tripId);
    return { snapshot, syncedAt, unchanged };
  } finally {
    await client.close();
  }
}

export async function loadCachedSnapshot(): Promise<{ snapshot?: Snapshot; syncedAt?: string; trips: TripListEntry[] }> {
  const [snapshot, syncedAt, trips] = await Promise.all([
    readValue<Snapshot>(KEY.snapshot),
    readValue<string>(KEY.syncedAt),
    readValue<TripListEntry[]>(KEY.trips),
  ]);
  return { snapshot, syncedAt, trips: trips ?? [] };
}

export { SignInRequiredError, UnauthorizedError };
