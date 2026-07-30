/**
 * The job: Allo call log -> Smartlead campaigns.
 *
 *   1. Work out today's calendar day in Eastern time.
 *   2. For each routed Allo number (= each rep), pull that number's calls
 *      inside the day and keep the outbound ones.
 *   3. Join each call's counterparty number to an Allo contact for the email.
 *   4. Dedupe by email across ALL reps -- newest call wins, so a prospect both
 *      reps called gets one follow-up from whoever spoke to them last.
 *   5. Push each rep's leads to that rep's campaign.
 *
 * Anyone called but missing an email lands in `skipped` so they can be fixed
 * in Allo rather than silently disappearing.
 */

import { buildContactIndex, fetchCallsInWindow, findContact } from './allo.js';
import { splitContactName } from './names.js';
import { resolveRoutes } from './routes.js';
import { addLeads } from './smartlead.js';
import { formatCallMoment, zonedDayWindow } from './time.js';

const SUMMARY_MAX_CHARS = 500;

export async function runFollowUp({ dryRun = false, date = null, tz = undefined } = {}) {
  const startedAt = Date.now();
  const window = zonedDayWindow(date, tz);
  const { routes, warnings, mode } = await resolveRoutes();

  const stats = {
    date: window.label,
    timezone: window.tz,
    dryRun,
    mode,
    routes: [],
    totals: { callsInWindow: 0, peopleCalled: 0, leadsPrepared: 0, uploaded: 0, duplicates: 0, invalid: 0, unsubscribed: 0 },
    skipped: [],
    collisions: [],
    warnings: [...warnings],
  };

  // Calls first: if nobody was called today there is no reason to page the
  // whole contact book.
  const perRoute = new Map();
  for (const route of routes) {
    const { calls, truncated } = await fetchCallsInWindow({
      alloNumber: route.number,
      start: window.start,
      end: window.end,
      maxPages: intEnv('ALLO_MAX_CALL_PAGES', 20),
    });
    const relevant = calls.filter(isFollowUpCall);
    perRoute.set(route.number, { route, calls, relevant });

    if (truncated) {
      stats.warnings.push(
        `Hit ALLO_MAX_CALL_PAGES paging ${route.label}'s call log; some calls may be missing. Raise the limit.`
      );
    }
  }

  const totalRelevant = [...perRoute.values()].reduce((n, r) => n + r.relevant.length, 0);
  stats.totals.callsInWindow = [...perRoute.values()].reduce((n, r) => n + r.calls.length, 0);

  if (totalRelevant === 0) {
    stats.routes = routes.map((route) => emptyRouteStat(route, perRoute.get(route.number)));
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

  // Resolve everyone across every rep, then dedupe globally. Deduping per-rep
  // instead would double-mail a prospect both reps happened to call.
  const resolved = [];
  const peopleByRoute = new Map(routes.map((r) => [r.number, new Set()]));

  for (const { route, relevant } of perRoute.values()) {
    for (const call of relevant) {
      const counterparty = counterpartyNumber(call);
      if (!counterparty) continue;
      peopleByRoute.get(route.number).add(counterparty);

      const contact = findContact(byPhone, counterparty);
      const email = firstEmail(contact);

      if (!email) {
        stats.skipped.push({
          number: counterparty,
          reason: contact ? 'contact has no email address' : 'no Allo contact for this number',
          contactId: contact?.id ?? null,
          name: contact ? displayName(contact) : null,
          calledBy: route.label,
        });
        continue;
      }

      resolved.push({ call, contact, email, route });
    }
  }

  const { byEmail, collisions } = dedupeAcrossRoutes(resolved);
  stats.collisions = collisions;

  // Build the payloads once, then group by campaign. Two numbers may share a
  // campaign, so key on campaignId rather than on the route.
  const byCampaign = new Map();
  const leadsByRoute = new Map(routes.map((r) => [r.number, 0]));
  const built = [];

  for (const entry of byEmail.values()) {
    const lead = toLead(entry);
    built.push({ lead, entry });

    const bucket = byCampaign.get(entry.route.campaignId) || { leads: [], routes: new Set() };
    bucket.leads.push(lead);
    bucket.routes.add(entry.route.label);
    byCampaign.set(entry.route.campaignId, bucket);

    leadsByRoute.set(entry.route.number, (leadsByRoute.get(entry.route.number) || 0) + 1);
  }

  // A blank first name renders "Hi ," unless the sequence has a fallback, so
  // it is called out rather than left to be discovered in a sent email.
  const noFirstName = built.filter(({ lead }) => !lead.first_name);
  if (noFirstName.length) {
    stats.leadsWithoutFirstName = noFirstName.map(({ lead }) => lead.email);
    stats.warnings.push(
      `${noFirstName.length} lead(s) have no first name in Allo — use a Smartlead fallback ` +
        'like {{first_name|there}}, or fill the contact in.'
    );
  }

  stats.routes = routes.map((route) => {
    const bucket = perRoute.get(route.number);
    return {
      number: route.number,
      label: route.label,
      campaignId: route.campaignId,
      isFallback: Boolean(route.isFallback),
      callsInWindow: bucket?.calls.length ?? 0,
      callsAfterFilter: bucket?.relevant.length ?? 0,
      peopleCalled: peopleByRoute.get(route.number)?.size ?? 0,
      leadsPrepared: leadsByRoute.get(route.number) ?? 0,
    };
  });

  stats.totals.peopleCalled = stats.routes.reduce((n, r) => n + r.peopleCalled, 0);
  stats.totals.leadsPrepared = byEmail.size;
  // Show the merge fields as Smartlead will actually receive them, so a dry
  // run proves {{first_name}} before anything sends.
  stats.leads = built.map(({ lead, entry }) => ({
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company_name: lead.company_name,
    alloName: rawAlloName(entry.contact),
    calledBy: entry.route.label,
    campaignId: entry.route.campaignId,
    call_date: lead.custom_fields.call_date ?? '',
  }));

  if (dryRun || byEmail.size === 0) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // Upload per campaign. One campaign failing must not lose the others.
  stats.uploads = [];
  for (const [id, bucket] of byCampaign) {
    try {
      const result = await addLeads(bucket.leads, { id });
      stats.uploads.push({ campaignId: id, reps: [...bucket.routes], sent: bucket.leads.length, ...result });
      stats.totals.uploaded += result.uploaded;
      stats.totals.duplicates += result.duplicates;
      stats.totals.invalid += result.invalid;
      stats.totals.unsubscribed += result.unsubscribed;
    } catch (err) {
      stats.uploads.push({
        campaignId: id,
        reps: [...bucket.routes],
        sent: bucket.leads.length,
        error: err.message,
      });
      stats.warnings.push(`Campaign ${id} (${[...bucket.routes].join(', ')}) failed: ${err.message}`);
    }
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}

/**
 * One follow-up per person, no matter how many reps dialled them.
 *
 * Keyed on lowercased email; the most recent call wins, so the lead carries
 * the freshest summary and is assigned to whoever spoke to them last. When the
 * loser belongs to a different rep that is recorded as a collision, because
 * "your prospect went into Cayden's campaign" is something you want told.
 */
export function dedupeAcrossRoutes(entries) {
  const byEmail = new Map();
  const collisions = [];

  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    const existing = byEmail.get(key);

    if (!existing) {
      byEmail.set(key, entry);
      continue;
    }

    const isNewer = Date.parse(entry.call.start_date) > Date.parse(existing.call.start_date);
    const winner = isNewer ? entry : existing;
    const loser = isNewer ? existing : entry;
    byEmail.set(key, winner);

    if (winner.route.number !== loser.route.number) {
      collisions.push({
        email: winner.email,
        calledByBoth: [winner.route.label, loser.route.label],
        assignedTo: winner.route.label,
        reason: 'both reps called this person today; newest call wins',
      });
    }
  }

  return { byEmail, collisions };
}

function emptyRouteStat(route, bucket) {
  return {
    number: route.number,
    label: route.label,
    campaignId: route.campaignId,
    isFallback: Boolean(route.isFallback),
    callsInWindow: bucket?.calls.length ?? 0,
    callsAfterFilter: bucket?.relevant.length ?? 0,
    peopleCalled: 0,
    leadsPrepared: 0,
  };
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

/** What Allo actually holds, so a dry run shows the before/after of the split. */
function rawAlloName(contact) {
  return { name: contact?.name ?? null, last_name: contact?.last_name ?? null };
}

/**
 * Smartlead lead payload -- the merge fields the sequence renders.
 *
 * {{first_name}} is the prospect's first name only. Allo's `name` field often
 * holds the full name with `last_name` empty, so it is split rather than
 * passed through; see lib/names.js.
 *
 * Everything under custom_fields must already exist as a custom field on the
 * campaign, or Smartlead accepts the lead and silently drops the value --
 * see the README for the list.
 */
function toLead({ call, contact, email, route }) {
  const { firstName, lastName } = splitContactName({
    name: contact?.name,
    lastName: contact?.last_name,
  });
  const moment = formatCallMoment(call.start_date);

  return {
    email,
    first_name: firstName,
    last_name: lastName,
    company_name: contact?.company?.name || '',
    website: contact?.website || '',
    phone_number: counterpartyNumber(call) || '',
    custom_fields: stripEmpty({
      call_date: moment.date, // "July 30"
      call_day: moment.day, // "Thursday"
      call_time: moment.time, // "2:23pm"
      call_summary: truncate(call.summary || '', SUMMARY_MAX_CHARS),
      call_length_minutes: String(call.length_in_minutes ?? ''),
      job_title: contact?.job_title || '',
      called_by: route?.label || '',
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
