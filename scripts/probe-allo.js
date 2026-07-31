/**
 * Endpoint probe. Runs inside the deployment, where Allo is reachable, and
 * prints responses so the API surface can be mapped from logs alone.
 *
 * Enable with PROBE_ALLO=1. Read-only: every request is a GET.
 *
 * /v2/api/me is the useful one -- it returns the key's real scopes plus a
 * catalogue of every endpoint and the scope each requires. That is the
 * authoritative answer to "what is this key allowed to do", and it is what
 * revealed that v1's CONTACTS_READ no longer exists (v2 uses CRM_READ).
 */

const KEY = process.env.ALLO_API_KEY;
const NUMBER = process.env.PROBE_NUMBER || '';
const CHUNK = 1200;

/** Log a long body across several lines so nothing is truncated away. */
function logBody(label, text) {
  if (!text) return console.log(`${label} <empty>`);
  const flat = text.replace(/\s+/g, ' ');
  for (let i = 0; i < flat.length; i += CHUNK) {
    console.log(`${label}[${i / CHUNK}] ${flat.slice(i, i + CHUNK)}`);
  }
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: { Authorization: KEY, Accept: 'application/json' } });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 'ERR', text: err.message };
  }
}

export async function probeAllo() {
  if (!KEY) return console.log('PROBE_ALLO: ALLO_API_KEY not set');

  // The full capability catalogue, in chunks.
  const me = await get('https://api.withallo.com/v2/api/me');
  console.log(`PROBE_ME status=${me.status} length=${me.text.length}`);
  logBody('PROBE_ME', me.text);

  // CRM_READ is granted -- find where v2 exposes contact detail (and emails).
  const n = encodeURIComponent(NUMBER);
  const candidates = [
    'https://api.withallo.com/v2/api/crm/contacts?page=0&size=2',
    'https://api.withallo.com/v2/api/contacts?page=0&size=2',
    NUMBER && `https://api.withallo.com/v2/api/crm/contacts?number=${n}`,
  ].filter(Boolean);

  for (const url of candidates) {
    const r = await get(url);
    console.log(`PROBE ${r.status} ${url}`);
    logBody('  BODY', r.text.slice(0, 1200));
  }

  console.log('PROBE_ALLO: done');
}
