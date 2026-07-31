/**
 * Pre-flight check. Confirms env is complete, both APIs answer, the Allo key
 * carries the scopes v2 needs, and the Smartlead campaign resolves.
 *
 *   GET /api/health
 *
 * Read-only -- it never adds a lead.
 */

import { isAuthorized } from '../lib/auth.js';
import { getCapabilities, listNumbers, listUsers, searchPeople } from '../lib/allo.js';
import { getCampaign } from '../lib/smartlead.js';
import { TZ, isSendWindow, zonedDayWindow, zonedParts } from '../lib/time.js';

const REQUIRED = ['ALLO_API_KEY', 'SMARTLEAD_API_KEY', 'SMARTLEAD_CAMPAIGN_ID'];

// v2 scope names. CONTACTS_READ was a v1 scope and no longer exists.
const NEEDED_SCOPES = ['CONVERSATIONS_READ', 'CRM_READ', 'PHONE_NUMBERS_READ', 'USERS_READ'];

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });

  const now = new Date();
  const et = zonedParts(now, TZ);
  const window = zonedDayWindow(null, TZ);
  const missing = REQUIRED.filter((k) => !process.env[k]);

  const checks = {
    access: auth.open
      ? 'OPEN — no CRON_SECRET set, anyone with this URL can read the prospect list and trigger a send'
      : 'protected by CRON_SECRET',
    env: {
      ok: missing.length === 0,
      missing,
      enrichmentProviders: ['GETLEADS_API_KEY', 'AI_ARK_API_KEY', 'LEADMAGIC_API_KEY'].filter(
        (k) => Boolean(process.env[k])
      ),
    },
    clock: {
      utc: now.toISOString(),
      local: `${et.date} ${pad(et.hour)}:${pad(et.minute)} (${et.weekday})`,
      timezone: TZ,
      inSendWindowNow: isSendWindow(now),
      todayWindowUtc: { start: window.start.toISOString(), end: window.end.toISOString() },
    },
  };

  checks.allo = await probe(async () => {
    const caps = await getCapabilities();
    const scopes = caps.scopes || [];
    const [numbers, users, people] = await Promise.all([listNumbers(), listUsers(), searchPeople({ page: 1, size: 1 })]);
    return {
      scopes,
      missingScopes: NEEDED_SCOPES.filter((s) => !scopes.includes(s)),
      team: caps.team?.name ?? null,
      numbers: numbers.map((n) => n.number),
      reps: users.map((u) => u.name),
      peopleInCrm: people.totalCount,
    };
  });

  checks.smartlead = await probe(async () => {
    const campaign = await getCampaign();
    return {
      id: campaign?.id ?? process.env.SMARTLEAD_CAMPAIGN_ID,
      name: campaign?.name ?? null,
      status: campaign?.status ?? null,
    };
  });

  const ok =
    checks.env.ok && checks.allo.ok && checks.smartlead.ok && (checks.allo.missingScopes?.length ?? 0) === 0;
  return res.status(ok ? 200 : 503).json({ ok, checks });
}

async function probe(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status ?? null };
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}
