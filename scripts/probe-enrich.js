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

  // LeadMagic is already verified working, and its email-finder costs a credit
  // per call -- deliberately not probed again.
  console.log('PE LeadMagic: already verified, skipped (costs a credit)');

  // --- AI Ark --- api.ai-ark.com resolves (nginx) but 404s on /v1/*.
  // Walk likely prefixes; a 401/403 is a HIT (right path, wrong/missing auth).
  if (AI_ARK) {
    for (const path of [
      '/',
      '/api/v1/people/search',
      '/api/people/search',
      '/v1/search/people',
      '/api/v1/email-finder',
      '/api/v1/email_finder',
    ]) {
      await hit(`ARK ${path}`, `https://api.ai-ark.com${path}`, {
        headers: { Authorization: `Bearer ${AI_ARK}`, 'x-api-key': AI_ARK },
      });
    }
  } else console.log('PE AI Ark: no key');

  // --- getleads --- base confirmed: app.getleads.io/api/v1, Bearer auth.
  // from-linkedin works but needs a LinkedIn URL; Allo gives name + domain,
  // so find the path that takes those.
  if (GETLEADS) {
    const B = 'https://app.getleads.io/api/v1';
    const H = { Authorization: `Bearer ${GETLEADS}` };
    const person = { first_name: TARGET.first_name, last_name: TARGET.last_name, domain: TARGET.domain };

    for (const [label, path, body] of [
      ['contacts/search', '/contacts/search', { company_domain: TARGET.domain, limit: 2 }],
      ['contacts/count', '/contacts/count', { company_domain: TARGET.domain }],
      ['colleagues-by-domain', '/enrich/colleagues-by-domain', { domain: TARGET.domain, limit: 2 }],
      ['decision-makers', '/lookup/decision-makers', { domain: TARGET.domain, limit: 2 }],
      ['enrich/person', '/enrich/person', { items: [person] }],
      ['enrich/find-email', '/enrich/find-email', person],
      ['enrich/from-name', '/enrich/from-name', { items: [person] }],
    ]) {
      await hit(`GL ${label}`, `${B}${path}`, { method: 'POST', headers: H, body });
    }
    await hit('GL columns', `${B}/contacts/columns`, { headers: H });
  } else console.log('PE getleads: no key');

  console.log('PE done');
}
