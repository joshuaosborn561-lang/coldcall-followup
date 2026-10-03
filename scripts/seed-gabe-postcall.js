/**
 * Dry-run Gabe's config against the 5 Josh-controlled seed contacts.
 * Writes events, sends nothing. Shows inbox, subject, and that email 2 threads.
 *
 *   node scripts/seed-gabe-postcall.js
 */

import { createMemoryStore, usePostcallStore } from '../lib/postcall/store.js';
import { runPostcall } from '../lib/postcall/pipeline.js';

const PREFIX = {
  salesglider: 'SalesGlider',
  emcor: 'EMCOR',
  deep_roots: 'Deep Roots',
};

const BOOKING = {
  salesglider: 'https://book.gosalesglider.com/salesglider',
  emcor: 'https://book.gosalesglider.com/emcor',
  deep_roots: 'https://book.gosalesglider.com/deeproots',
};

const SIGNATURE = {
  salesglider: 'SalesGlider',
  emcor: 'Mesa Energy',
  deep_roots: '',
};

const CAMPAIGN = {
  'cayden:salesglider': 3739316,
  'gabe:salesglider': 4074264,
  'gabe:emcor': 4074265,
  'gabe:deep_roots': 4074266,
};

function cfg(id, caller, client, sendEnabled) {
  return {
    id,
    caller,
    allo_user_name: caller === 'gabe' ? 'Gabe Lopez' : 'Cayden Martini',
    client,
    allo_list_prefix: PREFIX[client],
    booking_link: BOOKING[client],
    signature_company: SIGNATURE[client],
    send_enabled: sendEnabled,
    smartlead_campaign_id: CAMPAIGN[`${caller}:${client}`],
  };
}

const configs = [
  cfg('c-cayden-sg', 'cayden', 'salesglider', false),
  cfg('c-gabe-sg', 'gabe', 'salesglider', true),
  cfg('c-gabe-em', 'gabe', 'emcor', true),
  cfg('c-gabe-dr', 'gabe', 'deep_roots', true),
];

const templates = configs.flatMap((c) => [
  {
    config_id: c.id,
    kind: 'new_thread',
    status: 'draft',
    subject: 'a quick follow-up',
    body: 'I tried you about helping {{company_name}}. {{booking_link}}\n\n{{signature}}',
  },
  {
    config_id: c.id,
    kind: 'reply',
    status: 'draft',
    subject: 'following up on my voicemail',
    body: '{{first_name}} — circling back. {{booking_link}}\n\n{{signature}}',
  },
]);

const inboxes = [
  { config_id: 'c-cayden-sg', email: 'cayden.salesglider.1@salesglidergrowth.com', caller: 'cayden', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-cayden-sg', email: 'cayden.salesglider.2@salesglidergrowth.com', caller: 'cayden', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-sg', email: 'gabe.salesglider.1@salesglidergrowth.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-sg', email: 'gabe.salesglider.2@salesglidergrowth.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-em', email: 'gabe.emcor.1@mesaenergymail.com', caller: 'gabe', client: 'emcor', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-em', email: 'gabe.emcor.2@mesaenergymail.com', caller: 'gabe', client: 'emcor', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-dr', email: 'gabe.deeproots.1@deeprootsmail.com', caller: 'gabe', client: 'deep_roots', healthy: true, max_sends_per_day: 35 },
  { config_id: 'c-gabe-dr', email: 'gabe.deeproots.2@deeprootsmail.com', caller: 'gabe', client: 'deep_roots', healthy: true, max_sends_per_day: 35 },
];

const seeds = [
  { caller: 'gabe', client: 'salesglider', email: 'joshuaosborn561+sg1@gmail.com', first_name: 'Josh', company_name: 'Seed SG 1' },
  { caller: 'gabe', client: 'salesglider', email: 'joshuaosborn561+sg2@gmail.com', first_name: 'Josh', company_name: 'Seed SG 2' },
  { caller: 'gabe', client: 'emcor', email: 'joshuaosborn561+emcor1@gmail.com', first_name: 'Josh', company_name: 'Seed EMCOR 1' },
  { caller: 'gabe', client: 'emcor', email: 'joshua@salesglidergrowth.com', first_name: 'Josh', company_name: 'Seed EMCOR 2' },
  { caller: 'gabe', client: 'deep_roots', email: 'joshuaosborn561+deeproots@gmail.com', first_name: 'Josh', company_name: 'Seed Deep Roots' },
];

function asItem(seed, suffix = '') {
  return {
    caller: seed.caller,
    client: seed.client,
    email: seed.email,
    first_name: seed.first_name,
    company_name: seed.company_name,
    person: { lists: [`${PREFIX[seed.client]} | Eastern`] },
    call: {
      id: `seed-${seed.email}${suffix}`,
      result: 'VOICEMAIL',
      summary: 'Left a voicemail / answering machine',
      contact_number: '',
      user: { name: 'Gabe Lopez' },
    },
  };
}

const store = createMemoryStore({ configs, templates, inboxes, seeds });
usePostcallStore(store);

const caydenItem = {
  caller: 'cayden',
  client: 'salesglider',
  email: 'joshuaosborn561+cayden-control@gmail.com',
  first_name: 'Josh',
  company_name: 'Cayden control',
  person: { lists: ['SalesGlider | Eastern'] },
  call: {
    id: 'seed-cayden-control',
    result: 'VOICEMAIL',
    summary: 'Left a voicemail',
    user: { name: 'Cayden Martini' },
  },
};

const first = await runPostcall({ items: seeds.map((s) => asItem(s)), dryRun: true, allowDraft: true });
const second = await runPostcall({ items: seeds.map((s) => asItem(s, '-2')), dryRun: true, allowDraft: true });
const cayden = await runPostcall({ items: [caydenItem], dryRun: true, allowDraft: true });

const preview = first.results.map((a, i) => {
  const b = second.results[i];
  return {
    client: a.client,
    email: a.email,
    inbox1: a.inbox,
    inbox2: b.inbox,
    sameInbox: a.inbox === b.inbox,
    subject1: a.subject,
    subject2: b.subject,
    kind1: a.kind,
    kind2: b.kind,
    threadId: a.threadId,
    sameThread: a.threadId === b.threadId,
    inReplyTo: b.headers?.['In-Reply-To'] === a.messageId,
  };
});

console.log(JSON.stringify({
  dryRun: true,
  sentNothing: true,
  gabeFirst: { counts: first.counts, preview },
  caydenStillSkipped: cayden.results.map((r) => ({ reason: r.reason, sent: Boolean(r.sent) })),
}, null, 2));
