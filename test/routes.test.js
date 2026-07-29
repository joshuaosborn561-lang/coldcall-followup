import assert from 'node:assert/strict';
import test from 'node:test';

import { RouteConfigError, normalizeNumber, parseRouteSpec } from '../lib/routes.js';
import { dedupeAcrossRoutes } from '../lib/pipeline.js';

test('parses one route per rep', () => {
  const routes = parseRouteSpec('+15550101010:12345:Josh,+15550202020:67890:Cayden');
  assert.deepEqual(routes, [
    { number: '+15550101010', campaignId: '12345', label: 'Josh' },
    { number: '+15550202020', campaignId: '67890', label: 'Cayden' },
  ]);
});

test('label is optional and falls back to the number', () => {
  const [route] = parseRouteSpec('+15550101010:12345');
  assert.equal(route.label, '+15550101010');
  assert.equal(route.campaignId, '12345');
});

test('tolerates human phone formatting and whitespace', () => {
  const routes = parseRouteSpec(' (555) 010-1010 : 12345 : Josh , +1 555 020 2020:67890:Cayden ');
  assert.equal(routes[0].number, '+5550101010');
  assert.equal(routes[0].label, 'Josh');
  assert.equal(routes[1].number, '+15550202020');
});

test('normalizeNumber makes config and Allo responses comparable', () => {
  assert.equal(normalizeNumber('+1 (555) 010-2030'), '+15550102030');
  assert.equal(normalizeNumber('15550102030'), '+15550102030');
  assert.equal(normalizeNumber(''), '');
  assert.equal(normalizeNumber(null), '');
});

test('the same number cannot feed two campaigns', () => {
  assert.throws(
    () => parseRouteSpec('+15550101010:12345:Josh,+15550101010:67890:Cayden'),
    (err) => err instanceof RouteConfigError && /listed twice/.test(err.message)
  );
});

test('malformed entries fail loudly rather than misrouting', () => {
  // A typo here would send one rep's prospects into the other's campaign,
  // so every one of these must throw rather than guess.
  assert.throws(() => parseRouteSpec('+15550101010'), RouteConfigError);
  assert.throws(() => parseRouteSpec('Josh:12345'), RouteConfigError);
  assert.throws(() => parseRouteSpec('+15550101010:'), RouteConfigError);
  assert.throws(() => parseRouteSpec('+15550101010:not a campaign'), RouteConfigError);
  assert.throws(() => parseRouteSpec('   '), RouteConfigError);
});

test('error message names the offending entry', () => {
  try {
    parseRouteSpec('+15550101010:12345:Josh,garbage');
    assert.fail('expected a throw');
  } catch (err) {
    assert.match(err.message, /garbage/);
  }
});

// --- cross-rep dedupe -------------------------------------------------------

const JOSH = { number: '+15550101010', campaignId: '12345', label: 'Josh' };
const CAYDEN = { number: '+15550202020', campaignId: '67890', label: 'Cayden' };

const entry = (email, route, startDate) => ({
  email,
  route,
  contact: { id: `cnt_${email}` },
  call: { id: `call_${email}_${startDate}`, start_date: startDate },
});

test('each rep keeps their own prospects', () => {
  const { byEmail, collisions } = dedupeAcrossRoutes([
    entry('a@x.com', JOSH, '2026-07-28T14:00:00Z'),
    entry('b@x.com', CAYDEN, '2026-07-28T15:00:00Z'),
  ]);
  assert.equal(byEmail.size, 2);
  assert.equal(collisions.length, 0);
  assert.equal(byEmail.get('a@x.com').route.label, 'Josh');
  assert.equal(byEmail.get('b@x.com').route.label, 'Cayden');
});

test('a prospect both reps called gets one follow-up, from whoever called last', () => {
  const { byEmail, collisions } = dedupeAcrossRoutes([
    entry('shared@x.com', JOSH, '2026-07-28T14:00:00Z'),
    entry('shared@x.com', CAYDEN, '2026-07-28T16:30:00Z'),
  ]);

  assert.equal(byEmail.size, 1, 'must not be added to both campaigns');
  assert.equal(byEmail.get('shared@x.com').route.label, 'Cayden');
  assert.equal(byEmail.get('shared@x.com').route.campaignId, '67890');
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].assignedTo, 'Cayden');
});

test('order of arrival does not change who wins', () => {
  const later = entry('shared@x.com', JOSH, '2026-07-28T17:00:00Z');
  const earlier = entry('shared@x.com', CAYDEN, '2026-07-28T09:00:00Z');

  for (const order of [[later, earlier], [earlier, later]]) {
    const { byEmail, collisions } = dedupeAcrossRoutes(order);
    assert.equal(byEmail.get('shared@x.com').route.label, 'Josh');
    assert.equal(collisions.length, 1);
  }
});

test('the same rep calling twice is not a collision', () => {
  const { byEmail, collisions } = dedupeAcrossRoutes([
    entry('a@x.com', JOSH, '2026-07-28T09:00:00Z'),
    entry('a@x.com', JOSH, '2026-07-28T16:00:00Z'),
  ]);
  assert.equal(byEmail.size, 1);
  assert.equal(collisions.length, 0);
  assert.equal(byEmail.get('a@x.com').call.start_date, '2026-07-28T16:00:00Z');
});

test('email casing does not create a duplicate lead', () => {
  const { byEmail } = dedupeAcrossRoutes([
    entry('Sam@X.com', JOSH, '2026-07-28T09:00:00Z'),
    entry('sam@x.com', CAYDEN, '2026-07-28T10:00:00Z'),
  ]);
  assert.equal(byEmail.size, 1);
});
