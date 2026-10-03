import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, usePostcallStore } from '../lib/postcall/store.js';
import { runPostcall, handleReply } from '../lib/postcall/pipeline.js';
import { pickInbox } from '../lib/postcall/inboxes.js';
import { assertCampaignIsolation } from '../lib/postcall/sender.js';
import { decideThread } from '../lib/postcall/thread.js';
import { evaluateStops } from '../lib/postcall/stop.js';
import { mergeTemplate, newThreadSubject, templateSendable } from '../lib/postcall/templates.js';
import { callerFromCall, clientFromPerson } from '../lib/postcall/match.js';
import { buildDailyReport } from '../lib/postcall/report.js';

function seedStore(overrides = {}) {
  const configs = [
    {
      id: 'c-cayden-sg',
      caller: 'cayden',
      allo_user_name: 'Cayden Martini',
      client: 'salesglider',
      allo_list_prefix: 'SalesGlider',
      booking_link: 'https://book.gosalesglider.com/salesglider',
      signature_company: 'SalesGlider',
      send_enabled: false,
      smartlead_campaign_id: 3739316,
    },
    {
      id: 'c-gabe-sg',
      caller: 'gabe',
      allo_user_name: 'Gabe Lopez',
      client: 'salesglider',
      allo_list_prefix: 'SalesGlider',
      booking_link: 'https://book.gosalesglider.com/salesglider',
      signature_company: 'SalesGlider',
      send_enabled: true,
      smartlead_campaign_id: 4074264,
    },
    {
      id: 'c-gabe-em',
      caller: 'gabe',
      allo_user_name: 'Gabe Lopez',
      client: 'emcor',
      allo_list_prefix: 'EMCOR',
      booking_link: 'https://book.gosalesglider.com/emcor',
      signature_company: 'Mesa Energy',
      send_enabled: true,
      smartlead_campaign_id: 4074265,
    },
  ];
  const templates = [
    { config_id: 'c-gabe-sg', kind: 'new_thread', status: 'approved', subject: 'a quick follow-up', body: 'Tried {{company_name}}. {{booking_link}}\n{{signature}}' },
    { config_id: 'c-gabe-sg', kind: 'reply', status: 'approved', subject: 'following up on my voicemail', body: '{{first_name}} again. {{booking_link}}' },
    { config_id: 'c-gabe-em', kind: 'new_thread', status: 'draft', subject: 'emcor draft', body: 'draft {{booking_link}}' },
    { config_id: 'c-gabe-em', kind: 'reply', status: 'draft', subject: 'emcor reply', body: 'draft reply' },
    { config_id: 'c-cayden-sg', kind: 'new_thread', status: 'approved', subject: 'cayden', body: 'should not send' },
    { config_id: 'c-cayden-sg', kind: 'reply', status: 'approved', subject: 'cayden reply', body: 'should not send' },
  ];
  const inboxes = [
    { config_id: 'c-cayden-sg', email: 'cayden.sg@example.com', caller: 'cayden', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
    { config_id: 'c-gabe-sg', email: 'gabe.sg.1@example.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
    { config_id: 'c-gabe-sg', email: 'gabe.sg.2@example.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
    { config_id: 'c-gabe-em', email: 'gabe.emcor@example.com', caller: 'gabe', client: 'emcor', healthy: true, max_sends_per_day: 35 },
  ];
  const store = createMemoryStore({ configs, templates, inboxes, ...overrides });
  usePostcallStore(store);
  return store;
}

function vm({ name = 'Gabe Lopez', lists = ['SalesGlider | Pacific'], email = 'a@x.com', extraCall = {}, extraPerson = {} } = {}) {
  return {
    email,
    first_name: 'Alex',
    company_name: 'Acme Roofing',
    person: { lists, emails: [email], ...extraPerson },
    call: {
      id: `cll-${email}`,
      result: 'VOICEMAIL',
      summary: 'Left a voicemail',
      contact_number: '+15555550100',
      user: { name },
      ...extraCall,
    },
  };
}

describe('postcall matching', () => {
  it('maps Allo user name to caller and list prefix to client', () => {
    const configs = [
      { caller: 'gabe', allo_user_name: 'Gabe Lopez', client: 'emcor', allo_list_prefix: 'EMCOR' },
    ];
    assert.equal(callerFromCall({ user: { name: 'Gabe Lopez' } }, configs), 'gabe');
    assert.equal(clientFromPerson({ lists: ['EMCOR | Pacific'] }, configs), 'emcor');
    assert.equal(clientFromPerson({ lists: ['SalesGlider | Eastern'] }, configs), null);
  });
});

describe('templates', () => {
  it('merges fields and prefixes the first-email subject', () => {
    const out = mergeTemplate(
      { subject: 'a quick follow-up', body: 'Hi {{first_name}} at {{company_name}} {{booking_link}} {{signature}}' },
      { first_name: 'Alex', company_name: 'Acme', booking_link: 'https://book.gosalesglider.com/emcor', signature: 'Gabe\nMesa Energy' }
    );
    assert.equal(newThreadSubject(out.subject), 'Per my voicemail: a quick follow-up');
    assert.match(out.body, /Acme/);
    assert.match(out.body, /Mesa Energy/);
  });

  it('blocks live send when the template is still draft', () => {
    assert.equal(templateSendable({ status: 'draft' }).ok, false);
    assert.equal(templateSendable({ status: 'approved' }).ok, true);
  });
});

describe('inbox pool', () => {
  const pool = [
    { email: 'gabe.sg.1@example.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
    { email: 'gabe.sg.2@example.com', caller: 'gabe', client: 'salesglider', healthy: true, max_sends_per_day: 35 },
  ];

  it('is sticky for a known contact', () => {
    const picked = pickInbox({ pool, contact: { inbox: 'gabe.sg.2@example.com' }, dailyCounts: {} });
    assert.equal(picked.inbox, 'gabe.sg.2@example.com');
    assert.equal(picked.sticky, true);
  });

  it('round-robins new contacts and queues when every inbox is at cap', () => {
    const a = pickInbox({ pool, dailyCounts: {}, roundRobinIndex: 0 });
    const b = pickInbox({ pool, dailyCounts: {}, roundRobinIndex: 1 });
    assert.notEqual(a.inbox, b.inbox);
    const capped = pickInbox({
      pool,
      dailyCounts: { 'gabe.sg.1@example.com': 35, 'gabe.sg.2@example.com': 35 },
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.queue, true);
  });
});

describe('threading', () => {
  it('starts a new thread and later replies on the same ids', () => {
    assert.equal(decideThread(null).mode, 'new_thread');
    const second = decideThread({ thread_id: 't1', last_message_id: '<m1>' });
    assert.equal(second.mode, 'reply');
    assert.equal(second.inReplyTo, '<m1>');
  });

  it('never threads onto a Smartlead campaign thread', () => {
    const decision = decideThread({ thread_id: 'sl-1', last_message_id: '<sl>', source: 'smartlead' });
    assert.equal(decision.mode, 'new_thread');
    assert.equal(decision.reason, 'do_not_thread_smartlead');
  });
});

describe('stop rules', () => {
  it('skips replies, unsubscribes, suppression, DNC, and pauses after 3 attempts', () => {
    assert.equal(evaluateStops({ contact: { status: 'replied' } }).skip, true);
    assert.equal(evaluateStops({ suppression: true }).reasons.includes('global_suppression'), true);
    assert.equal(evaluateStops({ alloPerson: { do_not_contact: true } }).reasons.includes('allo_dnc'), true);
    assert.equal(evaluateStops({ campaignLead: { replied: true } }).reasons.includes('replied_to_campaign'), true);
    const third = evaluateStops({ contact: { send_count: 3 } });
    assert.equal(third.pause, true);
  });
});

describe('pipeline', () => {
  it('sends Gabe a new thread then a reply on the same inbox and thread', async () => {
    seedStore();
    const item = vm();
    const first = await runPostcall({ items: [item], dryRun: true });
    assert.equal(first.results[0].sent, true);
    assert.equal(first.results[0].kind, 'new_thread');
    assert.match(first.results[0].subject, /^Per my voicemail:/);
    assert.match(first.results[0].body, /^Per my voicemail/i);
    assert.equal(first.results[0].inbox.startsWith('gabe.sg.'), true);
    assert.equal(first.results[0].campaignId, 4074264);
    assert.equal(first.results[0].provider, 'smartlead');

    const second = await runPostcall({
      items: [{ ...item, call: { ...item.call, id: `${item.call.id}-followup` } }],
      dryRun: true,
    });
    assert.equal(second.results[0].kind, 'reply');
    assert.equal(second.results[0].inbox, first.results[0].inbox);
    assert.equal(second.results[0].threadId, first.results[0].threadId);
    assert.equal(second.results[0].headers['In-Reply-To'], first.results[0].messageId);
  });

  it('does not send for Cayden even with an approved template (Smartlead path stays the live one)', async () => {
    seedStore();
    const out = await runPostcall({
      items: [vm({ name: 'Cayden Martini', email: 'cayden-control@x.com' })],
      dryRun: true,
    });
    assert.equal(out.results[0].sent, undefined);
    assert.equal(out.results[0].reason, 'cayden_uses_existing_smartlead');
  });

  it('does not borrow another caller or client inbox', async () => {
    seedStore();
    const out = await runPostcall({
      items: [vm({ lists: ['EMCOR | Mountain'], email: 'em@x.com' })],
      dryRun: true,
      allowDraft: true,
    });
    assert.equal(out.results[0].client, 'emcor');
    assert.equal(out.results[0].inbox, 'gabe.emcor@example.com');
  });

  it('refuses a live send when the template is draft', async () => {
    seedStore();
    const out = await runPostcall({
      items: [vm({ lists: ['EMCOR | Mountain'], email: 'em2@x.com' })],
      dryRun: false,
    });
    assert.equal(out.results[0].reason, 'template_not_approved');
  });

  it('alerts and skips when no config row matches', async () => {
    seedStore();
    const out = await runPostcall({
      items: [vm({ name: 'Unknown Rep', lists: ['Other | Eastern'], email: 'z@x.com' })],
      dryRun: true,
    });
    assert.equal(out.results[0].reason, 'no_config_match');
  });

  it('stops automation and logs a reply', async () => {
    const store = seedStore();
    const item = vm({ email: 'reply@x.com' });
    await runPostcall({ items: [item], dryRun: true });
    const reply = await handleReply({ caller: 'gabe', client: 'salesglider', email: 'reply@x.com', snippet: 'Sure, Tuesday works', dryRun: true });
    assert.equal(reply.stopped, true);
    const contact = await store.getContact('gabe', 'salesglider', 'reply@x.com');
    assert.equal(contact.status, 'replied');
    const again = await runPostcall({
      items: [{ ...item, call: { ...item.call, id: `${item.call.id}-again` } }],
      dryRun: true,
    });
    assert.equal(again.results[0].reason.includes('replied_to_caller'), true);
  });
});

describe('smartlead isolation', () => {
  it('never lets Gabe send through Cayden campaign 3739316', () => {
    const blocked = assertCampaignIsolation({ caller: 'gabe', campaignId: 3739316, allowedCampaignId: 4074264 });
    assert.equal(blocked.ok, false);
    const ok = assertCampaignIsolation({ caller: 'gabe', campaignId: 4074264, allowedCampaignId: 4074264 });
    assert.equal(ok.ok, true);
  });
});

describe('daily report', () => {
  it('groups by caller and client', () => {
    const report = buildDailyReport({
      day: '2026-10-03',
      events: [
        { caller: 'gabe', client: 'emcor', action: 'sent', dry_run: false },
        { caller: 'gabe', client: 'emcor', action: 'skipped', reason: 'template_not_approved' },
        { caller: 'gabe', client: 'salesglider', action: 'queued' },
        { caller: 'gabe', client: 'salesglider', action: 'reply' },
      ],
      bookings: [{ client_slug: 'emcor', caller: 'gabe' }],
    });
    assert.match(report.text, /gabe \/ emcor/);
    assert.match(report.text, /meetings 1/);
    assert.match(report.text, /replies 1/);
  });
});
