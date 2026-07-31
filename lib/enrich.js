/**
 * Email enrichment waterfall: getleads -> AI Ark -> LeadMagic.
 *
 * Allo's CRM holds names, job titles, companies and websites but almost no
 * email addresses, so anyone we left a voicemail for usually needs enriching
 * from (first name, last name, company domain).
 *
 * Each provider is OFF unless its API key is set, and the waterfall stops at
 * the first hit -- so a lead costs one lookup, not three.
 *
 * VERIFICATION STATUS
 *   LeadMagic  verified live against email-finder.
 *   getleads   verified live against contacts/search.
 *   AI Ark     REST base URL still UNKNOWN -- api.ai-ark.com 404s on every
 *              path tried, and app.ai-ark.com serves the SPA, not an API.
 *              Left disabled; the URL below is a guess.
 *
 * Building against unverified docs is what produced the v1-vs-v2 Allo mistake,
 * so an unverified provider stays disabled unless explicitly switched on with
 * ENRICH_ALLOW_UNVERIFIED=true. Run PROBE_ENRICH=1 to exercise each provider
 * against one real lead and print the raw response.
 */

const TIMEOUT_MS = 15_000;

/** Domain for a lead, which is what every provider keys off. */
export function domainFor(record) {
  const raw = record.person?.website || record.extracted?.website || '';
  if (!raw) return null;
  try {
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

function nameParts(record) {
  const p = record.person;
  const first = (p?.name || record.extracted?.name || '').trim().split(/\s+/)[0] || '';
  const last = (p?.last_name || '').trim();
  return { first, last };
}

async function postJson(url, { headers = {}, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

const pickEmail = (...candidates) =>
  candidates.find((e) => typeof e === 'string' && e.includes('@') && !/^null$/i.test(e)) || null;

// --- providers --------------------------------------------------------------

const PROVIDERS = [
  {
    // Verified live: POST app.getleads.io/api/v1/contacts/search with Bearer
    // auth (NOT api.getleads.io, which does not resolve) returns
    // {ok, contacts:[{email_address, email_status, org_company_name, ...}],
    //  query_credits_used, creditsRemaining}. Billing is 1 credit per record
    // returned, 0 if none.
    name: 'getleads',
    verified: true,
    key: () => process.env.GETLEADS_API_KEY,
    async find(record) {
      const domain = domainFor(record);
      const { first, last } = nameParts(record);
      if (!domain || !first) return null;

      const r = await postJson('https://app.getleads.io/api/v1/contacts/search', {
        headers: { Authorization: `Bearer ${process.env.GETLEADS_API_KEY}` },
        body: {
          first_name: first,
          ...(last ? { last_name: last } : {}),
          domains: [domain],
          require_email: true,
          email_status: ['VALID'], // deliverable only -- never CATCH_ALL or INVALID
          limit: 1,
        },
      });
      if (!r.ok) return null;

      const rows = r.body?.results || r.body?.data || r.body?.contacts || [];
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;

      const email = pickEmail(row.email, row.email_address, row.work_email);
      if (!email) return null;

      return { email, company_name: row.org_company_name || row.company_name || null, status: 'valid' };
    },
  },
  {
    name: 'ai_ark',
    verified: false,
    key: () => process.env.AI_ARK_API_KEY,
    async find(record) {
      const domain = domainFor(record);
      const { first, last } = nameParts(record);
      if (!domain || !first) return null;
      const r = await postJson('https://api.ai-ark.com/v1/email-finder', {
        headers: { Authorization: `Bearer ${process.env.AI_ARK_API_KEY}` },
        body: { fullName: [first, last].filter(Boolean).join(' '), companyDomain: domain, size: 1 },
      });
      if (!r.ok) return null;
      const d = Array.isArray(r.body?.results) ? r.body.results[0] : r.body?.data || r.body;
      return pickEmail(d?.email, d?.work_email);
    },
  },
  {
    // Verified live: POST /email-finder with X-API-Key returns
    // {email, status, credits_consumed, company_name, company_size, ...}.
    // It verifies the address itself, so status is trustworthy.
    name: 'leadmagic',
    verified: true,
    key: () => process.env.LEADMAGIC_API_KEY,
    async find(record) {
      const domain = domainFor(record);
      const { first, last } = nameParts(record);
      if (!domain || !first) return null;

      const r = await postJson('https://api.leadmagic.io/email-finder', {
        headers: { 'X-API-Key': process.env.LEADMAGIC_API_KEY },
        body: { first_name: first, last_name: last, domain },
      });
      if (!r.ok) return null;

      const email = pickEmail(r.body?.email);
      if (!email) return null;

      // Only accept what LeadMagic itself considers deliverable -- sending to
      // a guessed address is what wrecks a sending domain.
      const status = String(r.body?.status || '').toLowerCase();
      if (status && !['valid', 'verified', 'deliverable'].includes(status)) return null;

      return {
        email,
        company_name: r.body?.company_name || null,
        status,
      };
    },
  },
];

/** One real lookup per provider, printing the raw response, to verify shapes. */
export async function probeEnrichment(record) {
  const domain = domainFor(record);
  const { first, last } = nameParts(record);
  console.log(`PROBE_ENRICH target: ${first} ${last} @ ${domain || '(no domain)'}`);

  for (const provider of PROVIDERS) {
    if (!provider.key?.()) {
      console.log(`PROBE_ENRICH ${provider.name}: no API key set, skipped`);
      continue;
    }
    try {
      const email = await provider.find(record);
      console.log(`PROBE_ENRICH ${provider.name}: ${email ? `FOUND ${email}` : 'no match'}`);
    } catch (err) {
      console.log(`PROBE_ENRICH ${provider.name}: ERROR ${err.message}`);
    }
  }
}

// --- waterfall --------------------------------------------------------------

export async function enrichMissingEmails(records) {
  const warnings = [];
  const providerCounts = {};
  const enriched = [];
  const stillMissing = [];

  const active = activeProviders(warnings);

  if (active.length === 0) {
    warnings.push(
      `${records.length} lead(s) have no email in Allo and no enrichment provider is configured. ` +
        'Set GETLEADS_API_KEY / AI_ARK_API_KEY / LEADMAGIC_API_KEY.'
    );
    return { enriched, stillMissing: records, warnings, providerCounts };
  }

  for (const record of records) {
    let hit = null;
    let via = null;

    for (const provider of active) {
      try {
        hit = await provider.find(record);
      } catch (err) {
        warnings.push(`${provider.name} failed for ${record.call.contact_number}: ${err.message}`);
        continue;
      }
      if (hit) {
        via = provider.name;
        providerCounts[provider.name] = (providerCounts[provider.name] || 0) + 1;
        break; // stop at the first hit -- one lookup per lead, not three
      }
    }

    if (hit) {
      // Providers return richer company data than Allo holds; keep it when
      // Allo has nothing, but never let it override the CRM.
      enriched.push({
        ...record,
        email: typeof hit === 'string' ? hit : hit.email,
        enrichedCompany: typeof hit === 'string' ? null : hit.company_name,
        enrichedBy: via,
        source: 'enriched',
      });
    } else {
      stillMissing.push(record);
    }
  }

  return { enriched, stillMissing, warnings, providerCounts };
}

function activeProviders(warnings) {
  const allowUnverified = /^(1|true|yes)$/i.test(process.env.ENRICH_ALLOW_UNVERIFIED || '');
  const active = [];

  for (const provider of PROVIDERS) {
    if (!provider.key?.()) continue;
    if (!provider.verified && !allowUnverified) {
      warnings.push(
        `${provider.name} has a key but its request shape is unverified — skipping. ` +
          'Run PROBE_ENRICH=1 to check it, then set ENRICH_ALLOW_UNVERIFIED=true.'
      );
      continue;
    }
    active.push(provider);
  }

  return active;
}
