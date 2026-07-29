/**
 * Smartlead client.
 *
 * Base: https://server.smartlead.ai/api/v1
 * Auth: ?api_key=... query param (Smartlead does not use a header)
 *
 * Only two operations are needed here: read the campaign (to confirm it exists
 * and is the one we think it is) and push leads into it. Smartlead itself
 * dedupes against the campaign, the global block list and the unsubscribe
 * list, so re-running the job for the same day is safe.
 */

const BASE = process.env.SMARTLEAD_API_BASE || 'https://server.smartlead.ai/api/v1';

// Smartlead accepts up to 400 leads per call; 100 keeps payloads small and
// failures cheap to retry.
const BATCH_SIZE = 100;

export class SmartleadError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SmartleadError';
    this.status = status;
    this.body = body;
  }
}

function apiKey() {
  const key = process.env.SMARTLEAD_API_KEY;
  if (!key) throw new SmartleadError('SMARTLEAD_API_KEY is not set');
  return key;
}

export function campaignId() {
  const id = process.env.SMARTLEAD_CAMPAIGN_ID;
  if (!id) throw new SmartleadError('SMARTLEAD_CAMPAIGN_ID is not set');
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body } = {}, { retries = 3 } = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('api_key', apiKey());

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      lastError = new SmartleadError(`Network error calling Smartlead ${path}: ${cause.message}`);
      await sleep(Math.min(8000, 500 * 2 ** attempt));
      continue;
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    if (res.ok) return parsed;

    if (res.status === 401 || res.status === 403) {
      throw new SmartleadError('Smartlead rejected the API key. Check SMARTLEAD_API_KEY.', {
        status: res.status,
        body: parsed,
      });
    }
    if (res.status === 404) {
      throw new SmartleadError(`Smartlead 404 on ${path}. Check SMARTLEAD_CAMPAIGN_ID.`, {
        status: 404,
        body: parsed,
      });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      lastError = new SmartleadError(`Smartlead ${res.status} on ${path}`, {
        status: res.status,
        body: parsed,
      });
      const waitS = Number(res.headers.get('retry-after') || 0);
      await sleep(waitS > 0 ? waitS * 1000 : Math.min(8000, 500 * 2 ** attempt));
      continue;
    }

    throw new SmartleadError(`Smartlead ${res.status} on ${path}: ${text.slice(0, 300)}`, {
      status: res.status,
      body: parsed,
    });
  }

  throw lastError;
}

/** Campaign metadata -- used by /api/health to prove the key and ID line up. */
export async function getCampaign(id = campaignId()) {
  return request(`/campaigns/${encodeURIComponent(id)}`);
}

/**
 * Push leads into the campaign, batched.
 *
 * Defaults respect the global block list, the unsubscribe list and existing
 * leads in other campaigns. Do not flip these on without a reason -- they are
 * what keeps the job from mailing someone who already opted out.
 */
export async function addLeads(leads, { id = campaignId(), settings = {} } = {}) {
  const merged = {
    ignore_global_block_list: envFlag('SMARTLEAD_IGNORE_BLOCK_LIST', false),
    ignore_unsubscribe_list: envFlag('SMARTLEAD_IGNORE_UNSUBSCRIBE_LIST', false),
    ignore_community_bounce_list: envFlag('SMARTLEAD_IGNORE_BOUNCE_LIST', false),
    ignore_duplicate_leads_in_other_campaign: envFlag('SMARTLEAD_IGNORE_DUPES_IN_OTHER_CAMPAIGNS', false),
    ...settings,
  };

  const totals = { uploaded: 0, duplicates: 0, invalid: 0, unsubscribed: 0, batches: [] };

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const res = await request(`/campaigns/${encodeURIComponent(id)}/leads`, {
      method: 'POST',
      body: { lead_list: batch, settings: merged },
    });

    const uploaded = num(res.upload_count ?? res.uploadedCount ?? res.total_leads);
    const duplicates = num(res.already_added_to_campaign ?? res.duplicateCount);
    const invalid = countOf(res.invalid_emails ?? res.invalidCount);
    const unsubscribed = countOf(res.unsubscribed_leads ?? res.unsubscribedCount);

    totals.uploaded += uploaded;
    totals.duplicates += duplicates;
    totals.invalid += invalid;
    totals.unsubscribed += unsubscribed;
    totals.batches.push({ size: batch.length, uploaded, duplicates, invalid, unsubscribed, raw: res });

    if (res.is_lead_limit_exhausted) {
      totals.leadLimitExhausted = true;
      break;
    }
  }

  return totals;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  return num(v);
}

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes)$/i.test(raw.trim());
}
