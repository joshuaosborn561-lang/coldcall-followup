/**
 * Voicemail → config lookup → stop rules → inbox → thread → send/queue.
 * Cayden's Smartlead campaign path is a different module and is not invoked here.
 */

import { classifyFollowUp } from '../voicemail.js';
import { pickBestEmail } from '../emails.js';
import { buildPeopleIndex, fetchCallsInWindow, findPerson, listNumbers, phoneKeys } from '../allo.js';
import { callerFromCall, clientFromPerson, configFor } from './match.js';
import { pickInbox, assertPoolIsolation } from './inboxes.js';
import { evaluateStops } from './stop.js';
import { decideThread } from './thread.js';
import {
  mergeTemplate,
  newThreadSubject,
  ensureVoicemailOpen,
  templateSendable,
  signatureBlock,
} from './templates.js';
import { sendPostcallEmail, nextMorning } from './sender.js';
import { getPostcallStore } from './store.js';
import { postSlack, unmatchedAlert, capAlert, replyAlert } from './slack.js';

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function callerName(call, config) {
  return call?.user?.name || config?.allo_user_name || config?.caller || '';
}

function personEmail(person, firstName, lastName) {
  return pickBestEmail(person?.emails, { firstName, lastName }) || person?.email || null;
}

export async function handleReply({ caller, client, email, snippet, dryRun = false } = {}) {
  const store = getPostcallStore();
  const contact = await store.getContact(caller, client, email);
  await store.upsertContact({
    ...(contact || {}),
    caller,
    client,
    email,
    status: 'replied',
  });
  await store.logEvent({
    caller,
    client,
    email,
    action: 'reply',
    reason: 'prospect_replied',
    dry_run: dryRun,
    payload: { snippet: snippet || null },
  });
  const configs = await store.loadConfigs();
  const config = configFor(configs, caller, client);
  const slack = dryRun ? { sent: false, reason: 'dry_run' } : await postSlack(replyAlert({
    caller,
    client,
    email,
    mention: config?.slack_mention,
    snippet,
  }));
  return { ok: true, stopped: true, slack };
}

