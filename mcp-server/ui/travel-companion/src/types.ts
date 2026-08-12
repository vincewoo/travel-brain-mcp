/** Mirrors the `get_offline_snapshot` response. Rows, not derived views — see derive.ts. */

/** The issue shape both the server's read models and this app's derivations produce. */
export type { ClockIssue } from "../../../src/trip-clock.mjs";

export interface Trip {
  id: string;
  title: string;
  destination_summary: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface TripListEntry {
  id: string;
  title: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  destination_summary: string | null;
}

export interface ItineraryItem {
  id: string;
  trip_id: string;
  place_id: string | null;
  title: string;
  item_type: string;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  timezone: string | null;
  flexibility: string;
  priority: number;
  status: string;
  notes: string | null;
  metadata: Record<string, unknown>;
}

export interface Reservation {
  id: string;
  itinerary_item_id: string | null;
  place_id: string | null;
  provider: string | null;
  confirmation_code: string | null;
  status: string;
  reserved_start: string | null;
  reserved_end: string | null;
  party_size: number | null;
  cancellation_deadline: string | null;
  metadata: Record<string, unknown>;
}

export interface Place {
  id: string;
  name: string;
  category: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  external_ids: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface TripPlace {
  trip_id: string;
  place_id: string;
  status: string;
  priority: number;
  note: string | null;
  places: Place;
}

export interface Visit {
  id: string;
  place_id: string;
  itinerary_item_id: string | null;
  arrived_at: string | null;
  departed_at: string | null;
  rating: number | null;
  would_return: boolean | null;
  recommendation: string;
  notes: string | null;
}

export interface JournalEntry {
  id: string;
  itinerary_item_id: string | null;
  place_id: string | null;
  captured_at: string;
  raw_note: string;
  generated_summary: string | null;
  reaction: string | null;
  visibility: string;
}

export interface ResearchSource {
  source_url: string;
  source_title: string | null;
  publisher: string | null;
}

export interface ResearchItem {
  id: string;
  place_id: string | null;
  topic: string;
  finding: string;
  summary: string | null;
  volatility: string;
  status: string;
  valid_as_of: string;
  expires_at: string | null;
  research_sources: ResearchSource[];
}

export interface Recommendation {
  id: string;
  place_id: string;
  provenance: string;
  level: string;
  shareable_note: string | null;
  caveats: string | null;
  best_for: string[] | null;
}

export interface Memory {
  id: string;
  memory_type: string;
  content: string;
  confidence: number;
  status: string;
  provenance: string;
}

export interface LocationView {
  status: "fresh" | "stale" | "missing";
  latitude?: number;
  longitude?: number;
  observed_at?: string;
  age_minutes?: number;
}

/**
 * Where the traveller is, once it is good enough to draw or route from: the device's own GPS, or a
 * *fresh* server-known position. A stale fix never becomes an origin — see `App.tsx`.
 */
export interface Origin {
  latitude: number;
  longitude: number;
}

export interface Snapshot {
  trip: Trip;
  itinerary: ItineraryItem[];
  reservations: Reservation[];
  places: TripPlace[];
  visits: Visit[];
  journal: JournalEntry[];
  research: ResearchItem[];
  recommendations: Recommendation[];
  lessons: Memory[];
  preferences: Memory[];
  current_state: { current_itinerary_item_id: string | null; running_late_minutes: number } | null;
  location: LocationView;
  server_time: string;
  snapshot_etag: string;
}

export type Tab = "now" | "plan" | "places" | "journal" | "card";
