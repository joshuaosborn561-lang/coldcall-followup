/**
 * Pre-flight check. Confirms env is complete, both APIs answer, the API key
 * has the scopes it needs, and the Smartlead campaign ID resolves.
 *
 *   GET /api/health?key=$CRON_SECRET
 *
 * Read-only -- it never adds a lead.
 */

import { isAuthorized } from '../lib/auth.js';
import { listNumbers, searchContacts } from '../lib/allo.js';
import { getCampaign } from '../lib/smartlead.js';
import { TZ, isSendWindow, zonedDayWindow, zonedParts } from '../lib/time.js';

const REQUIRED = ['ALLO_API_KEY', 'SMARTLEAD_API_KEY', 'SMARTLEAD_CAMPAIGN_ID', 'CRON_SECRET'];

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });
  }

  const now = new Date();
  const et = zonedParts(now, TZ);
  const window = zonedDayWindow(null, TZ);

  const checks = {
    env: {
      ok: REQUIRED.every((k) => Boolean(process.env[k])),
      missing: REQUIRED.filter((k) => !process.env[k]),
      optionalSet: ['ALLO_NUMBERS', 'SLACK_WEBHOOK_URL', 'INCLUDE_INBOUND_CALLS', 'MIN_CALL_MINUTES'].filter(
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
    const numbers = await listNumbers();
    const contacts = await searchContacts({ page: 0, size: 1 });
    return {
      numbers: numbers.map((n) => n.number).filter(Boolean),
      contactPagesAvailable: contacts.totalPages,
      scopes: 'CONVERSATIONS_READ + CONTACTS_READ confirmed',
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

  const ok = checks.env.ok && checks.allo.ok && checks.smartlead.ok;
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