export async function processPostcallItem(item, options = {}) {
  const {
    dryRun = true,
    allowDraft = false,
    now = new Date(),
    store: storeOverride,
    configs: configsOverride,
  } = options;
  const store = storeOverride || getPostcallStore();
  const configs = configsOverride || (await store.loadConfigs());

  const call = item.call || item;
  const person = item.person || {};
  if (call.id && store.hasCallEvent && (await store.hasCallEvent(call.id))) {
    return { ok: true, skipped: true, reason: 'already_processed' };
  }
  const classification = classifyFollowUp(call);
  if (classification.kind !== 'voicemail') {
    return skip(store, item, 'not_voicemail_disposition', { dryRun, extra: { kind: classification.kind } });
  }

  const caller = item.caller || callerFromCall(call, configs);
  const forCaller = configs.filter((c) => c.caller === caller);
  const client = item.client || clientFromPerson(person, forCaller);
  const config = caller && client ? configFor(configs, caller, client) : null;

  await store.logEvent({
    caller: caller || null,
    client: client || null,
    email: item.email || personEmail(person),
    phone: call.contact_number || item.phone || null,
    allo_call_id: call.id || null,
    action: 'voicemail',
    reason: 'voicemail_logged',
    dry_run: dryRun,
  });

  if (!config) {
    const event = await store.logEvent({
      caller: caller || null,
      client: client || null,
      email: item.email || personEmail(person),
      phone: call.contact_number || item.phone || null,
      allo_call_id: call.id || null,
      action: 'skipped',
      reason: 'no_config_match',
      dry_run: dryRun,
      payload: { user: call.user || null, lists: person.lists || person.list_name || null },
    });
    const slack = dryRun ? { sent: false, reason: 'dry_run' } : await postSlack(unmatchedAlert({ call, caller, client }));
    return { ok: true, skipped: true, reason: 'no_config_match', slack, event };
  }

  if (config.caller === 'cayden' && config.send_enabled !== true) {
    return skip(store, { ...item, caller, client, config }, 'cayden_uses_existing_smartlead', { dryRun });
  }
  if (config.send_enabled !== true && !dryRun) {
    return skip(store, { ...item, caller, client, config }, 'send_disabled', { dryRun });
  }

  const firstName = item.first_name || person.first_name || person.name?.split?.(' ')?.[0] || '';
  const lastName = item.last_name || person.last_name || '';
  const email = String(item.email || personEmail(person, firstName, lastName) || '').trim().toLowerCase();
  if (!email) return skip(store, { ...item, caller, client, config }, 'no_email', { dryRun });

  const contact = (await store.getContact(caller, client, email)) || null;
  const suppression = await store.isSuppressed(email);
  const campaignLead = await store.campaignLead(email);
  const stops = evaluateStops({
    contact,
    alloPerson: person,
    suppression,
    campaignLead,
    campaignReplied: Boolean(campaignLead?.replied),
  });
  if (stops.skip) {
    if (stops.pause) {
      await store.upsertContact({
        ...(contact || {}),
        caller,
        client,
        email,
        status: 'paused',
        send_count: contact?.send_count || 0,
        inbox: contact?.inbox || null,
      });
    }
    return skip(store, { ...item, caller, client, email, config }, stops.reasons.join(','), { dryRun, extra: { pause: stops.pause } });
  }

  assertPoolIsolation(config.inboxes, { caller, client });
  const daily = await store.dailyMap(caller, client, todayStamp(now));
  const rr = await store.nextRoundRobin(caller, client);
  const picked = pickInbox({
    pool: config.inboxes,
    contact,
    dailyCounts: daily,
    roundRobinIndex: rr,
  });
  if (!picked.ok) {
    if (picked.queue) {
      await store.enqueue({
        caller,
        client,
        email,
        available_at: nextMorning(now).toISOString(),
        payload: { reason: picked.reason, allo_call_id: call.id || null },
      });
      await store.logEvent({
        caller,
        client,
        email,
        allo_call_id: call.id || null,
        action: 'queued',
        reason: picked.reason,
        dry_run: dryRun,
      });
      const slack = dryRun ? { sent: false, reason: 'dry_run' } : await postSlack(capAlert({ caller, client, email }));
      return { ok: true, queued: true, reason: picked.reason, slack };
    }
    return skip(store, { ...item, caller, client, email, config }, picked.reason, { dryRun });
  }

  const thread = decideThread(contact);
  const kind = thread.mode === 'reply' ? 'reply' : 'new_thread';
  const template = (config.templates || []).find((t) => t.kind === kind);
  const gate = templateSendable(template, { allowDraft: allowDraft || dryRun });
  if (!gate.ok) {
    return skip(store, { ...item, caller, client, email, config }, gate.reason, { dryRun });
  }

  const merged = mergeTemplate(template, {
    first_name: firstName || 'there',
    company_name: item.company_name || person.company?.name || person.company_name || '',
    booking_link: config.booking_link,
    signature: signatureBlock({
      callerName: callerName(call, config),
      signatureCompany: config.signature_company,
    }),
  });
  const subject = kind === 'new_thread' ? newThreadSubject(merged.subject) : merged.subject;
  const body = kind === 'new_thread' ? ensureVoicemailOpen(merged.body) : merged.body;

  const inboxRow = (config.inboxes || []).find((b) => String(b.email).toLowerCase() === picked.inbox);
  const sent = await sendPostcallEmail({
    dryRun,
    inbox: picked.inbox,
    inboxAccountId: inboxRow?.smartlead_account_id,
    to: email,
    firstName,
    lastName,
    companyName: item.company_name || person.company?.name || person.company_name || '',
    subject,
    body,
    thread,
    campaignId: config.smartlead_campaign_id,
    allowedCampaignId: config.smartlead_campaign_id,
    caller,
    smartleadLeadId: contact?.smartlead_lead_id,
    customFields: {
      booking_link: config.booking_link,
      signature: signatureBlock({
        callerName: callerName(call, config),
        signatureCompany: config.signature_company,
      }),
    },
  });
  if (!sent.ok) {
    return skip(store, { ...item, caller, client, email, config }, sent.reason, { dryRun });
  }

  const sendCount = Number(contact?.send_count || 0) + 1;
  await store.upsertContact({
    ...(contact || {}),
    caller,
    client,
    email,
    phone: call.contact_number || item.phone || contact?.phone || null,
    first_name: firstName,
    company_name: item.company_name || person.company?.name || null,
    inbox: picked.inbox,
    thread_id: sent.threadId,
    last_message_id: sent.messageId,
    smartlead_lead_id: sent.smartleadLeadId || contact?.smartlead_lead_id || null,
    send_count: sendCount,
    status: 'active',
    last_sent_at: now.toISOString(),
  });
  if (!dryRun) await store.incrementDaily(picked.inbox, caller, client, todayStamp(now));
  const event = await store.logEvent({
    caller,
    client,
    email,
    phone: call.contact_number || item.phone || null,
    allo_call_id: call.id || null,
    inbox: picked.inbox,
    action: 'sent',
    reason: dryRun ? 'dry_run' : kind,
    subject,
    thread_id: sent.threadId,
    message_id: sent.messageId,
    dry_run: dryRun,
    payload: {
      kind,
      sticky: picked.sticky,
      headers: sent.headers,
      draft_template: Boolean(gate.draft),
      provider: sent.provider || 'smartlead',
      campaignId: sent.campaignId || config.smartlead_campaign_id,
    },
  });

  return {
    ok: true,
    sent: true,
    dryRun,
    caller,
    client,
    email,
    inbox: picked.inbox,
    sticky: picked.sticky,
    kind,
    subject,
    body,
    threadId: sent.threadId,
    messageId: sent.messageId,
    headers: sent.headers,
    sendCount,
    campaignId: sent.campaignId || config.smartlead_campaign_id,
    provider: sent.provider || 'smartlead',
    event,
  };
}

