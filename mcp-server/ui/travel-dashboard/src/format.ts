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

export function humanize(value?: string | null) {
  if (!value) return "";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
