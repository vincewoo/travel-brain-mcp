/**
 * The formatting this app needs and the dashboard does not: how far away something is, how long
 * ago the cache was filled, and how to get an address out of the phone and into a taxi.
 *
 * Everything else — times, dates, flexibility labels, status tones — comes from
 * `ui/shared/format.ts`, shared with the dashboard so the two read identically.
 */

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

interface Locatable {
  name: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

/** What a link can say about a place: coordinates if it has them, otherwise the words. */
function query(place: Locatable): string | null {
  if (place.latitude !== null && place.longitude !== null) return `${place.latitude},${place.longitude}`;
  if (place.address) return `${place.name}, ${place.address}`;
  return place.name || null;
}

/**
 * A map link for a place. It needs a connection to open, so it is offered as a link and never as
 * the only way to read an address — the address text itself is always on screen.
 *
 * These are Google Maps Universal URLs rather than a `geo:` URI. `geo:` is the neutral form and
 * would be the nicer one, but iOS Safari does not handle it, and iOS is the platform this app is
 * written for — the whole Add-to-Home-Screen story exists because of how iOS evicts IndexedDB. A
 * link that silently does nothing on the traveller's phone is worse than a branded one. No API key
 * is involved; these are plain URLs that open the installed app on iOS and Android and the web map
 * everywhere else.
 */
export function mapSearchLink(place: Locatable): string | null {
  const target = query(place);
  return target ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target)}` : null;
}

/**
 * Directions to a place, on foot. `origin` is only ever passed when the position is fresh — routing
 * from a stale fix would draw a confident line from somewhere the traveller left hours ago. Left
 * off, Google Maps uses the device's own location, which is the honest default.
 */
export function mapDirectionsLink(
  place: Locatable,
  origin?: { latitude: number; longitude: number } | null
): string | null {
  const target = query(place);
  if (!target) return null;
  const from = origin ? `&origin=${encodeURIComponent(`${origin.latitude},${origin.longitude}`)}` : "";
  return `https://www.google.com/maps/dir/?api=1${from}&destination=${encodeURIComponent(target)}&travelmode=walking`;
}

/**
 * A place's address in the local script, when the planning agent recorded one. Handing a phone
 * showing 香港中環… to a taxi driver is the whole reason this field is worth carrying offline.
 */
export function localAddress(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.address_local ?? metadata?.local_address;
  return typeof value === "string" && value.trim() ? value : null;
}
