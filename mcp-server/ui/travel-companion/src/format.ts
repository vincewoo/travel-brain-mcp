/** Presentation helpers. Every clock value is the trip's, never the phone's — see derive.ts. */

export function dayLabel(date: string, timezone: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(parsed);
}

export function relativeSince(iso?: string): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function distanceLabel(meters: number | null): string | null {
  if (meters === null) return null;
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

export const humanize = (value?: string | null): string =>
  (value ?? "").replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());

/**
 * A map link for a place. It needs a connection to open, so it is offered as a link and never as
 * the only way to read an address — the address text itself is always on screen.
 */
export function mapLink(place: { name: string; latitude: number | null; longitude: number | null; address: string | null }): string | null {
  if (place.latitude !== null && place.longitude !== null) {
    return `geo:${place.latitude},${place.longitude}?q=${encodeURIComponent(place.name)}`;
  }
  if (place.address) return `geo:0,0?q=${encodeURIComponent(`${place.name}, ${place.address}`)}`;
  return null;
}

/**
 * A place's address in the local script, when the planning agent recorded one. Handing a phone
 * showing 香港中環… to a taxi driver is the whole reason this field is worth carrying offline.
 */
export function localAddress(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.address_local ?? metadata?.local_address;
  return typeof value === "string" && value.trim() ? value : null;
}
