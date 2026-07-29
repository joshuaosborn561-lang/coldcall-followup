/**
 * The job itself: Allo call log -> Smartlead campaign.
 *
 *   1. Work out today's calendar day in Eastern time.
 *   2. Pull every call on every Allo number that started inside that day.
 *   3. Keep the outbound ones (the people *you* called).
 *   4. Join each call's counterparty number to an Allo contact for the email.
 *   5. Dedupe by email, newest call wins.
 *   6. Push to the standing Smartlead campaign.
 *
 * Anyone called but missing an email lands in `skipped` so they can be fixed
 * in Allo rather than silently disappearing.
 */

import { buildContactIndex, fetchCallsInWindow, findContact, listNumbers } from './allo.js';
import { addLeads, campaignId } from './smartlead.js';
import { zonedDayWindow } from './time.js';

const SUMMARY_MAX_CHARS = 500;

export async function runFollowUp({ dryRun = false, date = null, tz = undefined } = {}) {
  const startedAt = Date.now();
  const window = zonedDayWindow(date, tz);

  const numbers = await resolveAlloNumbers();
  if (numbers.length === 0) {
    throw new Error(
      'No Allo phone numbers found. Set ALLO_NUMBERS to a comma-separated list of E.164 numbers, ' +
        'or give the API key the CONVERSATIONS_READ scope so /numbers can be listed.'
    );
  }

  // Calls first: if nobody was called today there is no reason to page the
  // whole contact book.
  const calls = [];
  let callPagesTruncated = false;
  for (const number of numbers) {
    const result = await fetchCallsInWindow({
      alloNumber: number,
      start: window.start,
      end: window.end,
      maxPages: intEnv('ALLO_MAX_CALL_PAGES', 20),
    });
    calls.push(...result.calls);
    callPagesTruncated ||= result.truncated;
  }

  const relevant = calls.filter(isFollowUpCall);

  const stats = {
    date: window.label,
    timezone: window.tz,
    dryRun,
    alloNumbers: numbers,
    callsInWindow: calls.length,
    callsAfterFilter: relevant.length,
    peopleCalled: 0,
    leadsPrepared: 0,
    skipped: [],
    warnings: [],
  };

  if (callPagesTruncated) {
    stats.warnings.push(
      'Hit ALLO_MAX_CALL_PAGES while paging the call log; some calls may be missing. Raise the limit.'
    );
  }

  if (relevant.length === 0) {
    stats.smartlead = null;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  const { byPhone, count: contactCount, truncated: contactsTruncated } = await buildContactIndex({
    maxPages: intEnv('ALLO_MAX_CONTACT_PAGES', 50),
  });
  stats.contactsIndexed = contactCount;
  if (contactsTruncated) {
    stats.warnings.push(
      'Hit ALLO_MAX_CONTACT_PAGES while indexing contacts; some emails may not have resolved. Raise the limit.'
    );
  }

  // Newest call per person wins, so the lead carries the freshest summary.
  const byEmail = new Map();
  const seenNumbers = new Set();

  for (const call of relevant) {
    const counterparty = counterpartyNumber(call);
    if (!counterparty) continue;
    seenNumbers.add(counterparty);

    const contact = findContact(byPhone, counterparty);
    const email = firstEmail(contact);

    if (!email) {
      stats.skipped.push({
        number: counterparty,
        reason: contact ? 'contact has no email address' : 'no Allo contact for this number',
        contactId: contact?.id ?? null,
        name: contact ? displayName(contact) : null,
      });
      continue;
    }

    const key = email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || Date.parse(call.start_date) > Date.parse(existing.call.start_date)) {
      byEmail.set(key, { call, contact, email });
    }
  }

  stats.peopleCalled = seenNumbers.size;

  const leads = [...byEmail.values()].map(({ call, contact, email }) => toLead({ call, contact, email }));
  stats.leadsPrepared = leads.length;
  stats.leads = leads.map((l) => ({ email: l.email, name: `${l.first_name} ${l.last_name}`.trim() }));

  if (dryRun || leads.length === 0) {
    stats.smartlead = null;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  stats.smartlead = { campaignId: campaignId(), ...(await addLeads(leads)) };
  stats.durationMs = Date.now() - startedAt;
  return stats;
}

/** Configured numbers win; otherwise ask Allo what is on the account. */
async function resolveAlloNumbers() {
  const configured = (process.env.ALLO_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;

  const numbers = await listNumbers();
  return numbers.map((n) => n.number).filter(Boolean);
}

/** Outbound by default -- "people I called", not people who called in. */
function isFollowUpCall(call) {
  const includeInbound = boolEnv('INCLUDE_INBOUND_CALLS', false);
  const type = String(call.type || '').toUpperCase();
  if (!includeInbound && type !== 'OUTBOUND') return false;

  const minMinutes = floatEnv('MIN_CALL_MINUTES', 0);
  if (minMinutes > 0 && Number(call.length_in_minutes || 0) < minMinutes) return false;

  return true;
}

/** The other party: who we dialled on an outbound call, who dialled us inbound. */
function counterpartyNumber(call) {
  const type = String(call.type || '').toUpperCase();
  return type === 'INBOUND' ? call.from_number : call.to_number;
}

function firstEmail(contact) {
  const email = (contact?.emails || []).find((e) => typeof e === 'string' && e.includes('@'));
  return email ? email.trim() : null;
}

function displayName(contact) {
  return [contact?.name, contact?.last_name].filter(Boolean).join(' ').trim() || null;
}

/**
 * Smartlead lead payload.
 *
 * Everything under custom_fields must already exist as a custom field on the
 * campaign, or Smartlead drops it -- see the README.
 */
function toLead({ call, contact, email }) {
  return {
    email,
    first_name: contact?.name || '',
    last_name: contact?.last_name || '',
    company_name: contact?.company?.name || '',
    website: contact?.website || '',
    phone_number: counterpartyNumber(call) || '',
    custom_fields: stripEmpty({
      call_date: call.start_date || '',
      call_summary: truncate(call.summary || '', SUMMARY_MAX_CHARS),
      call_length_minutes: String(call.length_in_minutes ?? ''),
      job_title: contact?.job_title || '',
      allo_call_id: call.id || '',
      allo_contact_id: contact?.id || '',
    }),
  };
}

function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));
}

function truncate(str, max) {
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes)$/i.test(raw.trim());
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatEnv(name, fallback) {
  const n = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
