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

const n = encodeURIComponent(NUMBER);

const CANDIDATES = [
  // The prize: if a v2 call object embeds the contact (name/email) inline,
  // the whole /contacts lookup -- and CONTACTS_READ -- becomes unnecessary.
  NUMBER && `https://api.withallo.com/v2/api/calls?allo_number=${n}&page=0&size=2`,
  NUMBER && `https://api.withallo.com/v1/api/calls?allo_number=${n}&page=0&size=2`,

  // Where did v2 put contacts? /v2/api/contacts is a 404.
  'https://api.withallo.com/v2/api/people?page=0&size=1',
  'https://api.withallo.com/v2/api/customers?page=0&size=1',
  'https://api.withallo.com/v2/api/conversations?page=0&size=1',
  'https://api.withallo.com/v2/api/messages?page=0&size=1',
  'https://api.withallo.com/v2/api/contact?page=0&size=1',
  'https://api.withallo.com/v2/api/contacts/search?page=0&size=1',

  // Phone-filtered contact search, if one exists.
  NUMBER && `https://api.withallo.com/v2/api/contacts?number=${n}`,
  NUMBER && `https://api.withallo.com/v1/api/contacts?number=${n}`,
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
