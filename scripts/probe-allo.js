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
  // v2 renamed calls -> conversations, and it authorizes on the current key
  // (it 400s on a missing param, not 403 on scope). If its payload embeds the
  // contact's name/email, CONTACTS_READ stops being needed at all.
  NUMBER && `https://api.withallo.com/v2/api/conversations?allo_number=${n}&page=0&size=3`,
  NUMBER && `https://api.withallo.com/v2/api/conversations?allo_number=${n}&size=3&include=contact`,
  NUMBER && `https://api.withallo.com/v2/api/conversations?allo_number=${n}&size=3&expand=contact`,

  // Other v2 surfaces that may carry contact detail.
  NUMBER && `https://api.withallo.com/v2/api/calls?allo_number=${n}&size=2`,
  NUMBER && `https://api.withallo.com/v2/api/contacts?allo_number=${n}`,
  'https://api.withallo.com/v2/api/me',
  'https://api.withallo.com/v2/api/users',
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
      console.log(`PROBE ${res.status} ${url}\n       ${text.slice(0, 1500).replace(/\s+/g, ' ')}`);
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
