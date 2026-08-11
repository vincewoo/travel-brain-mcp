export function timeLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function timeRangeLabel(start?: string | null, end?: string | null) {
  const startLabel = timeLabel(start);
  const endLabel = timeLabel(end);
  if (!startLabel) return "Unscheduled";
  return endLabel ? `${startLabel}–${endLabel}` : startLabel;
}

export function dateLabel(value?: string | null, includeYear = false) {
  if (!value) return "";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}),
  });
}

export function dateTimeLabel(value?: string | null) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** "Monday, August 10" — the Today date heading. */
export function dayHeadingLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/** "Aug 10" — the middle segment of the date stepper and short metadata. */
export function shortDateLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { month: "short", day: "numeric" });
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
