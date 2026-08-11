import {
  dateRange,
  haversineMeters,
  localDateTime,
  planDays,
  planIssues,
  researchFreshness,
  schedulePosition,
  sortedTimeline,
  timelineInstant,
  unscheduledTripPlaces,
} from "../../../src/trip-clock.mjs";
import type { ClockIssue, PlanDay } from "../../../src/trip-clock.mjs";
import type {
  ItineraryItem,
  JournalEntry,
  Place,
  Recommendation,
  Reservation,
  ResearchItem,
  Snapshot,
  TripPlace,
  Visit,
} from "./types";

/**
 * The read models, recomputed on the phone.
 *
 * The server has `get_today` and `get_plan_overview`, but caching their output would be wrong by
 * morning: a stored "today" keeps insisting on yesterday once local midnight passes. So the cache
 * holds rows and this module derives the views from them, against the clock as it is now — using
 * the very same `trip-clock.mjs` the server's read models use, so the two cannot drift apart on
 * the question of which day an 11:40pm ferry belongs to.
 *
 * Day grouping is in the trip's zone, always, exactly as `getToday` does it.
 */

export interface DayView {
  date: string;
  timeline: ItineraryItem[];
  reservations: Reservation[];
}

export interface PositionView {
  now: ItineraryItem | null;
  next: ItineraryItem | null;
  then: ItineraryItem | null;
  localDate: string;
  localTime: string;
}

export interface PlaceCard {
  place: Place;
  tripStatus: string;
  priority: number;
  note: string | null;
  visit: Visit | null;
  recommendation: Recommendation | null;
  research: ResearchItem[];
  researchFreshness: string;
  scheduled: boolean;
  /** Trip-local days something on the itinerary points at this place — as `get_places_overview` reports. */
  itineraryDates: string[];
  distanceMeters: number | null;
}

/** What `get_plan_overview` returns, recomputed from the cached rows. */
export interface PlanView {
  days: PlanDay<ItineraryItem>[];
  issues: ClockIssue[];
  scheduledCount: number;
  unscheduled: TripPlace[];
}

export interface RecommendationCard {
  recommendation: Recommendation;
  place: Place | undefined;
  researchCount: number;
  visited: boolean;
}

const zoneOf = (snapshot: Snapshot) => snapshot.trip.timezone || "UTC";

/** The local date an instant falls on, or null when there is no instant to place. */
export function localDate(value: string | null | undefined, zone: string): string | null {
  if (!value) return null;
  try {
    return localDateTime(value, zone).date;
  } catch {
    return null;
  }
}

export function localTime(value: string | null | undefined, zone: string): string | null {
  if (!value) return null;
  try {
    return localDateTime(value, zone).time;
  } catch {
    return null;
  }
}

/** Trip dates, widened to include any day something is actually scheduled on. */
export function tripDays(snapshot: Snapshot): string[] {
  const zone = zoneOf(snapshot);
  const scheduled = snapshot.itinerary
    .map((item) => localDate(timelineInstant(item), zone))
    .filter((date): date is string => Boolean(date));
  const planned = dateRange(snapshot.trip.start_date, snapshot.trip.end_date);
  return [...new Set([...planned, ...scheduled])].sort();
}

export function dayView(snapshot: Snapshot, date: string): DayView {
  const zone = zoneOf(snapshot);
  const timeline = sortedTimeline(
    snapshot.itinerary.filter((item) => localDate(timelineInstant(item), zone) === date)
  );
  const reservations = snapshot.reservations.filter(
    (reservation) => localDate(reservation.reserved_start, zone) === date
  );
  // Alerts are not computed here: a day's problems come out of `planView`, which sees the whole
  // trip and so can also report the ones a single day cannot see (an unscheduled must-do, research
  // gone stale). Filtering those down to a day is `relatedIssues`.
  return { date, timeline, reservations };
}

export function position(snapshot: Snapshot, at: Date): PositionView {
  const zone = zoneOf(snapshot);
  const { date, time } = localDateTime(at, zone);
  const today = snapshot.itinerary.filter((item) => localDate(timelineInstant(item), zone) === date);
  const placed = schedulePosition(today, at, snapshot.current_state?.current_itinerary_item_id ?? null);
  return { ...placed, localDate: date, localTime: time };
}

export function placeIndex(snapshot: Snapshot): Map<string, Place> {
  return new Map(snapshot.places.map((link) => [link.place_id, link.places]));
}

/**
 * The whole plan: days, everything wrong with it, and the shortlist still waiting for a slot.
 *
 * `getPlanOverview` builds this from the same `planIssues`/`planDays` functions in
 * `trip-clock.mjs`, so a trip showing four issues in the dashboard shows four here — offline, and
 * without the phone inventing an issue of its own.
 */
