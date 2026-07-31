/**
 * Endpoint probe. Runs inside the deployment, where Allo is reachable, and
 * prints responses so the API surface can be mapped from logs alone.
 *
 * Enable with PROBE_ALLO=1.
 *
 * Allo's 400s are self-documenting -- they name the missing parameter and link
 * the docs -- so POSTing a deliberately incomplete body is a cheap way to learn
 * a schema without access to the documentation site.
 */

const KEY = process.env.ALLO_API_KEY;
const NUMBER = process.env.PROBE_NUMBER || '';
const CONTACT_ID = process.env.PROBE_CONTACT_ID || '';
const CHUNK = 1200;

function logBody(label, text) {
  if (!text) return console.log(`${label} <empty>`);
  const flat = text.replace(/\s+/g, ' ');
  for (let i = 0; i < flat.length && i < CHUNK * 4; i += CHUNK) {
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

  const id = CONTACT_ID || 'con-16F7C063D889A47FEA10409F3267E2C6B6712D2C';

  // Where does CRM_READ expose a person record, and does it carry an email?
  const gets = [
    `https://api.withallo.com/v2/api/crm/people/${id}`,
    `https://api.withallo.com/v2/api/crm/people?page=0&size=2`,
    `https://api.withallo.com/v2/api/crm/contacts/${id}`,
    `https://api.withallo.com/v2/api/crm/people/${id}/notes`,
  ];
  for (const url of gets) {
    const r = await call('GET', url);
    console.log(`PROBE ${r.status} GET ${url}`);
    logBody('  BODY', r.text);
  }

  // Learn the search schema from its own validation errors, then from a result.
  const searches = [
    {},
    { allo_number: NUMBER },
    { allo_number: NUMBER, type: 'CALL', direction: 'OUTBOUND', size: 3 },
    {
      allo_number: NUMBER,
      type: 'CALL',
      direction: 'OUTBOUND',
      start_date: '2026-07-30T04:00:00Z',
      end_date: '2026-07-31T04:00:00Z',
      size: 3,
    },
  ];
  for (const body of searches) {
    const r = await call('POST', 'https://api.withallo.com/v2/api/conversations/items/search', body);
    console.log(`PROBE ${r.status} POST /conversations/items/search ${JSON.stringify(body)}`);
    logBody('  BODY', r.text);
  }

  console.log('PROBE_ALLO: done');
}
