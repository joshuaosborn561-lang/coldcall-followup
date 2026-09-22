import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOOKBACK_MINUTES,
  SCHEDULE_INTERVAL_MINUTES,
  isWeekdayDaytime,
  shiftDate,
  weekendBacklog,
  zonedDayWindow,
  zonedLookbackWindow,
  zonedParts,
} from '../lib/time.js';

const ET = 'America/New_York';

// 2026-07-31 is a Friday, 2026-08-03 the following Monday.

test('the Monday backlog covers Friday through Sunday', () => {
  const monday8am = new Date('2026-08-03T12:00:00Z'); // 08:00 ET
  assert.equal(zonedParts(monday8am, ET).weekday, 'Mon');

  const { from, through } = weekendBacklog(monday8am, ET);
  assert.equal(from, '2026-07-31', 'Friday');
  assert.equal(through, '2026-08-02', 'Sunday');
});

test('a Friday-through-Sunday window spans three whole Eastern days', () => {
  const w = zonedDayWindow('2026-07-31', ET, '2026-08-02');
  assert.equal(w.start.toISOString(), '2026-07-31T04:00:00.000Z', 'Friday 00:00 ET');
  assert.equal(w.end.toISOString(), '2026-08-03T04:00:00.000Z', 'Monday 00:00 ET');
  assert.equal((w.end - w.start) / 3600000, 72);
  assert.equal(w.label, '2026-07-31..2026-08-02');
});

test('a single-day window is unchanged when no range is given', () => {
  const w = zonedDayWindow('2026-07-30', ET);
  assert.equal((w.end - w.start) / 3600000, 24);
  assert.equal(w.label, '2026-07-30');
});

test('passing the same day twice is still one day', () => {
  const w = zonedDayWindow('2026-07-30', ET, '2026-07-30');
  assert.equal((w.end - w.start) / 3600000, 24);
  assert.equal(w.label, '2026-07-30');
});

test('a backwards range is rejected rather than silently empty', () => {
  assert.throws(() => zonedDayWindow('2026-08-02', ET, '2026-07-31'), /precedes/);
});

test('a backlog range crossing the fall DST change is 73 hours', () => {
  // Fri 2026-10-30 through Sun 2026-11-01; the clocks go back on the Sunday.
  const w = zonedDayWindow('2026-10-30', ET, '2026-11-01');
  assert.equal((w.end - w.start) / 3600000, 73);
});

test('shiftDate walks Eastern days, not 24-hour blocks', () => {
  const monday = new Date('2026-08-03T12:00:00Z');
  assert.equal(shiftDate(monday, -1, ET), '2026-08-02');
  assert.equal(shiftDate(monday, -3, ET), '2026-07-31');
  assert.equal(shiftDate(monday, 0, ET), '2026-08-03');

  // Across the spring-forward Sunday (2026-03-08), a naive -24h would slip.
  const monAfterDst = new Date('2026-03-09T12:00:00Z');
  assert.equal(shiftDate(monAfterDst, -1, ET), '2026-03-08');
  assert.equal(shiftDate(monAfterDst, -3, ET), '2026-03-06');
});

test('scheduled incremental runs use a short lookback, not a full day', () => {
  assert.equal(SCHEDULE_INTERVAL_MINUTES, 10);
  assert.equal(LOOKBACK_MINUTES, 20);
  const now = new Date('2026-09-22T18:40:00Z');
  const lookback = zonedLookbackWindow(LOOKBACK_MINUTES, ET, now);
  const fullDay = zonedDayWindow('2026-09-22', ET);
  assert.ok(lookback.end - lookback.start < fullDay.end - fullDay.start);
  assert.equal((lookback.end - lookback.start) / 60000, 20);
});

test('the 10-minute ticker does not run on weekends', () => {
  assert.equal(isWeekdayDaytime(new Date('2026-09-26T16:00:00Z'), ET), false); // Sat
  assert.equal(isWeekdayDaytime(new Date('2026-09-27T16:00:00Z'), ET), false); // Sun
});

test('the backlog lands on the right dates across the DST changeover', () => {
  const mondayAfterFallBack = new Date('2026-11-02T13:00:00Z'); // 08:00 EST
  assert.equal(zonedParts(mondayAfterFallBack, ET).weekday, 'Mon');
  const { from, through } = weekendBacklog(mondayAfterFallBack, ET);
  assert.equal(from, '2026-10-30');
  assert.equal(through, '2026-11-01');
});
