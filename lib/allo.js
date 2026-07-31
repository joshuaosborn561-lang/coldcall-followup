/**
 * Allo v2 REST client.
 *
 * Base:  https://api.withallo.com/v2/api
 * Auth:  Authorization: <api key>   -- raw, NO "Bearer " prefix (Bearer 401s)
 * Pages: 1-INDEXED (page 1 is the first page), {data, pagination:{...}}
 *
 * Built against the live API, not the community v1 SDK -- v1's /contacts wants
 * a CONTACTS_READ scope that no longer exists on current keys. v2's equivalents
 * are covered by CONVERSATIONS_READ, CRM_READ, PHONE_NUMBERS_READ and
 * USERS_READ. GET /v2/api/me returns the key's real scopes and a catalogue of
 * every endpoint -- the fastest way to check what a key can do.
 *
 * Two live quirks this works around:
 *   - items/search ignores date filters (start_date/date_from/from/after all
 *     leave total_count unchanged), so the day window is applied client-side.
 *     Results are newest-first, which makes that cheap.
 *   - crm/people/search ignores phone filters too, so the people index is
 *     built by paging.
 */

const BASE = process.env.ALLO_API_BASE || 'https://api.withallo.com/v2/api';
const MAX_PAGE_SIZE = 100;

export class AlloError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'AlloError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function apiKey() {
  const key = process.env.ALLO_API_KEY;
  if (!key) throw new AlloError('ALLO_API_KEY is not set');
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(8000, 500 * 2 ** attempt);

async function request(path, { method = 'GET', body, params } = {}, { retries = 3 } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: apiKey(),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      lastError = new AlloError(`Network error calling Allo ${path}: ${cause.message}`);
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }

    if (res.ok) return parsed;

    // v2 errors: {error:{type, code, message, suggestion, doc_url}}
    const err = parsed?.error || parsed;
    const code = err?.code;

    if (res.status === 429) {
      const waitS = Number(res.headers.get('retry-after') || err?.reset_in || 0);
      lastError = new AlloError(`Allo rate limited on ${path}`, { status: 429, code, body: parsed });
      if (attempt < retries) {
        await sleep(waitS > 0 ? waitS * 1000 : backoffMs(attempt));
        continue;
      }
      throw lastError;
    }
    if (res.status === 401) {
      throw new AlloError('Allo rejected the API key (401). Check ALLO_API_KEY.', { status: 401, code, body: parsed });
    }
    if (res.status === 403) {
      throw new AlloError(
        `Allo key lacks a scope for ${path}: ${err?.message || code}. ` +
          'GET /v2/api/me lists the scopes the key actually has.',
        { status: 403, code, body: parsed }
      );
    }
    if (res.status >= 500 && attempt < retries) {
      lastError = new AlloError(`Allo ${res.status} on ${path}`, { status: res.status, code, body: parsed });
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new AlloError(
      `Allo ${res.status} on ${path}: ${err?.message || text.slice(0, 300)}` +
        (err?.suggestion ? ` -- ${err.suggestion}` : ''),
      { status: res.status, code, body: parsed }
    );
  }

  throw lastError;
}

/** v2 wraps lists as {data:[...], pagination:{page,size,total_count,total_pages,has_more}}. */
function unwrap(body) {
  const data = body?.data;
  const results = Array.isArray(data) ? data : [];
  const p = body?.pagination || {};
  return {
    results,
    page: Number(p.page ?? 1),
    totalPages: Number(p.total_pages ?? 1),
    totalCount: Number(p.total_count ?? results.length),
    hasMore: Boolean(p.has_more),
  };
}

/** Phone numbers on the account, with the label Allo shows for each. */
export async function listNumbers() {
  const body = await request('/numbers');
  return Array.isArray(body?.data) ? body.data : [];
}

/** Team members -- id, name, email, role. */
export async function listUsers() {
  const body = await request('/users');
  return Array.isArray(body?.data) ? body.data : [];
}

/** One page of calls/SMS. `page` is 1-indexed. */
export async function searchCallItems({ alloNumber, page = 1, size = MAX_PAGE_SIZE } = {}) {
  return unwrap(
    await request('/conversations/items/search', {
      method: 'POST',
      body: {
        ...(alloNumber ? { allo_number: alloNumber } : {}),
        type: 'CALL',
        direction: 'OUTBOUND',
        page,
        size: Math.min(size, MAX_PAGE_SIZE),
      },
    })
  );
}

/**
 * Outbound calls that started inside [start, end).
 *
 * The API ignores every date-filter spelling tried, so filtering is done here.
 * Results are newest-first, so a page entirely older than the window means
 * everything after it is older too.
 */
export async function fetchCallsInWindow({ alloNumber, start, end, maxPages = 20 }) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const matched = [];
  let truncated = false;

  for (let page = 1; page <= maxPages; page++) {
    const { results, totalPages } = await searchCallItems({ alloNumber, page });
    if (results.length === 0) break;

    let anyInOrAfterWindow = false;
    for (const call of results) {
      const ts = Date.parse(call.date);
      if (!Number.isFinite(ts)) continue;
      if (ts >= endMs) anyInOrAfterWindow = true;
      else if (ts >= startMs) {
        anyInOrAfterWindow = true;
        matched.push(call);
      }
    }

    if (page >= totalPages) break;
    if (!anyInOrAfterWindow) break; // whole page predates the window
    if (page === maxPages) truncated = true;
  }

  return { calls: matched, truncated };
}

/** One page of CRM people. `page` is 1-indexed. */
export async function searchPeople({ page = 1, size = MAX_PAGE_SIZE } = {}) {
  return unwrap(
    await request('/crm/people/search', {
      method: 'POST',
      body: { page, size: Math.min(size, MAX_PAGE_SIZE) },
    })
  );
}

/**
 * Phone-number -> person index.
 *
 * crm/people/search ignores phone filters, so this pages the book. Only the
 * numbers actually called need resolving, so pass `wanted` (a Set of phone
 * keys) to stop early once they are all found.
 */
export async function buildPeopleIndex({ maxPages = 60, wanted = null } = {}) {
  const byPhone = new Map();
  let count = 0;
  let truncated = false;
  const remaining = wanted ? new Set(wanted) : null;

  for (let page = 1; page <= maxPages; page++) {
    const { results, totalPages } = await searchPeople({ page });
    if (results.length === 0) break;

    for (const person of results) {
      count++;
      for (const number of person.numbers || []) {
        for (const key of phoneKeys(number)) {
          if (!byPhone.has(key)) byPhone.set(key, person);
          remaining?.delete(key);
        }
      }
    }

    if (remaining && remaining.size === 0) break; // everyone we care about is indexed
    if (page >= totalPages) break;
    if (page === maxPages) truncated = true;
  }

  return { byPhone, count, truncated };
}

/**
 * Match keys for a phone number. Formatting differs between the call log and
 * the CRM, so index on E.164 digits and the US 10-digit tail.
 */
export function phoneKeys(raw) {
  if (!raw) return [];
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return [];
  const keys = new Set([digits]);
  if (digits.length > 10) keys.add(digits.slice(-10));
  if (digits.length === 10) keys.add(`1${digits}`);
  return [...keys];
}

/** Look up a person by any formatting of a phone number. */
export function findPerson(index, number) {
  for (const key of phoneKeys(number)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

/** The key's real scopes and endpoint catalogue -- used by /api/health. */
export async function getCapabilities() {
  const body = await request('/me');
  return body?.data ?? {};
}
