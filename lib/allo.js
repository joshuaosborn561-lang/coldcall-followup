/**
 * Allo (withallo.com) REST client.
 *
 * Base:  https://api.withallo.com/v1/api
 * Auth:  Authorization: <api key>   -- raw, NO "Bearer " prefix
 * Pages: page= (0-indexed), size= (max 100), meta at data.metadata.pagination
 *
 * Scopes this file needs on the key: CONVERSATIONS_READ (calls, numbers)
 * and CONTACTS_READ (contacts).
 */

const BASE = process.env.ALLO_API_BASE || 'https://api.withallo.com/v1/api';
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

async function request(path, params = {}, { retries = 3 } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: apiKey(), Accept: 'application/json' },
      });
    } catch (cause) {
      lastError = new AlloError(`Network error calling Allo ${path}: ${cause.message}`, { body: String(cause) });
      await sleep(backoffMs(attempt));
      continue;
    }

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    if (res.ok) return body;

    const code = body?.code || body?.error?.code;

    if (res.status === 429) {
      // Allo returns reset_in / Retry-After on throttle.
      const waitS = Number(res.headers.get('retry-after') || body?.reset_in || 0);
      lastError = new AlloError(`Allo rate limited on ${path}`, { status: 429, code, body });
      if (attempt < retries) {
        await sleep(waitS > 0 ? waitS * 1000 : backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.status === 401) {
      throw new AlloError('Allo rejected the API key (401). Check ALLO_API_KEY.', { status: 401, code, body });
    }
    if (res.status === 403) {
      // details is an array of objects, not strings -- joining it raw prints
      // "[object Object]" and hides the one thing you need to know.
      const details = Array.isArray(body?.details) ? body.details : [];
      const needed = details
        .map((d) => (typeof d === 'string' ? d : d?.scope ?? d?.requiredScope ?? d?.message ?? JSON.stringify(d)))
        .join(', ');
      throw new AlloError(
        `Allo API key is missing a scope for ${path}${needed ? ` (needs: ${needed})` : ''}. ` +
          'Regenerate the key at web.withallo.com/settings/api with CONVERSATIONS_READ and CONTACTS_READ.',
        { status: 403, code, body }
      );
    }
    if (res.status >= 500 && attempt < retries) {
      lastError = new AlloError(`Allo ${res.status} on ${path}`, { status: res.status, code, body });
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new AlloError(`Allo ${res.status} on ${path}: ${text.slice(0, 300)}`, {
      status: res.status,
      code,
      body,
    });
  }

  throw lastError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(8000, 500 * 2 ** attempt);

/** Allo wraps everything in { data: ... }; list endpoints nest under data.results. */
function unwrapList(body) {
  const data = body?.data;
  if (Array.isArray(data)) return { results: data, totalPages: 1 };
  const results = Array.isArray(data?.results) ? data.results : [];
  const pagination = data?.metadata?.pagination ?? data?.metadata ?? {};
  const totalPages = Number(pagination.total_pages ?? pagination.totalPages ?? 1);
  return { results, totalPages: Number.isFinite(totalPages) ? totalPages : 1 };
}

/** All Allo phone numbers on the account. */
export async function listNumbers() {
  const { results } = unwrapList(await request('/numbers'));
  return results;
}

/** One page of call history for an Allo number. */
export async function searchCalls({ alloNumber, contactNumber, page = 0, size = MAX_PAGE_SIZE }) {
  return unwrapList(
    await request('/calls', {
      allo_number: alloNumber,
      contact_number: contactNumber,
      page,
      size: Math.min(size, MAX_PAGE_SIZE),
    })
  );
}

/** One page of contacts. */
export async function searchContacts({ page = 0, size = MAX_PAGE_SIZE } = {}) {
  return unwrapList(await request('/contacts', { page, size: Math.min(size, MAX_PAGE_SIZE) }));
}

/**
 * Calls for one Allo number that started inside [start, end).
 *
 * The /calls endpoint has no date filter, so we page and filter client-side.
 * Results come back newest-first; once a whole page is older than `start` we
 * stop. `maxPages` is the backstop if that ordering assumption ever breaks.
 */
export async function fetchCallsInWindow({ alloNumber, start, end, maxPages = 20 }) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const matched = [];
  let pagesRead = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const { results, totalPages } = await searchCalls({ alloNumber, page });
    pagesRead++;
    if (results.length === 0) break;

    let sawOlderThanWindow = false;
    for (const call of results) {
      const ts = Date.parse(call.start_date);
      if (!Number.isFinite(ts)) continue;
      if (ts >= startMs && ts < endMs) matched.push({ ...call, allo_number: alloNumber });
      else if (ts < startMs) sawOlderThanWindow = true;
    }

    if (page + 1 >= totalPages) break;
    // Every call on this page predates the window -> nothing older can match.
    if (sawOlderThanWindow && !results.some((c) => Date.parse(c.start_date) >= startMs)) break;
    if (page + 1 === maxPages) truncated = true;
  }

  return { calls: matched, pagesRead, truncated };
}

/**
 * Every contact, indexed by phone number. Contacts hold the email addresses;
 * calls only carry phone numbers, so this is the join table.
 */
export async function buildContactIndex({ maxPages = 50 } = {}) {
  const byPhone = new Map();
  let count = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const { results, totalPages } = await searchContacts({ page });
    if (results.length === 0) break;

    for (const contact of results) {
      count++;
      for (const number of contact.numbers || []) {
        for (const key of phoneKeys(number)) {
          if (!byPhone.has(key)) byPhone.set(key, contact);
        }
      }
    }

    if (page + 1 >= totalPages) break;
    if (page + 1 === maxPages) truncated = true;
  }

  return { byPhone, count, truncated };
}

/**
 * Match keys for a phone number. Formatting varies between the call log and
 * the contact record, so index on both E.164 digits and the US 10-digit tail.
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

/** Look up a contact by any formatting of a phone number. */
export function findContact(index, number) {
  for (const key of phoneKeys(number)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}
