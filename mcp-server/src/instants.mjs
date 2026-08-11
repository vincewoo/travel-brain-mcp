/**
 * Timestamps arrive from a planning agent that thinks in the traveller's clock: "the Li River
 * cruise leaves at 09:00" means 09:00 in Guilin, not 09:00 UTC. A string without an offset has
 * no instant in it, and Postgres resolves such a value against the session zone (UTC), which
 * silently records a 9am cruise as a 5pm one. Every naive timestamp written to a timestamptz
 * column is therefore anchored here, in the zone the item actually happens in.
 *
 * A value that carries its own offset ("…+08:00", "…Z") already names an instant and is passed
 * through untouched — the caller was explicit, and second-guessing that would be the same class
 * of bug in the other direction.
 */

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?)?$/;

/** How far ahead of UTC `zone` runs at `instant`, in minutes. */
function offsetMinutes(zone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(instant).map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/** True when the zone is an IANA name this runtime knows. */
export function knownZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a timestamp the way the traveller meant it.
 *
 * Naive wall-clock strings ("2026-12-28T09:00", "2026-12-28") are resolved in `zone` and returned
 * as an ISO instant; anything already carrying an offset, and anything this does not recognise as
 * a wall clock, is returned unchanged for Postgres to judge. Null and undefined pass through so
 * callers can hand over optional fields directly.
 */
export function zonedInstant(value, zone) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || HAS_OFFSET.test(text)) return value;
  const match = WALL_CLOCK.exec(text);
  if (!match || !knownZone(zone)) return value;

  const [, year, month, day, hour = '0', minute = '0', second = '0', millisecond = '0'] = match;
  // Offsets are read back at second resolution, so the zone is resolved on a whole second and
  // the sub-second part is added to the instant at the end.
  const milliseconds = Number(millisecond.padEnd(3, '0'));
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  // The offset depends on the instant, and the instant depends on the offset: guess with the
  // offset in force at the naive value, then re-read it at the candidate instant so a wall time
  // on the far side of a DST change lands on the offset that is actually in effect there.
  const firstPass = wall - offsetMinutes(zone, new Date(wall)) * 60_000;
  const secondPass = wall - offsetMinutes(zone, new Date(firstPass)) * 60_000;
  // A wall time inside a spring-forward gap never happens, so the second pass cannot reproduce
  // it. Keep the pre-transition reading, which shifts such a time forward across the gap.
  const settled = secondPass + offsetMinutes(zone, new Date(secondPass)) * 60_000 === wall ? secondPass : firstPass;
  const instant = new Date(settled + milliseconds);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
}

/** Apply {@link zonedInstant} to the named keys of an object, leaving absent keys absent. */
export function zonedInstants(input, keys, zone) {
  const result = { ...input };
  for (const key of keys) {
    if (result[key] !== undefined) result[key] = zonedInstant(result[key], zone);
  }
  return result;
}
