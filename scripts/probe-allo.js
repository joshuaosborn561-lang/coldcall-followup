/**
 * Endpoint probe. Runs inside the deployment, where Allo is reachable, and
 * prints the status + body of a set of candidate URLs so the right base path
 * and contact-lookup endpoint can be identified from logs alone.
 *
 * Enable with PROBE_ALLO=1. Read-only: every request is a GET.
 *
 * Set PROBE_NUMBER to one of your Allo numbers to also exercise the
 * number-scoped endpoints.
 */

const KEY = process.env.ALLO_API_KEY;
const NUMBER = process.env.PROBE_NUMBER || '';

const CANDIDATES = [
  // Controls -- these are known to work, so they anchor what "good" looks like.
  'https://api.withallo.com/v1/api/numbers',
  NUMBER && `https://api.withallo.com/v1/api/calls?allo_number=${encodeURIComponent(NUMBER)}&page=0&size=1`,

  // v1 contact lookups, plural and singular.
  'https://api.withallo.com/v1/api/contacts?page=0&size=1',
  'https://api.withallo.com/v1/api/contact?page=0&size=1',

  // v2 -- the docs the user pointed at are /en/v2/, so the API may have moved.
  'https://api.withallo.com/v2/api/contacts?page=0&size=1',
  'https://api.withallo.com/v2/api/numbers',
  'https://api.withallo.com/v2/contacts?page=0&size=1',
  'https://api.withallo.com/api/v2/contacts?page=0&size=1',

  // Does contact search accept a phone filter? That would remove the need to
  // page the whole contact book.
  NUMBER && `https://api.withallo.com/v1/api/contacts?number=${encodeURIComponent(NUMBER)}`,
  NUMBER && `https://api.withallo.com/v1/api/contacts?search=${encodeURIComponent(NUMBER)}`,
].filter(Boolean);

export async function probeAllo() {
  if (!KEY) {
    console.log('PROBE_ALLO: ALLO_API_KEY not set');
    return;
  }
  console.log(`PROBE_ALLO: ${CANDIDATES.length} candidates (key ends ...${KEY.slice(-6)})`);

  for (const url of CANDIDATES) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: KEY, Accept: 'application/json' },
      });
      const text = await res.text();
      console.log(`PROBE ${res.status} ${url}\n       ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.log(`PROBE ERR ${url}\n       ${err.message}`);
    }
  }

  // Also try the key as a bearer token, in case v2 changed the auth scheme.
  try {
    const res = await fetch('https://api.withallo.com/v1/api/contacts?page=0&size=1', {
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
    });
    const text = await res.text();
    console.log(`PROBE ${res.status} [Bearer prefix] /v1/api/contacts\n       ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`PROBE ERR [Bearer prefix]: ${err.message}`);
  }

  console.log('PROBE_ALLO: done');
}
