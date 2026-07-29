/**
 * Timezone helpers.
 *
 * Vercel cron only speaks UTC, but the job has to land at 4:30pm *Eastern*,
 * which moves against UTC twice a year. The scheme:
 *
 *   - vercel.json fires /api/cron at BOTH 20:30 and 21:30 UTC.
 *   - During EDT (UTC-4): 20:30 -> 16:30 ET, 21:30 -> 17:30 ET.
 *   - During EST (UTC-5): 20:30 -> 15:30 ET, 21:30 -> 16:30 ET.
 *
 * So exactly one of the two firings is at 16:30 ET on any given day. The
 * handler calls isSendWindow() and the other firing exits as a no-op.
 */

export const TZ = process.env.RUN_TIMEZONE || 'America/New_York';
export const SEND_HOUR = Number(process.env.SEND_HOUR ?? 16);

/**
 * Offset of `tz` from UTC at the given instant, in milliseconds.
 * Positive east of Greenwich (so America/New_York returns a negative number).
 */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const p = {};
  for (const { type, value } of parts) p[type] = value;

  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  // Round to the second: formatToParts drops milliseconds.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock fields in `tz` for a given instant. */
export function zonedParts(date = new Date(), tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);

  const p = {};
  for (const { type, value } of parts) p[type] = value;

  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: p.weekday, // "Mon", "Tue", ...
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * Convert a wall-clock time in `tz` to the UTC instant it represents.
 * Guesses, then corrects using the offset actually in effect at the guess.
 */
function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = tzOffsetMs(new Date(guess), tz);
  let ts = guess - firstOffset;
  const secondOffset = tzOffsetMs(new Date(ts), tz);
  if (secondOffset !== firstOffset) ts = guess - secondOffset;
  return new Date(ts);
}

/**
 * The [start, end) UTC instants bounding a calendar day in `tz`.
 * `dateStr` is YYYY-MM-DD in that zone; defaults to today there.
 */
export function zonedDayWindow(dateStr, tz = TZ) {
  let year;
  let month;
  let day;

  if (dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!m) throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
    [, year, month, day] = m.map(Number);
  } else {
    ({ year, month, day } = zonedParts(new Date(), tz));
  }

  const start = zonedToUtc(year, month, day, 0, 0, tz);
  // Add 26h then re-floor, so DST transition days still land on the next midnight.
  const nextDay = zonedParts(new Date(start.getTime() + 26 * 3600 * 1000), tz);
  const end = zonedToUtc(nextDay.year, nextDay.month, nextDay.day, 0, 0, tz);

  const pad = (n) => String(n).padStart(2, '0');
  return { start, end, label: `${year}-${pad(month)}-${pad(day)}`, tz };
}

/**
 * True when "now" in `tz` is inside the send hour. Both daily cron firings hit
 * this; only the one that is actually 4:30pm ET passes.
 */
export function isSendWindow(now = new Date(), tz = TZ) {
  const { hour } = zonedParts(now, tz);
  return hour === SEND_HOUR;
}

/** Sat/Sun in `tz`. */
export function isWeekend(now = new Date(), tz = TZ) {
  const { weekday } = zonedParts(now, tz);
  return weekday === 'Sat' || weekday === 'Sun';
}
