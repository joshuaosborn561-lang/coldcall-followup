/**
 * Pre-flight check. Confirms env is complete, both APIs answer, the API key
 * has the scopes it needs, every routed number exists on the Allo account and
 * every routed Smartlead campaign resolves.
 *
 *   GET /api/health?key=$CRON_SECRET
 *
 * Read-only -- it never adds a lead.
 */

import { isAuthorized } from '../lib/auth.js';
import { listNumbers, searchContacts } from '../lib/allo.js';
import { resolveRoutes } from '../lib/routes.js';
import { getCampaign } from '../lib/smartlead.js';
import { TZ, isSendWindow, zonedDayWindow, zonedParts } from '../lib/time.js';

const REQUIRED = ['ALLO_API_KEY', 'SMARTLEAD_API_KEY', 'CRON_SECRET'];

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });
  }

  const now = new Date();
  const et = zonedParts(now, TZ);
  const window = zonedDayWindow(null, TZ);

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (!process.env.ALLO_ROUTES && !process.env.SMARTLEAD_CAMPAIGN_ID) {
    missing.push('ALLO_ROUTES or SMARTLEAD_CAMPAIGN_ID');
  }

  const checks = {
    env: {
      ok: missing.length === 0,
      missing,
      optionalSet: ['ALLO_ROUTES', 'SLACK_WEBHOOK_URL', 'INCLUDE_INBOUND_CALLS', 'MIN_CALL_MINUTES'].filter(
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
      numbersOnAccount: numbers.map((n) => ({ number: n.number, name: n.name ?? null })),
      contactPagesAvailable: contacts.totalPages,
      scopes: 'CONVERSATIONS_READ + CONTACTS_READ confirmed',
    };
  });

  // Routing is where a two-rep setup goes wrong, so it gets its own check:
  // each rep's number must exist on the account and their campaign must load.
  checks.routing = await probe(async () => {
    const { routes, warnings, mode } = await resolveRoutes();
    const campaigns = await Promise.all(
      routes.map(async (route) => {
        try {
          const campaign = await getCampaign(route.campaignId);
          return {
            rep: route.label,
            number: route.number,
            campaignId: route.campaignId,
            campaignName: campaign?.name ?? null,
            campaignStatus: campaign?.status ?? null,
            usingFallbackCampaign: Boolean(route.isFallback),
            ok: true,
          };
        } catch (err) {
          return {
            rep: route.label,
            number: route.number,
            campaignId: route.campaignId,
            ok: false,
            error: err.message,
          };
        }
      })
    );

    const sharedCampaigns = campaigns
      .map((c) => c.campaignId)
      .filter((id, i, all) => all.indexOf(id) !== i);

    return {
      mode,
      routes: campaigns,
      warnings: [
        ...warnings,
        ...(sharedCampaigns.length
          ? [`More than one number feeds campaign ${[...new Set(sharedCampaigns)].join(', ')} — ` +
             'those reps share a sender.']
          : []),
      ],
      allCampaignsResolved: campaigns.every((c) => c.ok),
    };
  });

  const ok =
    checks.env.ok && checks.allo.ok && checks.routing.ok && checks.routing.allCampaignsResolved !== false;
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
