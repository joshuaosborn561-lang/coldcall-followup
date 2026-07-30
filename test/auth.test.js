import assert from 'node:assert/strict';
import test from 'node:test';

import { boolParam, isAuthorized, queryParam } from '../lib/auth.js';

const req = (url = '/api/run', authorization = undefined) => ({
  url,
  headers: authorization ? { authorization } : {},
});

function withSecret(value, fn) {
  const previous = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

test('no CRON_SECRET means the endpoints are open', () => {
  withSecret(undefined, () => {
    const result = isAuthorized(req());
    assert.equal(result.ok, true);
    assert.equal(result.open, true, 'handlers surface this so it is not silently public');
  });
});

test('an empty CRON_SECRET counts as unset, not as a secret of ""', () => {
  withSecret('', () => {
    assert.equal(isAuthorized(req()).ok, true);
  });
});

test('with CRON_SECRET set, a bearer token is accepted', () => {
  withSecret('s3cret', () => {
    const result = isAuthorized(req('/api/run', 'Bearer s3cret'));
    assert.equal(result.ok, true);
    assert.equal(result.open, false);
  });
});

test('with CRON_SECRET set, ?key= is accepted', () => {
  withSecret('s3cret', () => {
    assert.equal(isAuthorized(req('/api/run?key=s3cret')).ok, true);
  });
});

test('with CRON_SECRET set, wrong or missing credentials are rejected', () => {
  withSecret('s3cret', () => {
    assert.equal(isAuthorized(req()).ok, false);
    assert.equal(isAuthorized(req('/api/run?key=wrong')).ok, false);
    assert.equal(isAuthorized(req('/api/run', 'Bearer wrong')).ok, false);
    assert.equal(isAuthorized(req('/api/run', 's3cret')).ok, false, 'bare token without Bearer');
  });
});

test('a wrong-length credential does not throw', () => {
  // timingSafeEqual rejects buffers of differing length, so the guard matters.
  withSecret('s3cret', () => {
    assert.doesNotThrow(() => isAuthorized(req('/api/run?key=x')));
    assert.equal(isAuthorized(req('/api/run?key=x')).ok, false);
    assert.equal(isAuthorized(req('/api/run?key=s3cretwaytoolong')).ok, false);
  });
});

test('query parsing handles both the parsed and raw forms', () => {
  assert.equal(queryParam({ url: '/api/run?date=2026-07-30' }, 'date'), '2026-07-30');
  assert.equal(queryParam({ query: { date: '2026-07-30' } }, 'date'), '2026-07-30');
  assert.equal(queryParam({ query: { date: ['a', 'b'] } }, 'date'), 'a');
  assert.equal(queryParam({ url: '/api/run' }, 'date'), '');
});

test('boolParam accepts the usual truthy spellings', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes']) {
    assert.equal(boolParam({ url: `/api/run?dry=${v}` }, 'dry'), true, v);
  }
  for (const v of ['0', 'false', 'no', '']) {
    assert.equal(boolParam({ url: `/api/run?dry=${v}` }, 'dry'), false, v);
  }
  assert.equal(boolParam({ url: '/api/run' }, 'dry'), false);
});
