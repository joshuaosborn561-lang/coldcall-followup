/**
 * The job: Allo voicemails -> Smartlead campaign.
 *
 *   1. Work out today's calendar day in Eastern time.
 *   2. Pull the day's OUTBOUND calls from Allo v2.
 *   3. Keep only the ones where a voicemail was actually left.
 *   4. Resolve an email: Allo CRM first, then the call's AI-extracted contact,
 *      then (optionally) the enrichment waterfall.
 *   5. Dedupe by email, newest call wins.
 *   6. Push to the Smartlead campaign.
 *
 * Rep attribution comes from the call's own `user` object, so it is correct
 * even on a shared number -- no phone-to-person mapping needed.
 */

import { buildPeopleIndex, fetchCallsInWindow, findPerson, listNumbers, phoneKeys } from './allo.js';
import { pickBestEmail } from './emails.js';
import { enrichMissingEmails } from './enrich.js';
import { splitContactName } from './names.js';
import { addLeads } from './smartlead.js';
import { formatCallMoment, zonedDayWindow } from './time.js';
import { shouldFollowUp } from './voicemail.js';

const SUMMARY_MAX_CHARS = 500;

export async function runFollowUp({ dryRun = false, date = null, throughDate = null, tz = undefined } = {}) {
  const startedAt = Date.now();
  const window = zonedDayWindow(date, tz, throughDate);
  const campaignId = requireCampaign();

  const stats = {
    date: window.label,
    timezone: window.tz,
    dryRun,
    campaignId,
    totals: {
      callsInWindow: 0,
      voicemailsLeft: 0,
      uncertain: 0,
      peopleReached: 0,
      leadsPrepared: 0,
      uploaded: 0,
      duplicates: 0,
      invalid: 0,
      unsubscribed: 0,
    },
    byRep: {},
    emailSources: { allo_crm: 0, call_extraction: 0, enriched: 0 },
    skipped: [],
    warnings: [],
  };

  // 1-2. The day's outbound calls, across every Allo number.
  const numbers = await resolveNumbers();
  if (numbers.length === 0) throw new Error('No Allo phone numbers found on the account.');

  const calls = [];
  for (const number of numbers) {
    const { calls: found, truncated } = await fetchCallsInWindow({
      alloNumber: number,
      start: window.start,
      end: window.end,
      maxPages: intEnv('ALLO_MAX_CALL_PAGES', 20),
    });
    calls.push(...found);
    if (truncated) {
      stats.warnings.push(`Hit ALLO_MAX_CALL_PAGES paging ${number}; some calls may be missing.`);
    }
  }
  stats.totals.callsInWindow = calls.length;

  // 3. Voicemails only. Everything else is dropped with a recorded reason.
  const voicemails = [];
  for (const call of calls) {
    const verdict = shouldFollowUp(call);
    if (verdict.left === null) stats.totals.uncertain++;
    if (verdict.include) {
      voicemails.push(call);
      const rep = repName(call);
      stats.byRep[rep] = (stats.byRep[rep] || 0) + 1;
    } else {
      stats.skipped.push({
        number: call.contact_number,
        calledBy: repName(call),
        reason: `no voicemail left — ${verdict.reason}`,
        callId: call.id,
      });
    }
  }
  stats.totals.voicemailsLeft = voicemails.length;

  if (voicemails.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // 4. Resolve an email for each. Only the numbers actually called need
  // looking up, so the CRM index can stop as soon as they are all found.
  const wanted = new Set(voicemails.flatMap((c) => phoneKeys(c.contact_number)));
  const { byPhone, count, truncated } = await buildPeopleIndex({
    maxPages: intEnv('ALLO_MAX_PEOPLE_PAGES', 60),
    wanted,
  });
  stats.peopleIndexed = count;
  if (truncated) stats.warnings.push('Hit ALLO_MAX_PEOPLE_PAGES; some emails may not have resolved.');

  const resolved = [];
  const needsEnrichment = [];

  for (const call of voicemails) {
    const person = findPerson(byPhone, call.contact_number);
    const extracted = extractedContact(call);
    const { firstName, lastName } = contactNames(person, extracted);
    // Prefer a single, valid address -- Allo often stores "a@x.com,b@y.com".
    const crmEmail = pickBestEmail(person?.emails, { firstName, lastName });
    const extractedEmail = pickBestEmail(extracted?.emails, { firstName, lastName });
    const email = crmEmail || extractedEmail;

    const record = {
      call,
      person,
      extracted,
      email,
      source: crmEmail ? 'allo_crm' : email ? 'call_extraction' : null,
    };

    if (email) {
      stats.emailSources[record.source]++;
      resolved.push(record);
    } else {
      needsEnrichment.push(record);
    }
  }

  stats.totals.peopleReached = new Set(voicemails.map((c) => c.contact_number)).size;

  // Enrichment waterfall for whoever Allo has no email for.
  if (needsEnrichment.length > 0) {
    const { enriched, stillMissing, warnings, providerCounts } = await enrichMissingEmails(needsEnrichment);
    stats.emailSources.enriched = enriched.length;
    stats.enrichment = providerCounts;
    stats.warnings.push(...warnings);
    resolved.push(...enriched);

    for (const record of stillMissing) {
      stats.skipped.push({
        number: record.call.contact_number,
        calledBy: repName(record.call),
        name: personName(record),
        company: companyName(record),
        reason: 'no email found in Allo or via enrichment',
      });
    }
  }

  // 5. One follow-up per person, newest voicemail wins.
  const byEmail = new Map();
  for (const record of resolved) {
    const key = record.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || Date.parse(record.call.date) > Date.parse(existing.call.date)) {
      byEmail.set(key, record);
    }
  }

  const leads = [...byEmail.values()].map(toLead);
  stats.totals.leadsPrepared = leads.length;
  stats.leads = [...byEmail.values()].map((r, i) => ({
    email: leads[i].email,
    first_name: leads[i].first_name,
    last_name: leads[i].last_name,
    company_name: leads[i].company_name,
    calledBy: repName(r.call),
    emailSource: r.source,
    voicemailAt: leads[i].custom_fields.call_time,
  }));

  const noFirstName = leads.filter((l) => !l.first_name);
  if (noFirstName.length) {
    stats.leadsWithoutFirstName = noFirstName.map((l) => l.email);
    stats.warnings.push(
      `${noFirstName.length} lead(s) have no first name — use a Smartlead fallback like {{first_name|there}}.`
    );
  }

  if (dryRun || leads.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // 6. Push.
  const result = await addLeads(leads, { id: campaignId });
  Object.assign(stats.totals, {
    uploaded: result.uploaded,
    duplicates: result.duplicates,
    invalid: result.invalid,
    unsubscribed: result.unsubscribed,
  });
  stats.smartlead = result;
  stats.durationMs = Date.now() - startedAt;
  return stats;
}

function requireCampaign() {
  const id = (process.env.SMARTLEAD_CAMPAIGN_ID || '').trim();
  if (!id) throw new Error('SMARTLEAD_CAMPAIGN_ID is not set.');
  return id;
}

async function resolveNumbers() {
  const configured = (process.env.ALLO_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return (await listNumbers()).map((n) => n.number).filter(Boolean);
}

/** Who placed the call. v2 puts this on the call itself. */
function repName(call) {
  return call?.user?.name || call?.user?.email || 'Unknown';
}

/** Allo's AI sometimes extracts contact details from the call audio. */
function extractedContact(call) {
  const c = call?.extracted_data?.contact;
  if (!c) return null;
  // The extractor writes the literal string "null" for empty fields.
  const clean = (v) => (typeof v === 'string' && v !== 'null' && v.trim() ? v.trim() : null);
  return {
    name: clean(c.name),
    // Keep the raw value; pickBestEmail expands comma-joined CRM strings.
    emails: c.emails ?? c.email ?? null,
    company: clean(c.company),
    website: clean(c.website),
    job_title: clean(c.job_title),
  };
}

function contactNames(person, extracted) {
  return splitContactName({
    name: person?.name ?? extracted?.name,
    lastName: person?.last_name,
    // When the CRM name is a company label, prefer the call-audio person name.
    fallbackName: person?.name && extracted?.name && person.name !== extracted.name ? extracted.name : '',
  });
}

function personName(record) {
  const { firstName, lastName } = contactNames(record.person, record.extracted);
  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (joined) return joined;
  const p = record.person;
  if (p) return [p.name, p.last_name].filter(Boolean).join(' ').trim() || null;
  return record.extracted?.name || null;
}

function companyName(record) {
  // Allo's CRM wins; an enrichment provider only fills a gap.
  return record.person?.company?.name || record.extracted?.company || record.enrichedCompany || '';
}

/**
 * Smartlead lead payload. Custom fields must already exist on the campaign or
 * Smartlead accepts the lead and silently drops the value.
 */
function toLead(record) {
  const { call, person, extracted } = record;
  const { firstName, lastName } = contactNames(person, extracted);
  const moment = formatCallMoment(call.date);
  // Re-pick against the normalized name so multi-email CRM rows land on the
  // address that matches the person (scott@… over admin@…).
  const email =
    pickBestEmail(record.email, { firstName, lastName }) ||
    pickBestEmail(person?.emails, { firstName, lastName }) ||
    pickBestEmail(extracted?.emails, { firstName, lastName }) ||
    record.email;

  return {
    email,
    first_name: firstName,
    last_name: lastName,
    company_name: companyName(record),
    website: person?.website || extracted?.website || '',
    phone_number: call.contact_number || '',
    custom_fields: stripEmpty({
      call_date: moment.date,
      call_day: moment.day,
      call_time: moment.time,
      call_summary: truncate(call.summary || '', SUMMARY_MAX_CHARS),
      call_length_minutes: call.duration ? (call.duration / 60).toFixed(1) : '',
      job_title: person?.job_title || extracted?.job_title || '',
      called_by: repName(call),
      allo_call_id: call.id || '',
      allo_person_id: person?.id || '',
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

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
