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
 *   2. One real email lookup per provider against a known person from the
 *      Allo CRM (Amanda Alvarez @ omegaroofer.com).
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

  // --- LeadMagic ---
  if (LEADMAGIC) {
    await hit('LM /credits', 'https://api.leadmagic.io/credits', {
      method: 'POST',
      headers: { 'X-API-Key': LEADMAGIC },
      body: {},
    });
    await hit('LM /email-finder', 'https://api.leadmagic.io/email-finder', {
      method: 'POST',
      headers: { 'X-API-Key': LEADMAGIC },
      body: { first_name: TARGET.first_name, last_name: TARGET.last_name, domain: TARGET.domain },
    });
  } else console.log('PE LeadMagic: no key');

  // --- AI Ark --- base URL unknown; try the plausible ones and both auth schemes.
  if (AI_ARK) {
    for (const base of ['https://api.ai-ark.com', 'https://api.aiark.com', 'https://api.theaiark.com']) {
      await hit(`ARK ${base} bearer`, `${base}/v1/people/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AI_ARK}` },
        body: { fullName: `${TARGET.first_name} ${TARGET.last_name}`, companyDomain: TARGET.domain, size: 1 },
      });
    }
    await hit('ARK x-api-key /email_finder', 'https://api.ai-ark.com/v1/email_finder', {
      method: 'POST',
      headers: { 'x-api-key': AI_ARK },
      body: { fullName: `${TARGET.first_name} ${TARGET.last_name}`, companyDomain: TARGET.domain, size: 1 },
    });
  } else console.log('PE AI Ark: no key');

  // --- getleads --- MCP tool docs reference /api/v1/enrich/*; confirm the base.
  if (GETLEADS) {
    for (const base of ['https://api.getleads.io', 'https://app.getleads.io', 'https://getleads.io']) {
      await hit(`GL ${base} health`, `${base}/api/v1/health`, {
        headers: { Authorization: `Bearer ${GETLEADS}` },
      });
    }
    await hit('GL colleagues-by-domain', 'https://api.getleads.io/api/v1/enrich/colleagues-by-domain', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GETLEADS}` },
      body: { domain: TARGET.domain, limit: 3 },
    });
  } else console.log('PE getleads: no key');

  console.log('PE done');
}
