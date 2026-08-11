/**
 * Deriving trip views from trip rows: which local day an instant belongs to, what order a
 * timeline runs in, what is happening now, and which plans collide.
 *
 * These are pure functions over rows the caller already has, with no Supabase and no config, for
 * one reason: the offline companion has to compute the same answers on a phone with no network.
 * If the read models kept this logic to themselves and the companion reimplemented it, the two
 * would eventually disagree about which day an 11:40pm ferry belongs to — and the traveller would
 * be the one to discover it, at the pier. `db.mjs` and the companion PWA import this same file.
 *
 * Everything is `Intl` and `Date` only, so it runs unmodified in Node and in a browser.
 */

export function validInstant(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp.`);
  return date;
}

/** The wall-clock date and time an instant reads as in `timezone`. */
export function localDateTime(value, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(validInstant(value, 'timestamp')).map((part) => [part.type, part.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function timelineInstant(item) {
  return item.actual_start ?? item.planned_start ?? null;
}

export function sortedTimeline(items) {
  return [...items].sort((a, b) => {
    const left = timelineInstant(a);
    const right = timelineInstant(b);
    if (!left) return right ? 1 : a.id.localeCompare(b.id);
    if (!right) return -1;
    return new Date(left) - new Date(right) || a.id.localeCompare(b.id);
  });
}

export function activeScheduledItems(items) {
  return items.filter((item) => !['cancelled', 'skipped'].includes(item.status));
}

export function itemForInstant(item, instant) {
  const start = item.actual_start ?? item.planned_start;
  const end = item.actual_end ?? item.planned_end;
  if (!start) return false;
  return new Date(start) <= instant && (!end || instant <= new Date(end));
}

export function schedulePosition(items, instant, currentItemId = null) {
  const scheduled = sortedTimeline(activeScheduledItems(items)).filter((item) => timelineInstant(item));
  const current = (currentItemId && scheduled.find((item) => item.id === currentItemId))
    || scheduled.find((item) => itemForInstant(item, instant))
    || null;
  const following = scheduled.filter((item) => new Date(timelineInstant(item)) > instant && item.id !== current?.id);
  return { now: current, next: following[0] ?? null, then: following[1] ?? null };
}

export function stableIssueId(type, itemIds, date = '') {
  return `${type}:${date}:${[...itemIds].sort().join(':')}`;
}

export function overlapIssues(items, timezone) {
  const timed = activeScheduledItems(items)
    .filter((item) => item.planned_start && item.planned_end)
    .sort((a, b) => new Date(a.planned_start) - new Date(b.planned_start) || a.id.localeCompare(b.id));
  const issues = [];
  for (let index = 0; index < timed.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < timed.length; otherIndex += 1) {
      const left = timed[index];
      const right = timed[otherIndex];
      if (new Date(right.planned_start) >= new Date(left.planned_end)) break;
      if (new Date(right.planned_end) <= new Date(left.planned_start)) continue;
      const fixed = left.flexibility === 'fixed' && right.flexibility === 'fixed';
      const date = localDateTime(left.planned_start, timezone).date;
      const type = fixed ? 'fixed_commitment_overlap' : 'overlap';
      issues.push({
        id: stableIssueId(type, [left.id, right.id], date),
        type,
        severity: fixed ? 'error' : 'warning',
        title: fixed ? 'Fixed commitments overlap' : 'Two itinerary items overlap',
        detail: `${left.title} overlaps ${right.title}.`,
        date,
        item_ids: [left.id, right.id]
      });
    }
  }
  return issues;
}

export function researchFreshness(items, now = new Date()) {
  if (!items?.length) return 'missing';
  const latest = [...items].sort((a, b) => new Date(b.valid_as_of ?? b.updated_at) - new Date(a.valid_as_of ?? a.updated_at))[0];
  if (latest.status === 'stale' || (latest.expires_at && new Date(latest.expires_at) < now)) return 'stale';
  const ageDays = (now - new Date(latest.valid_as_of ?? latest.updated_at)) / 86_400_000;
  if (latest.volatility === 'volatile' && ageDays > 30) return 'stale';
  if (latest.volatility === 'semi_volatile' && ageDays > 180) return 'stale';
  return 'fresh';
}

export function dateRange(start, end) {
  if (!start || !end) return [];
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const finish = new Date(`${end}T00:00:00Z`);
  while (cursor <= finish && dates.length < 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Straight-line distance in metres. The server answers "what is nearby" with PostGIS
 * (`nearby_trip_places`); offline there is no PostGIS, so the phone falls back to this. Same
 * caveat either way — it is geography, not a walking route.
 */
export function haversineMeters(from, to) {
  if (from?.latitude == null || from?.longitude == null || to?.latitude == null || to?.longitude == null) {
    return null;
  }
  const earthRadius = 6_371_000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(2 * earthRadius * Math.asin(Math.sqrt(a)));
}
