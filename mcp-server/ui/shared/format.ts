/**
 * How Travel Brain writes a time, a date, and a label — shared by the dashboard and the companion
 * PWA so the same itinerary item is not "9:00 AM · Semi-flexible" on one screen and "09:00 ·
 * semi_flexible" on the other.
 *
 * Instants (planned_start, captured_at, …) are rendered in the trip's own timezone: a
 * traveller in Tokyo wants "9:00 AM", not the time it would be back home. Every formatter
 * that touches an instant therefore takes an IANA zone, and date-only values — which the
 * server and `trip-clock.mjs` have already bucketed into trip-local days — are formatted as
 * calendar facts.
 *
 * This is presentation only. Anything that decides *which day* an instant belongs to lives in
 * `src/trip-clock.mjs`, the module the server shares with the phone.
 */

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Trips carry an IANA name; fall back to the reader's zone when it is missing or unknown here. */
export function resolveZone(value?: string | null): string {
  if (!value) return browserZone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return browserZone();
  }
}

function zonePart(zone: string, at: Date, type: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options })
      .formatToParts(at).find((part) => part.type === type)?.value ?? "";
  } catch {
    return "";
  }
}

/** "JST", "GMT+7" — the short name a zone goes by right now. */
export const zoneAbbreviation = (zone: string, at: Date = new Date()) =>
  zonePart(zone, at, "timeZoneName", { timeZoneName: "short" });

/** "Tokyo (JST)" — how the dashboard tells the reader which clock it is using. */
export function zoneLabel(zone: string) {
  const city = zone.split("/").pop()?.replaceAll("_", " ") ?? zone;
  const abbreviation = zoneAbbreviation(zone);
  return abbreviation && abbreviation !== city ? `${city} (${abbreviation})` : city;
}

/** The trip-local calendar date of an instant, as YYYY-MM-DD — the form the server sends dates in. */
export function zoneDate(value: string | null | undefined, zone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  const year = zonePart(zone, date, "year", parts);
  const month = zonePart(zone, date, "month", parts);
  const day = zonePart(zone, date, "day", parts);
  return year && month && day ? `${year}-${month}-${day}` : value.slice(0, 10);
}

export function timeLabel(value: string | null | undefined, zone: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { timeZone: zone, hour: "numeric", minute: "2-digit" });
}

export function timeRangeLabel(start: string | null | undefined, end: string | null | undefined, zone: string) {
  const startLabel = timeLabel(start, zone);
  const endLabel = timeLabel(end, zone);
  if (!startLabel) return "Unscheduled";
  return endLabel ? `${startLabel}–${endLabel}` : startLabel;
}

export function dateTimeLabel(value: string | null | undefined, zone: string) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** "15:42" on the trip's clock, rendered in the reader's locale as "3:42 PM". */
export function clockLabel(value?: string | null) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return value ?? "";
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return Number.isNaN(date.getTime()) ? value ?? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * A YYYY-MM-DD value is a calendar fact, not an instant, so it is anchored at UTC noon and
 * formatted in UTC — that way "Aug 10" reads as Aug 10 in every zone the dashboard is opened in.
 */
function calendarDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1, 12));
  return Number.isNaN(date.getTime()) ? null : date;
}

const calendarLabel = (value: string | null | undefined, options: Intl.DateTimeFormatOptions) => {
  if (!value) return "";
  const date = calendarDate(value);
  return date ? date.toLocaleDateString([], { timeZone: "UTC", ...options }) : value;
};

export const dateLabel = (value?: string | null, includeYear = false) =>
  calendarLabel(value, { weekday: "short", month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) });

/** "Monday, August 10" — the Today date heading. */
export const dayHeadingLabel = (value?: string | null) =>
  calendarLabel(value, { weekday: "long", month: "long", day: "numeric" });

/** "Aug 10" — the middle segment of the date stepper and short metadata. */
export const shortDateLabel = (value?: string | null) =>
  calendarLabel(value, { month: "short", day: "numeric" });

export function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** "1h 30m" / "45m" — empty when either end is missing or the span is not positive. */
export function durationLabel(start?: string | null, end?: string | null) {
  if (!start || !end) return "";
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? (rest ? `${hours}h ${rest}m` : `${hours}h`) : `${rest}m`;
}

/** Joins the parts of a metadata line, dropping anything empty. */
export function joinMeta(...parts: Array<string | number | false | null | undefined>) {
  return parts.filter((part) => part !== "" && part !== false && part !== null && part !== undefined).join(" · ");
}

export function humanize(value?: string | null) {
  if (!value) return "";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Sentence case for labels that read as prose: "Strongly recommend", not "Strongly Recommend". */
export function sentence(value?: string | null) {
  const words = (value ?? "").replaceAll("_", " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const FLEXIBILITY_LABELS: Record<string, string> = { fixed: "Fixed", semi_flexible: "Semi-flexible", flexible: "Flexible" };
export const flexibilityLabel = (value?: string | null) => FLEXIBILITY_LABELS[value ?? "flexible"] ?? sentence(value);

/**
 * The five tones the whole product speaks in. Anything that colours a dot, a status word or a
 * tinted row picks one of these, on both surfaces.
 */
export type Tone = "muted" | "info" | "warning" | "danger" | "ok";

/** `overlapIssues` says `error` for a fixed-commitment clash; `get_today` alerts say `danger`. */
export const issueTone = (severity?: string | null): Tone =>
  severity === "danger" || severity === "error" ? "danger"
    : severity === "info" ? "info"
    : "warning";

/**
 * Flexibility is metadata, so the word stays muted and only the dot carries the colour — except
 * for "fixed", which is the one value that changes what a traveller may do about an item.
 */
export function flexibilityStatus(value?: string | null): { label: string; dot: Tone; text: Tone | "" } {
  const flexibility = value ?? "flexible";
  return {
    label: flexibilityLabel(flexibility),
    dot: flexibility === "fixed" ? "warning" : flexibility === "semi_flexible" ? "info" : "muted",
    text: flexibility === "fixed" ? "warning" : "",
  };
}

/** A saved place's standing on the trip. Stale research outranks it: it is the actionable fact. */
export function placeStatus(tripStatus?: string | null, freshness?: string | null): { label: string; dot: Tone; text: Tone | "" } {
  if (freshness === "stale") return { label: "Needs refresh", dot: "warning", text: "warning" };
  const status = tripStatus ?? "shortlist";
  return {
    label: humanize(status),
    dot: status === "planned" ? "info" : status === "visited" ? "ok" : status === "rejected" ? "danger" : "muted",
    text: "",
  };
}

/** The provenance groups a recommendation list is read in — the invariant, spelled for a reader. */
export const RECOMMENDATION_GROUPS = [
  { key: "firsthand", label: "Firsthand", detail: (count: number) => `you went, ${plural(count, "place")}`, empty: "Nothing you've recommended is from a visit yet." },
  { key: "mixed", label: "Mixed evidence", detail: (count: number) => `${plural(count, "place")}`, empty: "No recommendation mixes a visit with research." },
  { key: "research", label: "Research only", detail: (count: number) => `not visited, ${plural(count, "place")}`, empty: "Everything you'd recommend, you've actually been to." },
] as const;
