import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'followup-verdicts-'));
process.env.VERDICT_STORE_PATH = join(dir, 'verdicts.json');
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { __resetVerdictsForTests, lookupVerdict, markPending, markResults } = await import('../lib/verdicts.js');
const { shouldSkipEnrichment } = await import('../lib/gate.js');

test('rejected emails are recorded and skip later enrichment', async () => {
  __resetVerdictsForTests();
  await markResults({ runId: 'run-1', sendable: [], rejected: ['bad@x.com'] });
  const v = await lookupVerdict('Bad@X.com');
  assert.equal(v.status, 'rejected');
  assert.equal(await shouldSkipEnrichment({ email: 'bad@x.com' }), true);
});

test('sendable emails skip re-verification', async () => {
  __resetVerdictsForTests();
  await markResults({ runId: 'run-2', sendable: ['ok@y.com'], rejected: [] });
  assert.equal((await lookupVerdict('ok@y.com')).status, 'sendable');
  assert.equal(await shouldSkipEnrichment({ email: 'ok@y.com' }), true);
});

test('pending emails skip re-enrichment and re-verify', async () => {
  __resetVerdictsForTests();
  await markPending({
    emails: ['wait@z.com'],
    runId: 'run-3',
    leadsByEmail: { 'wait@z.com': { email: 'wait@z.com', phone_number: '+15551212' } },
  });
  assert.equal((await lookupVerdict('wait@z.com')).status, 'pending');
  assert.equal(await shouldSkipEnrichment({ email: 'wait@z.com' }), true);
  assert.equal(await shouldSkipEnrichment({ phone: '+1 (555) 1212' }), true);
});
