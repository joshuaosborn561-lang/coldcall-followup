import assert from 'node:assert/strict';
import test from 'node:test';

import { emailsToCsv, parseEmailCsv } from '../lib/verifier.js';

test('emailsToCsv lowercases, dedupes, and writes an Email header', () => {
  const { csv, count } = emailsToCsv(['A@X.com', 'a@x.com', 'b@y.com', '', 'not-an-email']);
  assert.equal(count, 2);
  assert.match(csv, /^Email\n/);
  assert.match(csv, /a@x.com/);
  assert.match(csv, /b@y.com/);
});

test('parseEmailCsv reads the Email column from a SENDABLE export', () => {
  const text = [
    'Email,verification_status,campaign_split',
    'ok@example.com,ok,other',
    '"Catch.All@Firm.com",ok,seg',
    '',
  ].join('\n');
  const emails = parseEmailCsv(text);
  assert.deepEqual(emails, ['ok@example.com', 'catch.all@firm.com']);
});

test('parseEmailCsv tolerates a missing header name by using the first column', () => {
  const emails = parseEmailCsv('foo\nperson@site.io\n');
  assert.deepEqual(emails, ['person@site.io']);
});
