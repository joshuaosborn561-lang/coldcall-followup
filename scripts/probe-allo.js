/**
 * Endpoint probe. Runs inside the deployment, where Allo is reachable.
 * Enable with PROBE_ALLO=1.
 *
 * Allo's errors are self-documenting -- a 404 on /crm/people/{id} suggested
 * "Search people with POST /v2/api/crm/people/search", and 400s name the
 * missing parameter -- so probing with deliberately wrong bodies is an
 * effective way to learn a schema without the docs site.
 */

const KEY = process.env.ALLO_API_KEY;
const NUMBER = process.env.PROBE_NUMBER || '+12149107558';
const CONTACT_NUMBER = process.env.PROBE_CONTACT_NUMBER || '+17047056032';
const CHUNK = 1200;

function logBody(label, text) {
  if (!text) return console.log(`${label} <empty>`);
  const flat = text.replace(/\s+/g, ' ');
  for (let i = 0; i < flat.length && i < CHUNK * 3; i += CHUNK) {
    console.log(`${label}[${i / CHUNK}] ${flat.slice(i, i + CHUNK)}`);
  }
}

async function call(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: KEY,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 'ERR', text: err.message };
  }
}

export async function probeAllo() {
  if (!KEY) return console.log('PROBE_ALLO: ALLO_API_KEY not set');

  // The email source. Try several filter spellings; the errors will say which.
  const peopleSearches = [
    {},
    { size: 2 },
    { query: CONTACT_NUMBER },
    { phone: CONTACT_NUMBER },
    { number: CONTACT_NUMBER },
    { phone_number: CONTACT_NUMBER },
    { phones: [CONTACT_NUMBER] },
  ];
  for (const body of peopleSearches) {
    const r = await call('POST', 'https://api.withallo.com/v2/api/crm/people/search', body);
    console.log(`PROBE ${r.status} POST /crm/people/search ${JSON.stringify(body)}`);
    logBody('  BODY', r.text);
  }

  // Does the conversations view carry emails on its inline contacts?
  const conv = await call(
    'GET',
    `https://api.withallo.com/v2/api/conversations?allo_number=${encodeURIComponent(NUMBER)}&size=2`
  );
  console.log(`PROBE ${conv.status} GET /conversations`);
  logBody('  CONV', conv.text);

  // Which date-filter spelling does items/search actually honour? The
  // start_date/end_date pair was silently ignored (total_count unchanged).
  for (const body of [
    { allo_number: NUMBER, date_from: '2026-07-30T04:00:00Z', date_to: '2026-07-31T04:00:00Z', size: 1 },
    { allo_number: NUMBER, from: '2026-07-30T04:00:00Z', to: '2026-07-31T04:00:00Z', size: 1 },
    { allo_number: NUMBER, after: '2026-07-30T04:00:00Z', before: '2026-07-31T04:00:00Z', size: 1 },
    { allo_number: NUMBER, start: '2026-07-30T04:00:00Z', end: '2026-07-31T04:00:00Z', size: 1 },
  ]) {
    const r = await call('POST', 'https://api.withallo.com/v2/api/conversations/items/search', body);
    const m = /"total_count":(\d+)/.exec(r.text);
    console.log(`PROBE ${r.status} dateFilter ${Object.keys(body).join(',')} total_count=${m?.[1] ?? '?'}`);
  }

  console.log('PROBE_ALLO: done');
}