async function skip(store, item, reason, { dryRun, extra } = {}) {
  const call = item.call || item;
  const event = await store.logEvent({
    caller: item.caller || item.config?.caller || null,
    client: item.client || item.config?.client || null,
    email: item.email || null,
    phone: call.contact_number || item.phone || null,
    allo_call_id: call.id || null,
    action: 'skipped',
    reason,
    dry_run: dryRun,
    payload: extra || {},
  });
  return { ok: true, skipped: true, reason, event };
}

export async function runPostcall({
  items = [],
  dryRun = true,
  allowDraft = false,
  now = new Date(),
} = {}) {
  const store = getPostcallStore();
  const configs = await store.loadConfigs();
  const results = [];
  for (const item of items) {
    results.push(await processPostcallItem(item, { dryRun, allowDraft, now, store, configs }));
  }
  return summarize(results, { dryRun });
}

export async function runRecentVoicemails({ lookbackMinutes = 3, dryRun = false } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMinutes * 60_000);
  const numbers = await listNumbers();
  const calls = [];
  for (const number of numbers) {
    const { calls: found } = await fetchCallsInWindow({
      alloNumber: number.number || number,
      start,
      end,
      maxPages: 3,
    });
    calls.push(...found);
  }
  const vms = calls.filter((c) => classifyFollowUp(c).kind === 'voicemail');
  if (vms.length === 0) return summarize([], { dryRun });
  const wanted = new Set(vms.flatMap((c) => phoneKeys(c.contact_number)));
  const { byPhone } = await buildPeopleIndex({ maxPages: 20, wanted });
  const items = vms.map((call) => ({ call, person: findPerson(byPhone, call.contact_number) || {} }));
  return runPostcall({ items, dryRun });
}

export function summarize(results, { dryRun } = {}) {
  const counts = { sent: 0, skipped: 0, queued: 0 };
  const skipReasons = {};
  for (const r of results) {
    if (r.sent) counts.sent++;
    else if (r.queued) counts.queued++;
    else if (r.skipped) {
      counts.skipped++;
      skipReasons[r.reason] = (skipReasons[r.reason] || 0) + 1;
    }
  }
  return { ok: true, dryRun: Boolean(dryRun), counts, skipReasons, results };
}
