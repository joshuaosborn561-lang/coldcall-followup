/**
 * Enrichment provider probe. Runs inside the deployment and dumps raw
 * responses so each provider's real request/response shape can be read off
 * the logs, rather than assumed from documentation.
 *
 * Enable with PROBE_ENRICH=1.
 *
 * Two phases:
 *   1. Cheap auth/balance calls -- confirm the key works and the auth header
 *      scheme is right, without spending a lookup credit.
 *   2. One real email lookup per unverified / newly wired provider against a
 *      known person from the Allo CRM (Amanda Alvarez @ omegaroofer.com).
 */

const LEADMAGIC = process.env.LEADMAGIC_API_KEY;
const AI_ARK = process.env.AI_ARK_API_KEY;
const GETLEADS = process.env.GETLEADS_API_KEY;

// A real person from the Allo CRM, so a hit proves the whole path works.
const TARGET = {
  first_name: process.env.PROBE_FIRST_NAME || 'Amanda',
  last_name: process.env.PROBE_LAST_NAME || 'Alvarez',
  domain: process.env.PROBE_DOMAIN || 'omegaroofer.com',
};

const CHUNK = 900;
const AI_ARK_BASE = 'https://api.ai-ark.com/api/developer-portal';

function log(label, status, text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  console.log(`PE ${status} ${label}`);
  for (let i = 0; i < flat.length && i < CHUNK * 2; i += CHUNK) {
    console.log(`PE   ${flat.slice(i, i + CHUNK)}`);
  }
}

async function hit(label, url, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    log(label, res.status, await res.text());
  } catch (err) {
    log(label, 'ERR', err.message);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeEnrich() {
  console.log(`PE target: ${TARGET.first_name} ${TARGET.last_name} @ ${TARGET.domain}`);

  // LeadMagic is already verified working, and its email-finder costs a credit
  // per call -- deliberately not probed again.
  console.log('PE LeadMagic: already verified, skipped (costs a credit)');

  // --- AI Ark --- developer-portal base + X-TOKEN auth.
  if (AI_ARK) {
    await hit('ARK credits', `${AI_ARK_BASE}/v1/payments/credits`, {
      headers: { 'X-TOKEN': AI_ARK },
    });

    const fullName = `${TARGET.first_name} ${TARGET.last_name}`;
    await hit('ARK people search', `${AI_ARK_BASE}/v1/people`, {
      method: 'POST',
      headers: { 'X-TOKEN': AI_ARK },
      body: {
        page: 0,
        size: 3,
        account: { domain: { any: { include: [TARGET.domain] } } },
        contact: {
          fullName: { any: { include: { mode: 'SMART', content: [fullName] } } },
        },
      },
    });
  } else console.log('PE AI Ark: no key');

  // --- getleads --- verify contacts/search with the field names from the
  // MCP schema (domains[], require_email, email_status), against a person we
  // know LeadMagic can resolve.
  if (GETLEADS) {
    await hit('GL contacts/search', 'https://app.getleads.io/api/v1/contacts/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GETLEADS}` },
      body: {
        first_name: TARGET.first_name,
        last_name: TARGET.last_name,
        domains: [TARGET.domain],
        require_email: true,
        email_status: ['VALID'],
        limit: 1,
      },
    });
    // Domain-only, in case the name filter is too strict.
    await hit('GL domain-only', 'https://app.getleads.io/api/v1/contacts/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GETLEADS}` },
      body: { domains: [TARGET.domain], require_email: true, limit: 3 },
    });
  } else console.log('PE getleads: no key');

  console.log('PE done');
}
