/**
 * Endpoint auth, opt-in via CRON_SECRET.
 *
 *   CRON_SECRET set   -> every endpoint requires it. Vercel Cron sends it
 *                        automatically as `Authorization: Bearer $CRON_SECRET`;
 *                        manual calls pass it as a bearer token or ?key=.
 *   CRON_SECRET unset -> endpoints are OPEN to anyone with the URL.
 *
 * Open means anyone who guesses the deployment URL can read the day's prospect
 * list via /api/run?dry=1 (names, emails, companies, call summaries) and can
 * trigger a real push into the Smartlead campaign. If you want the endpoints
 * closed without managing a secret, turn on Vercel Deployment Protection —
 * it gates the routes behind your Vercel login and still lets cron through.
 *
 * `open: true` is returned so handlers can surface that state rather than
 * having it be invisible.
 */

import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: true, open: true };

  const header = req.headers?.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = queryParam(req, 'key');

  if (safeEqual(bearer, secret) || safeEqual(query, secret)) return { ok: true, open: false };
  return { ok: false, reason: 'missing or invalid credentials' };
}

export function queryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    const v = req.query[name];
    return Array.isArray(v) ? v[0] : String(v);
  }
  try {
    return new URL(req.url, 'http://localhost').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

export function boolParam(req, name) {
  const v = queryParam(req, name);
  return v !== '' && /^(1|true|yes)$/i.test(v);
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
