import {
  dateRange,
  haversineMeters,
  localDateTime,
  overlapIssues,
  researchFreshness,
  schedulePosition,
  sortedTimeline,
  timelineInstant,
} from "../../../src/trip-clock.mjs";
import type { ClockIssue } from "../../../src/trip-clock.mjs";
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
  alerts: ClockIssue[];
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
  distanceMeters: number | null;
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
  return { date, timeline, reservations, alerts: overlapIssues(timeline, zone) };
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

/** Everything known about each saved place, assembled once so the views can stay dumb. */
export function placeCards(snapshot: Snapshot, origin?: { latitude: number; longitude: number } | null): PlaceCard[] {
  const now = new Date();
  return snapshot.places.map((link: TripPlace) => {
    const research = snapshot.research.filter((entry) => entry.place_id === link.place_id);
    const visits = snapshot.visits.filter((visit) => visit.place_id === link.place_id);
    const recommendations = snapshot.recommendations.filter((entry) => entry.place_id === link.place_id);
    return {
      place: link.places,
      tripStatus: link.status,
      priority: link.priority,
      note: link.note,
      visit: visits[visits.length - 1] ?? null,
      recommendation: recommendations[recommendations.length - 1] ?? null,
      research,
      researchFreshness: researchFreshness(research, now),
      scheduled: snapshot.itinerary.some(
        (item) => item.place_id === link.place_id && !["cancelled", "skipped"].includes(item.status)
      ),
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
