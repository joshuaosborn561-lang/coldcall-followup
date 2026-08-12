import assert from 'node:assert/strict';
import test from 'node:test';

import { collectEmails, normalizeEmail, pickBestEmail } from '../lib/emails.js';

test('normalizeEmail lowercases and rejects junk', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(normalizeEmail('mailto:bob@acme.io'), 'bob@acme.io');
  assert.equal(normalizeEmail('<carol@acme.io>'), 'carol@acme.io');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail('null'), null);
  assert.equal(normalizeEmail(''), null);
});

test('comma-joined Allo CRM strings expand to distinct valid emails', () => {
  assert.deepEqual(
    collectEmails('parsonsplumbing.dfw@gmail.com,parsonsplumbing.dfw@gmail.comp'),
    ['parsonsplumbing.dfw@gmail.com']
  );
  assert.deepEqual(collectEmails('alopez@eagleplumbing.us,eagleplumbing@yahoo.com'), [
    'alopez@eagleplumbing.us',
    'eagleplumbing@yahoo.com',
  ]);
  assert.deepEqual(
    collectEmails(['cindy@joypools.net,construction@joypools.net']),
    ['cindy@joypools.net', 'construction@joypools.net']
  );
});

test('pickBestEmail keeps the first valid address when no name is known', () => {
  assert.equal(
    pickBestEmail('billing@penningtonconcrete.com,billing@penningtontx.com'),
    'billing@penningtonconcrete.com'
  );
});

test('pickBestEmail prefers the address that matches the contact name', () => {
  assert.equal(
    pickBestEmail('courtney.dean@ratcliffconstructors.com,scott.trcka@ratcliffconstructors.com', {
      firstName: 'Scott',
      lastName: 'Trcka',
    }),
    'scott.trcka@ratcliffconstructors.com'
  );
  assert.equal(
    pickBestEmail('admin@jmpps.net,jillian.pittman@jmpps.net', {
      firstName: 'Jillian',
      lastName: 'Pittman',
    }),
    'jillian.pittman@jmpps.net'
  );
});

test('a single invalid comma blob yields null so enrichment can run', () => {
  assert.equal(pickBestEmail('not-an-email,also-bad'), null);
  assert.equal(pickBestEmail('foo@bar'), null);
});
