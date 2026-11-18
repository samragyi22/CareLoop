/**
 * Minimal IANA-timezone helpers built on Intl, so schedules can be defined in clinic-local
 * wall-clock time (e.g. 9:00 AM IST) without adding a date library.
 */

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const get = (type) => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Returns the calendar date (year, month 1-12, day) of `date` as seen in `timeZone`.
 */
export function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Converts a wall-clock time in `timeZone` to the corresponding UTC instant.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;

  // Re-check at the corrected instant in case it crossed a daylight-saving boundary
  const correctedOffset = getTimeZoneOffsetMs(new Date(result), timeZone);
  if (correctedOffset !== offset) {
    result = guess - correctedOffset;
  }
  return new Date(result);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Day of week (0 = Sunday ... 6 = Saturday) of `date` as seen in `timeZone`.
 */
export function weekdayInZone(date, timeZone) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return WEEKDAYS.indexOf(short);
}

/**
 * Parses "HH:MM" into { hour, minute }.
 */
export function parseClockTime(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return { hour, minute: minute || 0 };
}

/**
 * Returns the UTC instant for `hour:minute` local time, `dayOffset` calendar days from `from` in `timeZone`.
 */
export function localTimeOnDay({ from = new Date(), dayOffset = 0, hour, minute = 0, timeZone }) {
  const today = datePartsInZone(from, timeZone);
  // Date.UTC normalizes day overflow (e.g. day 32 -> next month)
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  return zonedTimeToUtc({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour,
    minute
  }, timeZone);
}

/**
 * Short human-readable date and time in the clinic's timezone, e.g. "Wed 22 Oct, 10:30 am".
 * Used in audit-log reasons and patient-facing text.
 */
export function formatClinicTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone
  }).format(new Date(date));
}
