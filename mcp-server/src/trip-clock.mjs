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

/**
 * Everything wrong with a plan, from the rows a plan is made of: overlaps, items never placed on a
 * day, high-priority places left off the itinerary, volatile research gone stale, and gaps below
 * the trip's own configured buffer.
 *
 * `getPlanOverview` computes this for the dashboard and the companion computes it on the phone, so
 * it lives here rather than in the read model — an itinerary that shows two issues in Claude and
 * four on the phone is a worse failure than showing none at all.
 */
export function planIssues({
  items = [],
  tripPlaces = [],
  research = [],
  timezone,
  minimumBufferMinutes = null,
  at = new Date()
} = {}) {
  const now = validInstant(at, 'at_time');
  const issues = overlapIssues(items, timezone);
  for (const item of activeScheduledItems(items)) {
    if (['planned', 'confirmed'].includes(item.status) && !item.planned_start) {
      issues.push({
        id: stableIssueId('missing_start', [item.id]), type: 'missing_start', severity: 'warning',
        title: 'Planned item has no start time', detail: `${item.title} is not placed on a day.`, date: null, item_ids: [item.id]
      });
    }
  }
  for (const link of unscheduledTripPlaces(items, tripPlaces).filter((place) => place.priority === 5)) {
    issues.push({
      id: stableIssueId('high_priority_unscheduled', [link.place_id]), type: 'high_priority_unscheduled', severity: 'warning',
      title: 'High-priority saved place is unscheduled', detail: `${link.places?.name ?? 'Saved place'} is not on the itinerary.`,
      date: null, item_ids: [], place_ids: [link.place_id]
    });
  }
  for (const placeId of scheduledPlaceIds(items)) {
    const placeResearch = research.filter((entry) => entry.place_id === placeId);
    if (placeResearch.some((entry) => entry.volatility === 'volatile') && researchFreshness(placeResearch, now) === 'stale') {
      const itemIds = items.filter((item) => item.place_id === placeId).map((item) => item.id);
      issues.push({
        id: stableIssueId('stale_volatile_research', itemIds), type: 'stale_volatile_research', severity: 'warning',
        title: 'Planned place has stale volatile research', detail: 'Time-sensitive research should be refreshed before relying on it.',
        date: null, item_ids: itemIds, place_ids: [placeId]
      });
    }
  }
  const buffer = Number(minimumBufferMinutes);
  if (Number.isFinite(buffer) && buffer > 0) {
    const timed = sortedTimeline(activeScheduledItems(items)).filter((item) => item.planned_start && item.planned_end);
    for (let index = 0; index < timed.length - 1; index += 1) {
      const gap = (new Date(timed[index + 1].planned_start) - new Date(timed[index].planned_end)) / 60_000;
      if (gap >= 0 && gap < buffer) {
        const date = localDateTime(timed[index].planned_start, timezone).date;
        issues.push({
          id: stableIssueId('insufficient_buffer', [timed[index].id, timed[index + 1].id], date),
          type: 'insufficient_buffer', severity: 'warning', title: 'Configured schedule buffer is too short',
          detail: `${Math.round(gap)} minutes is below the configured ${buffer}-minute minimum.`,
          date, item_ids: [timed[index].id, timed[index + 1].id]
        });
      }
    }
  }
  return issues;
}

/** Place ids something live on the itinerary points at. */
export function scheduledPlaceIds(items) {
  return new Set(activeScheduledItems(items).filter((item) => item.place_id).map((item) => item.place_id));
}

/** Shortlisted places with nothing on the itinerary pointing at them — the unscheduled tray. */
export function unscheduledTripPlaces(items, tripPlaces = []) {
  const scheduled = scheduledPlaceIds(items);
  return tripPlaces.filter((link) => link.status === 'shortlist' && !scheduled.has(link.place_id));
}

/**
 * The trip as a list of days: trip dates widened to cover anything scheduled outside them, each
 * with its items in order, the areas they sit in, its fixed anchors, and how many issues bite on
 * it. Day grouping is in the trip's zone, always.
 */
export function planDays({
  items = [],
  reservations = [],
  tripPlaces = [],
  issues = [],
  timezone,
  startDate = null,
  endDate = null
} = {}) {
  const dates = dateRange(startDate, endDate);
  for (const item of items) {
    if (!item.planned_start) continue;
    const date = localDateTime(item.planned_start, timezone).date;
    if (!dates.includes(date)) dates.push(date);
  }
  dates.sort();
  const placeById = new Map(tripPlaces.map((link) => [link.place_id, link.places]));
  return dates.map((date) => {
    const dayItems = items.filter((item) => item.planned_start && localDateTime(item.planned_start, timezone).date === date);
    const areas = [...new Set(dayItems.map((item) => placeById.get(item.place_id)?.locality ?? placeById.get(item.place_id)?.region).filter(Boolean))];
    const fixedReservations = reservations.filter(
      (reservation) => reservation.reserved_start && localDateTime(reservation.reserved_start, timezone).date === date
    );
    return {
      date,
      area: areas.length ? areas.join(' / ') : null,
      items: sortedTimeline(dayItems),
      fixed_anchors: [...dayItems.filter((item) => item.flexibility === 'fixed'), ...fixedReservations],
      issue_count: issues.filter((issue) => issue.date === date || issue.item_ids?.some((id) => dayItems.some((item) => item.id === id))).length
    };
  });
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
