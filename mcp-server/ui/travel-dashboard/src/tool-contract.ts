/** Exact MCP tool names from the completed Step 4 server. */
export const TOOL = {
  listTrips: "list_trips",
  trip: "get_trip",
  today: "get_today",
  currentContext: "get_current_context",
  planOverview: "get_plan_overview",
  placesOverview: "get_places_overview",
  recentJournal: "get_recent_journal",
  recommendations: "get_recommendations",
  tripLessons: "get_trip_lessons",
  nearbySavedPlaces: "get_nearby_saved_places",
  addPlace: "add_place",
  addItineraryItem: "add_itinerary_item",
  updateItineraryItem: "update_itinerary_item",
  updateCurrentTripState: "update_current_trip_state",
  recordJournalNote: "record_journal_note",
  markPlaceVisited: "mark_place_visited",
  proposeItineraryChange: "propose_itinerary_change",
  commitItineraryChange: "commit_itinerary_change",
  searchBrain: "search_travel_brain",
} as const;

export type TravelBrainToolName = (typeof TOOL)[keyof typeof TOOL];

export interface GetTodayInput { trip_id: string; date?: string; }
export interface GetCurrentContextInput { trip_id: string; at_time?: string; }
export interface UpdateItineraryItemInput {
  itinerary_item_id: string;
  planned_start?: string;
  planned_end?: string;
  actual_start?: string;
  actual_end?: string;
  flexibility?: "fixed" | "semi_flexible" | "flexible";
  priority?: number;
  status?: "planned" | "confirmed" | "in_progress" | "completed" | "skipped" | "cancelled";
  notes?: string;
}
export interface CommitItineraryChangeInput { proposal_id: string; }