export function planView(snapshot: Snapshot, at: Date = new Date()): PlanView {
  const timezone = zoneOf(snapshot);
  const issues = planIssues({
    items: snapshot.itinerary,
    tripPlaces: snapshot.places,
    research: snapshot.research,
    minimumBufferMinutes: (snapshot.trip.metadata?.minimum_buffer_minutes as number | undefined) ?? null,
    timezone,
    at,
  });
  return {
    issues,
    days: planDays({
      items: snapshot.itinerary,
      reservations: snapshot.reservations,
      tripPlaces: snapshot.places,
      issues,
      timezone,
      startDate: snapshot.trip.start_date,
      endDate: snapshot.trip.end_date,
    }),
    scheduledCount: snapshot.itinerary.filter((item) => !["cancelled", "skipped"].includes(item.status)).length,
    unscheduled: unscheduledTripPlaces(snapshot.itinerary, snapshot.places),
  };
}

/** Everything known about each saved place, assembled once so the views can stay dumb. */
export function placeCards(snapshot: Snapshot, origin?: { latitude: number; longitude: number } | null): PlaceCard[] {
  const now = new Date();
  const zone = zoneOf(snapshot);
  return snapshot.places.map((link: TripPlace) => {
    const research = snapshot.research.filter((entry) => entry.place_id === link.place_id);
    const visits = snapshot.visits.filter((visit) => visit.place_id === link.place_id);
    const recommendations = snapshot.recommendations.filter((entry) => entry.place_id === link.place_id);
    const scheduledItems = snapshot.itinerary.filter(
      (item) => item.place_id === link.place_id && !["cancelled", "skipped"].includes(item.status)
    );
    return {
      place: link.places,
      tripStatus: link.status,
      priority: link.priority,
      note: link.note,
      visit: visits[visits.length - 1] ?? null,
      recommendation: recommendations[recommendations.length - 1] ?? null,
      research,
      researchFreshness: researchFreshness(research, now),
      scheduled: scheduledItems.length > 0,
      itineraryDates: [
        ...new Set(
          scheduledItems
            .map((item) => localDate(item.planned_start, zone))
            .filter((date): date is string => Boolean(date))
        ),
      ],
      distanceMeters: origin ? haversineMeters(origin, link.places) : null,
    };
  });
}

/**
 * Saved places near a point, nearest first. The server answers this with PostGIS; offline this is
 * straight-line distance, which is the same caveat the server's own tool carries — geography, not
 * a walking route.
 */
export function nearbyCards(cards: PlaceCard[], radiusMeters = 2000, limit = 8): PlaceCard[] {
  return cards
    .filter((card) => card.distanceMeters !== null && card.distanceMeters <= radiusMeters)
    .sort((left, right) => (left.distanceMeters ?? 0) - (right.distanceMeters ?? 0))
    .slice(0, limit);
}

export function journalForDate(snapshot: Snapshot, date: string): JournalEntry[] {
  const zone = zoneOf(snapshot);
  return snapshot.journal.filter((entry) => localDate(entry.captured_at, zone) === date);
}

/** The journal newest first, as `get_recent_journal` returns it. */
export function journalEntries(snapshot: Snapshot): JournalEntry[] {
  return [...snapshot.journal].sort((left, right) => (right.captured_at ?? "").localeCompare(left.captured_at ?? ""));
}

/**
 * What the traveller would tell a friend, with the evidence behind each one attached. The
 * firsthand/mixed/research split is the product invariant, so the phone shows it the same way the
 * dashboard does rather than flattening it into one list.
 */
export function recommendationCards(snapshot: Snapshot): RecommendationCard[] {
  const places = placeIndex(snapshot);
  return snapshot.recommendations.map((recommendation) => ({
    recommendation,
    place: places.get(recommendation.place_id),
    researchCount: snapshot.research.filter((entry) => entry.place_id === recommendation.place_id).length,
    visited: snapshot.visits.some((visit) => visit.place_id === recommendation.place_id),
  }));
}

export function reservationsForItem(snapshot: Snapshot, itemId: string): Reservation[] {
  return snapshot.reservations.filter((reservation) => reservation.itinerary_item_id === itemId);
}

/**
 * The reference sheet: everything you might have to produce at a counter or show a driver, with
 * the soonest first. Lodging is included whether or not it carries a reservation row, because the
 * address of tonight's hotel is the single most valuable offline fact in the cache.
 */
export function referenceCards(snapshot: Snapshot): { reservations: Reservation[]; lodging: Place[] } {
  const reservations = [...snapshot.reservations].sort((left, right) =>
    (left.reserved_start ?? "").localeCompare(right.reserved_start ?? "")
  );
  const lodging = snapshot.places
    .filter((link) => ["lodging", "hotel", "accommodation"].includes((link.places.category ?? "").toLowerCase()))
    .map((link) => link.places);
  return { reservations, lodging };
}

export function searchCards(cards: PlaceCard[], query: string): PlaceCard[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter((card) =>
    [card.place.name, card.place.address, card.place.locality, card.place.category, card.note]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}
