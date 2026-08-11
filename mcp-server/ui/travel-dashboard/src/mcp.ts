import { App } from "@modelcontextprotocol/ext-apps";
import type {
  DashboardSnapshot, JournalEntry, JournalOverview, LauncherContext, PlanOverview,
  PlacesOverview, RecommendationItem, RecommendationsOverview, SavedPlace,
  TripSummary, TripView,
} from "./types";
import { TOOL, type TravelBrainToolName } from "./tool-contract";

export const app = new App(
  { name: "Travel Brain Dashboard", version: "0.3.0" },
  {},
  { autoResize: true, strict: true },
);

type JsonRecord = Record<string, any>;
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function textFromResult(result: any): string {
  return result?.content?.find?.((entry: any) => entry.type === "text")?.text ?? "";
}

export function parseToolJson(result: any): any {
  if (isRecord(result?.structuredContent)) return result.structuredContent;
  const raw = textFromResult(result);
  if (!raw) return null;
  const starts = [raw.indexOf("{"), raw.indexOf("[")].filter((index) => index >= 0);
  for (const candidate of [raw, ...(starts.length ? [raw.slice(Math.min(...starts))] : [])]) {
    try { return JSON.parse(candidate); } catch { /* readable fallback follows */ }
  }
  return { text: raw };
}

export async function callTool<T = any>(name: TravelBrainToolName, args: Record<string, unknown> = {}): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(textFromResult(result) || `${name} failed.`);
  return parseToolJson(result) as T;
}

export async function sendClaudeMessage(text: string) {
  const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
  if (result.isError) throw new Error("Claude did not accept that request.");
  return result;
}

export function defaultViewForTripStatus(status?: string | null): TripView {
  switch (status) {
    case "draft": return "places";
    case "planning": return "plan";
    case "active": return "today";
    case "completed": return "journal";
    case "archived": return "recommendations";
    default: return "today";
  }
}

function tripSummary(raw: any, fallbackId: string): TripSummary {
  return {
    id: raw?.id ?? fallbackId, title: raw?.title ?? "Travel Brain",
    destination_summary: raw?.destination_summary ?? null, status: raw?.status ?? null,
    timezone: raw?.timezone ?? null, start_date: raw?.start_date ?? null, end_date: raw?.end_date ?? null,
  };
}

function normalizePlace(raw: any): SavedPlace {
  const place = raw?.place ?? raw?.places ?? raw ?? {};
  return {
    id: place.id ?? raw?.place_id, name: place.name ?? "Saved place",
    category: place.category ?? null, address: place.address ?? null,
    locality: place.locality ?? null, region: place.region ?? null, country_code: place.country_code ?? null,
    trip_status: raw?.trip_status ?? raw?.status ?? "saved", priority: raw?.priority ?? null,
    note: raw?.note ?? null, researched: Boolean(raw?.researched), research_count: raw?.research_count ?? 0,
    scheduled: Boolean(raw?.scheduled), itinerary_item_ids: raw?.itinerary_item_ids ?? [],
    itinerary_dates: raw?.itinerary_dates ?? [], visited: Boolean(raw?.visited),
    freshness: raw?.research_freshness ?? raw?.freshness ?? null, visit: raw?.visit ?? null,
    recommendation: raw?.recommendation ?? null,
  };
}

/** "You have no trips" is a different screen from "something broke", so it gets its own type. */
export class NoTripError extends Error {
  constructor() { super("No Travel Brain trip is available yet."); this.name = "NoTripError"; }
}

export interface LoadedTripShell { tripId: string; trip: TripSummary; raw: JsonRecord; }

