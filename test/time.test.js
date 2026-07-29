import assert from 'node:assert/strict';
import test from 'node:test';

import { isSendWindow, isWeekend, zonedDayWindow, zonedParts } from '../lib/time.js';
import { findContact, phoneKeys } from '../lib/allo.js';

const ET = 'America/New_York';

test('day window during EDT is midnight-to-midnight Eastern', () => {
  const w = zonedDayWindow('2026-07-28', ET);
  assert.equal(w.start.toISOString(), '2026-07-28T04:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-07-29T04:00:00.000Z');
  assert.equal(w.label, '2026-07-28');
});

test('day window during EST is midnight-to-midnight Eastern', () => {
  const w = zonedDayWindow('2026-01-15', ET);
  assert.equal(w.start.toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-01-16T05:00:00.000Z');
});

test('spring-forward day is 23 hours long, not 24', () => {
  const w = zonedDayWindow('2026-03-08', ET);
  assert.equal(w.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal((w.end - w.start) / 3600000, 23);
});

test('fall-back day is 25 hours long', () => {
  const w = zonedDayWindow('2026-11-01', ET);
  assert.equal(w.start.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal((w.end - w.start) / 3600000, 25);
});

test('exactly one of the two daily cron firings is inside the send window', () => {
  // Summer (EDT, UTC-4): 20:30Z is 16:30 ET.
  assert.equal(isSendWindow(new Date('2026-07-28T20:30:00Z'), ET), true);
  assert.equal(isSendWindow(new Date('2026-07-28T21:30:00Z'), ET), false);

  // Winter (EST, UTC-5): 21:30Z is 16:30 ET.
  assert.equal(isSendWindow(new Date('2026-01-15T20:30:00Z'), ET), false);
  assert.equal(isSendWindow(new Date('2026-01-15T21:30:00Z'), ET), true);

  // Day before and after each DST switch.
  assert.equal(isSendWindow(new Date('2026-03-07T21:30:00Z'), ET), true); // still EST
  assert.equal(isSendWindow(new Date('2026-03-09T20:30:00Z'), ET), true); // now EDT
  assert.equal(isSendWindow(new Date('2026-10-31T20:30:00Z'), ET), true); // still EDT
  assert.equal(isSendWindow(new Date('2026-11-02T21:30:00Z'), ET), true); // now EST
});

test('a full year of firings sends on exactly one of the two crons each day', () => {
  let day = Date.UTC(2026, 0, 1);
  const oneDay = 86400000;
  while (day < Date.UTC(2027, 0, 1)) {
    const d = new Date(day);
    const early = new Date(`${d.toISOString().slice(0, 10)}T20:30:00Z`);
    const late = new Date(`${d.toISOString().slice(0, 10)}T21:30:00Z`);
    const hits = [isSendWindow(early, ET), isSendWindow(late, ET)].filter(Boolean).length;
    assert.equal(hits, 1, `expected exactly one send on ${d.toISOString().slice(0, 10)}, got ${hits}`);
    day += oneDay;
  }
});

test('zonedParts reports Eastern wall clock', () => {
  const p = zonedParts(new Date('2026-07-28T20:30:00Z'), ET);
  assert.equal(p.hour, 16);
  assert.equal(p.minute, 30);
  assert.equal(p.date, '2026-07-28');
  assert.equal(p.weekday, 'Tue');
});

test('weekend detection uses Eastern, not UTC', () => {
  // Saturday 01:00 UTC is still Friday evening in ET -- the job should run.
  assert.equal(isWeekend(new Date('2026-07-25T01:00:00Z'), ET), false);
  assert.equal(isWeekend(new Date('2026-07-24T20:30:00Z'), ET), false); // Fri ET
  assert.equal(isWeekend(new Date('2026-07-25T20:30:00Z'), ET), true); // Sat ET
  assert.equal(isWeekend(new Date('2026-07-26T20:30:00Z'), ET), true); // Sun ET
  assert.equal(isWeekend(new Date('2026-07-27T20:30:00Z'), ET), false); // Mon ET
});

test('phone matching tolerates formatting differences', () => {
  const index = new Map();
  const contact = { id: 'cnt_1', emails: ['a@b.com'], numbers: ['+1 (555) 010-2030'] };
  for (const key of phoneKeys('+1 (555) 010-2030')) index.set(key, contact);

  assert.equal(findContact(index, '+15550102030')?.id, 'cnt_1');
  assert.equal(findContact(index, '5550102030')?.id, 'cnt_1');
  assert.equal(findContact(index, '555-010-2030')?.id, 'cnt_1');
  assert.equal(findContact(index, '+15550109999'), null);
  assert.equal(findContact(index, ''), null);
});
