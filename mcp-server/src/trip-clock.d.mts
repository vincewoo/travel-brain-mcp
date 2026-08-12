/**
 * Types for the shared derivation helpers. The implementation is plain JavaScript because the
 * server is plain JavaScript; this declaration is what lets the TypeScript companion app import
 * the very same file instead of keeping a second copy of the day-grouping rules.
 */

export interface LocalDateTime {
  date: string;
  time: string;
}

export interface ClockItem {
  id: string;
  title?: string;
  status?: string;
  flexibility?: string;
  planned_start?: string | null;
  planned_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
}

export interface SchedulePosition<T> {
  now: T | null;
  next: T | null;
  then: T | null;
}

export interface ClockIssue {
  id: string;
  type: string;
  severity: string;
  title: string;
  detail: string;
  date: string;
  item_ids: string[];
}

export interface PlaceLike {
  locality?: string | null;
  region?: string | null;
  name?: string;
}

export interface TripPlaceLike {
  place_id: string;
  status?: string;
  priority?: number;
  places?: PlaceLike | null;
}

export interface ReservationLike {
  id: string;
  reserved_start?: string | null;
}

export interface PlanDay<T> {
  date: string;
  area: string | null;
  items: T[];
  fixed_anchors: unknown[];
  issue_count: number;
}

export interface ResearchLike {
  status?: string;
  volatility?: string;
  valid_as_of?: string | null;
  expires_at?: string | null;
  updated_at?: string | null;
}

export interface Point {
  latitude: number | null;
  longitude: number | null;
}

/** A drawable point: the same shape as `Point` once the null coordinates have been filtered out. */
export interface PlacedPoint {
  latitude: number;
  longitude: number;
}

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
  center: PlacedPoint;
  /** How many of the points offered actually had coordinates. */
  count: number;
}

export function validInstant(value: Date | string | number, name: string): Date;
export function localDateTime(value: Date | string | number, timezone: string): LocalDateTime;
export function timelineInstant(item: ClockItem): string | null;
export function sortedTimeline<T extends ClockItem>(items: T[]): T[];
export function activeScheduledItems<T extends ClockItem>(items: T[]): T[];
export function itemForInstant(item: ClockItem, instant: Date): boolean;
export function schedulePosition<T extends ClockItem>(
  items: T[],
  instant: Date,
  currentItemId?: string | null
): SchedulePosition<T>;
export function stableIssueId(type: string, itemIds: string[], date?: string): string;
export function overlapIssues<T extends ClockItem>(items: T[], timezone: string): ClockIssue[];
export function planIssues<T extends ClockItem & { place_id?: string | null }>(input: {
  items?: T[];
  tripPlaces?: TripPlaceLike[];
  research?: (ResearchLike & { place_id?: string | null })[];
  timezone: string;
  minimumBufferMinutes?: number | string | null;
  at?: Date | string | number;
}): ClockIssue[];
export function scheduledPlaceIds<T extends ClockItem & { place_id?: string | null }>(items: T[]): Set<string>;
export function unscheduledTripPlaces<P extends TripPlaceLike>(
  items: (ClockItem & { place_id?: string | null })[],
  tripPlaces?: P[]
): P[];
export function planDays<T extends ClockItem & { place_id?: string | null }>(input: {
  items?: T[];
  reservations?: ReservationLike[];
  tripPlaces?: TripPlaceLike[];
  issues?: ClockIssue[];
  timezone: string;
  startDate?: string | null;
  endDate?: string | null;
}): PlanDay<T>[];
export function researchFreshness(items: ResearchLike[] | null | undefined, now?: Date): string;
export function dateRange(start: string | null, end: string | null): string[];
export function haversineMeters(from: Point | null, to: Point | null): number | null;
export function geoBounds(points: (Point | null | undefined)[] | null | undefined): GeoBounds | null;
export function bearingDegrees(from: Point | null, to: Point | null): number | null;