export async function loadTripShell(ctx: LauncherContext): Promise<LoadedTripShell> {
  let tripId = ctx.trip_id;
  if (!tripId) {
    const listed = await callTool<{ trips?: any[] }>(TOOL.listTrips, {});
    const trips = Array.isArray(listed?.trips) ? listed.trips : (Array.isArray(listed) ? listed : []);
    const preferred = trips.find((trip: any) => trip.status === "active") ??
      trips.find((trip: any) => trip.status === "planning") ?? trips.find((trip: any) => trip.status === "draft") ??
      trips.find((trip: any) => trip.status === "completed") ?? trips[0];
    tripId = preferred?.id;
  }
  if (!tripId) throw new NoTripError();
  const raw = await callTool<JsonRecord>(TOOL.trip, { trip_id: tripId });
  return { tripId, trip: tripSummary(raw?.trip ?? raw, tripId), raw };
}

export async function loadSnapshot(ctx: LauncherContext, shell: LoadedTripShell): Promise<DashboardSnapshot> {
  const [today, current] = await Promise.all([
    callTool<JsonRecord>(TOOL.today, { trip_id: shell.tripId, ...(ctx.date ? { date: ctx.date } : {}) }),
    callTool<JsonRecord>(TOOL.currentContext, { trip_id: shell.tripId }),
  ]);
  const currentDate = today.date === current.local_date;
  return {
    trip: { ...shell.trip, ...(today.trip ?? {}) }, date: today.date ?? ctx.date ?? current.local_date,
    timezone: today.timezone ?? shell.trip.timezone, local_time: currentDate ? current.local_time : today.local_time,
    now: currentDate ? current.now ?? today.now ?? null : today.now ?? null,
    next: currentDate ? current.next ?? today.next ?? null : today.next ?? null,
    then: currentDate ? current.then ?? today.then ?? null : today.then ?? null,
    timeline: Array.isArray(today.timeline) ? today.timeline : [], alerts: Array.isArray(today.alerts) ? today.alerts : [],
    running_late_minutes: currentDate ? current.running_late_minutes ?? 0 : 0,
    pending_proposal: current.pending_proposal ?? null,
  };
}

export async function loadPlan(shell: LoadedTripShell): Promise<PlanOverview> {
  const raw = await callTool<JsonRecord>(TOOL.planOverview, { trip_id: shell.tripId });
  return {
    trip: { ...shell.trip, ...(raw?.trip ?? {}) }, total_days: raw?.total_days ?? 0,
    scheduled_count: raw?.scheduled_count ?? 0, days: Array.isArray(raw?.days) ? raw.days : [],
    issues: Array.isArray(raw?.issues) ? raw.issues : [],
    unscheduled_places: Array.isArray(raw?.unscheduled_places) ? raw.unscheduled_places.map(normalizePlace) : [],
  };
}

export async function loadPlaces(shell: LoadedTripShell): Promise<PlacesOverview> {
  const raw = await callTool<JsonRecord>(TOOL.placesOverview, { trip_id: shell.tripId, limit: 250 });
  return { places: Array.isArray(raw?.places) ? raw.places.map(normalizePlace) : [] };
}

export async function loadJournal(shell: LoadedTripShell): Promise<JournalOverview> {
  const raw = await callTool<JsonRecord>(TOOL.recentJournal, { trip_id: shell.tripId, limit: 100 });
  return { entries: (Array.isArray(raw?.entries) ? raw.entries : []) as JournalEntry[] };
}

export async function loadRecommendations(shell: LoadedTripShell): Promise<RecommendationsOverview> {
  const raw = await callTool<JsonRecord>(TOOL.recommendations, { trip_id: shell.tripId, limit: 250 });
  const recommendations = Array.isArray(raw?.recommendations) ? raw.recommendations : [];
  return { recommendations: recommendations.map((entry: any): RecommendationItem => ({
    recommendation: entry?.recommendation ?? {},
    place: normalizePlace({
      place: entry?.place, trip_status: entry?.visit ? "visited" : "saved",
      researched: Boolean(entry?.research?.length), research_count: entry?.research?.length ?? 0,
      visited: Boolean(entry?.visit), visit: entry?.visit, recommendation: entry?.recommendation,
    }),
    visit: entry?.visit ?? null, research: Array.isArray(entry?.research) ? entry.research : [],
  })) };
}
