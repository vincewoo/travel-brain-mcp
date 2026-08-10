export type Flexibility = "fixed" | "semi_flexible" | "flexible";
export type TripView = "today" | "plan" | "places" | "journal" | "recommendations";
export type TripStatus = "draft" | "planning" | "active" | "completed" | "archived";
export type Severity = "info" | "warning" | "danger";

export interface TripSummary {
  id: string;
  title: string;
  destination_summary?: string | null;
  status?: TripStatus | string | null;
  timezone?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface TimelineItem {
  id: string;
  title: string;
  item_type?: string | null;
  place_id?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  status?: string | null;
  flexibility?: Flexibility | null;
  priority?: number | null;
  notes?: string | null;
  travel_minutes_to_next?: number | null;
}

export interface PlanningIssue {
  id?: string;
  type?: string;
  severity?: Severity;
  title: string;
  detail?: string | null;
  date?: string | null;
  item_ids?: string[];
  place_ids?: string[];
}

export interface PendingProposal {
  id: string;
  summary?: string | null;
  rationale?: string | null;
  status?: string | null;
  expires_at?: string | null;
  validation?: { warnings?: string[] } | null;
}

export interface DashboardSnapshot {
  trip: TripSummary;
  date: string;
  timezone?: string | null;
  local_time?: string | null;
  now?: TimelineItem | null;
  next?: TimelineItem | null;
  then?: TimelineItem | null;
  timeline: TimelineItem[];
  alerts: PlanningIssue[];
  running_late_minutes?: number;
  pending_proposal?: PendingProposal | null;
}

export interface PlanningDay {
  date: string;
  area?: string | null;
  items: TimelineItem[];
  fixed_anchors?: unknown[];
  issue_count?: number;
}

export interface RecommendationRecord {
  id?: string;
  place_id?: string;
  provenance?: "firsthand" | "research" | "mixed" | string | null;
  level?: "none" | "mixed" | "recommend" | "strongly_recommend" | "avoid" | string | null;
  shareable_note?: string | null;
  caveats?: string | null;
  best_for?: string[];
  created_at?: string | null;
}

export interface SavedPlace {
  id: string;
  name: string;
  category?: string | null;
  address?: string | null;
  locality?: string | null;
  region?: string | null;
  country_code?: string | null;
  trip_status?: string | null;
  priority?: number | null;
  note?: string | null;
  researched?: boolean;
  research_count?: number;
  scheduled?: boolean;
  itinerary_item_ids?: string[];
  itinerary_dates?: string[];
  visited?: boolean;
  freshness?: string | null;
  visit?: Record<string, unknown> | null;
  recommendation?: RecommendationRecord | null;
}

export interface PlanOverview {
  trip: TripSummary;
  days: PlanningDay[];
  issues: PlanningIssue[];
  unscheduled_places: SavedPlace[];
  scheduled_count?: number;
  total_days?: number;
}

export interface PlacesOverview { places: SavedPlace[]; }

export interface JournalEntry {
  id: string;
  captured_at?: string | null;
  raw_note: string;
  generated_summary?: string | null;
  reaction?: string | null;
  visibility?: string | null;
  places?: { id?: string; name?: string } | null;
  itinerary_items?: TimelineItem | null;
}
export interface JournalOverview { entries: JournalEntry[]; }

export interface RecommendationItem {
  recommendation: RecommendationRecord;
  place: SavedPlace;
  visit?: Record<string, unknown> | null;
  research?: unknown[];
}
export interface RecommendationsOverview { recommendations: RecommendationItem[]; }

export interface LauncherContext { trip_id?: string; date?: string; view?: TripView; }
