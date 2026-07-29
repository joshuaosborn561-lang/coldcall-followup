/**
 * Who owns which Allo number, and which Smartlead campaign their calls feed.
 *
 * Allo's call log records `from_number` / `to_number` and nothing about which
 * team member placed the call -- there is no per-user field on a Call. So the
 * Allo number IS the owner identity. Two reps on separate numbers can be told
 * apart; two reps sharing one number cannot, by anything the API exposes.
 *
 * Config (Vercel env):
 *
 *   ALLO_ROUTES="+15550101010:12345:Josh,+15550202020:67890:Cayden"
 *                 number      campaign  label(optional)
 *
 * Each rep's calls go to their own campaign, which is what makes the follow-up
 * come from their mailbox with their signature.
 *
 * Unset ALLO_ROUTES and every number on the account feeds
 * SMARTLEAD_CAMPAIGN_ID instead (single-sender setup).
 */

import { listNumbers } from './allo.js';

export class RouteConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteConfigError';
  }
}

/** Normalise to +digits so config and Allo's responses compare equal. */
export function normalizeNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Parse the ALLO_ROUTES string. Throws with a pointed message on bad input --
 * a typo here silently sends a rep's prospects to someone else's campaign, so
 * this fails loudly rather than guessing.
 */
export function parseRouteSpec(raw) {
  const routes = [];
  const seen = new Map();
  const errors = [];

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (!entry) continue;

    const parts = entry.split(':').map((p) => p.trim());
    const [rawNumber, campaignId, ...labelParts] = parts;

    if (!rawNumber || !campaignId) {
      errors.push(`"${entry}" — expected number:campaignId[:label]`);
      continue;
    }
    // Accept anything a person might paste -- "+1 555 020 2020", "(555) 010-1010"
    // -- but insist it is actually a phone number and not a name or a typo.
    const digitCount = rawNumber.replace(/\D/g, '').length;
    if (!/^[+\d\s().-]+$/.test(rawNumber) || digitCount < 7) {
      errors.push(`"${rawNumber}" is not a phone number`);
      continue;
    }
    if (!/^[\w-]+$/.test(campaignId)) {
      errors.push(`"${campaignId}" is not a valid Smartlead campaign id (in "${entry}")`);
      continue;
    }

    const number = normalizeNumber(rawNumber);
    if (seen.has(number)) {
      errors.push(`${number} is listed twice — one number cannot feed two campaigns`);
      continue;
    }

    const route = { number, campaignId, label: labelParts.join(':').trim() || number };
    seen.set(number, route);
    routes.push(route);
  }

  if (errors.length) {
    throw new RouteConfigError(
      `ALLO_ROUTES is malformed:\n  - ${errors.join('\n  - ')}\n` +
        'Expected: "+15550101010:12345:Josh,+15550202020:67890:Cayden"'
    );
  }
  if (routes.length === 0) {
    throw new RouteConfigError('ALLO_ROUTES is set but contains no usable entries.');
  }

  return routes;
}

/**
 * The routes this run will process, plus warnings about anything on the Allo
 * account that is not covered. An uncovered number means someone's calls are
 * being dropped, so it is surfaced rather than ignored.
 */
export async function resolveRoutes() {
  const spec = (process.env.ALLO_ROUTES || '').trim();
  const fallbackCampaign = (process.env.SMARTLEAD_CAMPAIGN_ID || '').trim();
  const warnings = [];

  if (!spec) {
    // Single-sender mode: every number on the account -> one campaign.
    if (!fallbackCampaign) {
      throw new RouteConfigError(
        'Set ALLO_ROUTES (per-rep campaigns) or SMARTLEAD_CAMPAIGN_ID (one shared campaign).'
      );
    }
    const numbers = await listNumbers();
    const routes = numbers
      .map((n) => n.number)
      .filter(Boolean)
      .map((number) => ({
        number: normalizeNumber(number),
        campaignId: fallbackCampaign,
        label: numbers.find((n) => normalizeNumber(n.number) === normalizeNumber(number))?.name || number,
      }));

    if (routes.length === 0) {
      throw new RouteConfigError(
        'No Allo phone numbers found on the account. Set ALLO_ROUTES explicitly, or check that the ' +
          'API key has the CONVERSATIONS_READ scope.'
      );
    }
    return { routes, warnings, mode: 'single-campaign' };
  }

  const routes = parseRouteSpec(spec);

  // Cross-check against the account so a new rep's number does not go
  // unnoticed, and a typo'd number does not silently return zero calls.
  try {
    const accountNumbers = await listNumbers();
    const onAccount = new Set(accountNumbers.map((n) => normalizeNumber(n.number)).filter(Boolean));

    for (const route of routes) {
      if (onAccount.size > 0 && !onAccount.has(route.number)) {
        warnings.push(
          `${route.number} (${route.label}) is in ALLO_ROUTES but not on the Allo account — check for a typo.`
        );
      }
    }

    const routed = new Set(routes.map((r) => r.number));
    for (const n of accountNumbers) {
      const number = normalizeNumber(n.number);
      if (!number || routed.has(number)) continue;
      if (fallbackCampaign) {
        routes.push({ number, campaignId: fallbackCampaign, label: n.name || number, isFallback: true });
        warnings.push(
          `${number}${n.name ? ` (${n.name})` : ''} is not in ALLO_ROUTES — using SMARTLEAD_CAMPAIGN_ID.`
        );
      } else {
        warnings.push(
          `${number}${n.name ? ` (${n.name})` : ''} is on the Allo account but not in ALLO_ROUTES — ` +
            'its calls are being skipped.'
        );
      }
    }
  } catch (err) {
    // A failed cross-check must not stop a run whose routes are explicit.
    warnings.push(`Could not list Allo numbers to cross-check ALLO_ROUTES: ${err.message}`);
  }

  return { routes, warnings, mode: 'per-rep' };
}
